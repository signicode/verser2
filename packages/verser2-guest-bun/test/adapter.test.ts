import { describe, expect, test } from 'bun:test';
import { createVerserBroker, createVerserBunGuest } from '../src/index';
import {
  createNodeStyleHandler,
  dispatchVerserBunRequestInternal,
  streamRequestBody,
} from '../src/lib/adapter';
import type { NodeStyleRequest, NodeStyleResponse } from '../src/lib/adapter';

type StreamEventHandler = (chunk?: unknown) => void;

const supportsRequestBody = (body: unknown): boolean => {
  try {
    new Request('http://local.test', {
      method: 'POST',
      body: body as BodyInit,
      duplex: 'half',
    } as RequestInit);
    return true;
  } catch {
    return false;
  }
};

const supportsResponseBody = (body: unknown): boolean => {
  try {
    const response = new Response(body as BodyInit);
    return response.body !== null;
  } catch {
    return false;
  }
};

const createAsyncIterableBody = (chunks: string[]): AsyncIterable<Uint8Array> => {
  return {
    async *[Symbol.asyncIterator]() {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        yield encoder.encode(chunk);
      }
    },
  };
};

const baseRequest = {
  method: 'GET',
  path: '/',
  origin: 'http://local.test',
  headers: {},
};

describe('createVerserBunGuest API', () => {
  test('attaches a fetch-style handler and returns the guest', () => {
    const guest = createVerserBunGuest({
      hostUrl: 'https://localhost:1',
      guestId: 'bun-adapter-test',
    });

    expect(guest.connected).toBe(false);
    expect(
      guest.attach({
        fetch: () => new Response(),
      }),
    ).toBe(guest);
    expect(guest.attach({ fetch: () => new Response() }, 'custom-domain')).toBe(guest);
  });

  test('supports listener registration and unsubscribe lifecycle handling', async () => {
    const guest = createVerserBunGuest({
      hostUrl: 'https://localhost:1',
      guestId: 'bun-lifecycle-test',
    });
    const events: unknown[] = [];

    const unsubscribe = guest.onLifecycle((event) => {
      events.push(event);
    });

    expect(typeof unsubscribe).toBe('function');
    expect(events).toHaveLength(0);

    await guest.close();

    unsubscribe();
    expect(typeof unsubscribe).toBe('function');
    expect(events).toHaveLength(0);
  });
});

describe('createVerserBunGuest routes API', () => {
  test('accepts routes and fetch handlers through public attach API', () => {
    const guest = createVerserBunGuest({
      hostUrl: 'https://localhost:1',
      guestId: 'bun-route-api-test',
    });

    expect(
      guest.attach({
        routes: {
          '/status': new Response('ok', { status: 200 }),
          '/users/:id': (request) => new Response(request.params.id, { status: 200 }),
          '/items': {
            GET: new Response('read', { status: 200 }),
            POST: () => new Response('create', { status: 201 }),
          },
        },
        fetch: () => new Response('fallback', { status: 404 }),
      }),
    ).toBe(guest);
  });
});

describe('Bun adapter response body consumers', () => {
  test('does not eagerly read Response bodies', async () => {
    const originalText = Response.prototype.text;
    let textCalled = false;
    Response.prototype.text = async function () {
      textCalled = true;
      return originalText.call(this);
    };

    try {
      const response = await dispatchVerserBunRequestInternal(
        {
          fetch: () =>
            new Response('payload', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            }),
        },
        baseRequest,
      );

      expect(textCalled).toBe(false);
      expect(response.body).not.toBeNull();
    } finally {
      Response.prototype.text = originalText;
    }
  });

  test('marks body access as exclusive with text() and json()', async () => {
    const response = await dispatchVerserBunRequestInternal(
      {
        fetch: () => new Response('payload'),
      },
      baseRequest,
    );

    expect(response.body).not.toBeNull();
    await expect(response.text()).rejects.toThrowError(TypeError);
    await expect(response.json()).rejects.toThrowError(TypeError);
  });

  test('marks text/json access as exclusive with body', async () => {
    const response = await dispatchVerserBunRequestInternal(
      {
        fetch: () => new Response('{"value":42}'),
      },
      baseRequest,
    );

    const text = await response.text();
    expect(text).toBe('{"value":42}');
    expect(() => response.body).toThrowError(TypeError);
    await expect(response.json()).resolves.toEqual({ value: 42 });

    const repeatedText = await response.text();
    expect(repeatedText).toBe(text);
  });

  test('supports calling text() then json() against same cached body', async () => {
    const response = await dispatchVerserBunRequestInternal(
      {
        fetch: () => new Response('{"ok":true}'),
      },
      baseRequest,
    );

    await expect(response.text()).resolves.toBe('{"ok":true}');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe('Bun adapter BodyInit request bodies', () => {
  test('supports async-iterable request bodies only when Bun Request accepts them', async () => {
    const supportsAsyncIterableRequestBody = supportsRequestBody(
      createAsyncIterableBody(['alpha', 'beta']),
    );
    const requestBody = createAsyncIterableBody(['alpha', 'beta']) as unknown as BodyInit;
    const responsePromise = dispatchVerserBunRequestInternal(
      {
        fetch: async (request) => {
          const bodyText = await request.text();
          return new Response(bodyText, { status: 200 });
        },
      },
      {
        method: 'POST',
        path: '/async-request-body',
        origin: 'http://local.test',
        headers: {},
        body: requestBody,
      },
    );

    if (supportsAsyncIterableRequestBody) {
      await expect(responsePromise.then((response) => response.text())).resolves.toBe('alphabeta');
      return;
    }

    await expect(responsePromise).rejects.toThrowError(TypeError);
  });
});

describe('Bun adapter BodyInit response bodies', () => {
  test('streams async-iterable responses when supported, otherwise returns handler error', async () => {
    const supportsAsyncIterableResponseBody = supportsResponseBody(
      createAsyncIterableBody(['stream', '-out']),
    );
    const responseChunks: Buffer[] = [];
    const writeHeadCalls: Array<{
      status: number;
      headers?: Record<string, string | number | boolean>;
    }> = [];
    let endChunk: string | Buffer | undefined;
    let done!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      done = resolve;
    });

    const responseWriter = {
      statusCode: 0,
      writeHead(status: number, headers: Record<string, string | number | boolean>) {
        writeHeadCalls.push({ status, headers });
        return undefined;
      },
      write(chunk: string | Buffer) {
        responseChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) {
          responseChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          endChunk = chunk;
        }
        done();
      },
    };

    const nodeHandler = createNodeStyleHandler('stream.test', {
      fetch: async () =>
        new Response(createAsyncIterableBody(['stream', '-out']) as unknown as BodyInit, {
          status: 219,
          headers: {
            'content-type': 'text/plain',
          },
        }),
    });

    nodeHandler(
      {
        method: 'GET',
        url: '/',
        headers: {},
        on() {
          return undefined;
        },
      },
      responseWriter,
    );

    await donePromise;

    if (supportsAsyncIterableResponseBody) {
      expect(writeHeadCalls).toEqual([
        {
          status: 219,
          headers: { 'content-type': 'text/plain' },
        },
      ]);
      expect(
        responseChunks.reduce(
          (combined, chunk) => Buffer.concat([combined, chunk]),
          Buffer.alloc(0),
        ),
      ).toEqual(Buffer.from('stream-out'));
      expect(responseWriter.statusCode).toBe(219);
      expect(endChunk).toBeUndefined();
      return;
    }

    expect(writeHeadCalls).toEqual([
      {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      },
    ]);
    expect(
      responseChunks
        .reduce((combined, chunk) => Buffer.concat([combined, chunk]), Buffer.alloc(0))
        .toString(),
    ).toContain('Bun handler failed');
    expect(typeof endChunk).toBe('string');
  });
});

describe('Bun node-style HTTP adapter streaming contract', () => {
  const streamChunkEncoder = new TextEncoder();

  test('streams webResponse.body to the node response without text()/json() reads', async () => {
    const originalText = Response.prototype.text;
    const originalJson = Response.prototype.json;
    let textCalled = false;
    let jsonCalled = false;

    Response.prototype.text = async function () {
      textCalled = true;
      return originalText.call(this);
    };
    Response.prototype.json = async function () {
      jsonCalled = true;
      return originalJson.call(this);
    };

    try {
      const responseChunks: Buffer[] = [];
      const writeHeadCalls: Array<{
        status: number;
        headers: Record<string, string | number | boolean>;
      }> = [];
      let streamDone!: () => void;
      const streamDonePromise = new Promise<void>((resolve) => {
        streamDone = resolve;
      });

      const responseWriter = {
        statusCode: 0,
        writeHead(status: number, headers: Record<string, string | number | boolean>) {
          writeHeadCalls.push({ status, headers });
          return undefined;
        },
        write(chunk: string | Buffer) {
          responseChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          return true;
        },
        end(chunk?: string | Buffer) {
          if (chunk !== undefined) {
            responseChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          streamDone();
        },
      };

      const webResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(streamChunkEncoder.encode('one'));
            queueMicrotask(() => {
              controller.enqueue(streamChunkEncoder.encode('two'));
              controller.close();
            });
          },
        }),
        {
          status: 219,
          headers: { 'content-type': 'text/plain' },
        },
      );

      const nodeHandler = createNodeStyleHandler('stream.test', {
        fetch: async () => webResponse,
      });

      nodeHandler(
        {
          method: 'GET',
          url: '/',
          headers: {},
          on() {
            return undefined;
          },
        },
        responseWriter,
      );

      await streamDonePromise;

      expect(writeHeadCalls).toHaveLength(1);
      expect(writeHeadCalls[0]).toEqual({
        status: 219,
        headers: { 'content-type': 'text/plain' },
      });
      expect(responseWriter.statusCode).toBe(219);
      expect(textCalled).toBe(false);
      expect(jsonCalled).toBe(false);
      expect(
        responseChunks.reduce(
          (combined, chunk) => Buffer.concat([combined, chunk]),
          Buffer.alloc(0),
        ),
      ).toEqual(Buffer.from('onetwo'));
    } finally {
      Response.prototype.text = originalText;
      Response.prototype.json = originalJson;
    }
  });

  describe('Bun wrapper revokeRoutes exposure', () => {
    test('exposes revokeRoutes as a function on the Bun Guest wrapper', () => {
      const guest = createVerserBunGuest({
        hostUrl: 'https://localhost:1',
        guestId: 'bun-revoke-test',
      });
      expect(typeof guest.revokeRoutes).toBe('function');
    });

    test('revokeRoutes rejects with an error when not connected', async () => {
      const guest = createVerserBunGuest({
        hostUrl: 'https://localhost:1',
        guestId: 'bun-revoke-not-connected',
      });
      await expect(guest.revokeRoutes(['example.com'])).rejects.toThrow();
    });
  });

  describe('Bun wrapper onRouteChange exposure', () => {
    test('exposes onRouteChange as a function on the Broker', () => {
      const broker = createVerserBroker({
        hostUrl: 'https://localhost:1',
        brokerId: 'bun-routechange-test',
      });
      expect(typeof broker.onRouteChange).toBe('function');
    });

    test('onRouteChange returns an unsubscribe function', () => {
      const broker = createVerserBroker({
        hostUrl: 'https://localhost:1',
        brokerId: 'bun-routechange-unsub-test',
      });
      const unsub = broker.onRouteChange(() => {});
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  test('preserves streamed Node request bodies as Bun Request.body for non-GET methods', async () => {
    const handlers: Partial<Record<'data' | 'end', StreamEventHandler[]>> = {};
    const on = (event: 'data' | 'end', handler: StreamEventHandler): void => {
      handlers[event] = handlers[event] ?? [];
      const bucket = handlers[event];
      bucket.push(handler);
    };

    const request = {
      method: 'POST',
      url: '/stream',
      headers: { 'content-type': 'text/plain' },
      on,
    };

    const expectedBody = 'stream-body';
    let observedBody = '';
    let wroteStatus = 0;
    let resolved = false;

    let done!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      done = resolve;
    });

    const responseWriter = {
      statusCode: 0,
      writeHead(status: number) {
        wroteStatus = status;
        return undefined;
      },
      write() {
        return true;
      },
      end() {
        resolved = true;
        done();
      },
    };

    const nodeHandler = createNodeStyleHandler('stream.test', {
      fetch: async (webRequest) => {
        expect(webRequest.body).not.toBeNull();
        if (webRequest.body == null) {
          return new Response('missing-body', { status: 500 });
        }

        const reader = webRequest.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(value);
        }

        observedBody = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
        return new Response(observedBody, { status: 200 });
      },
    });

    nodeHandler(request as never, responseWriter as never);

    await Promise.resolve();
    for (const handler of handlers.data ?? []) {
      handler(Buffer.from('stream-'));
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    for (const handler of handlers.data ?? []) {
      handler(Buffer.from('body'));
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    for (const handler of handlers.end ?? []) {
      handler();
    }

    await donePromise;

    expect(resolved).toBe(true);
    expect(wroteStatus).toBe(200);
    expect(observedBody).toBe(expectedBody);
  });

  test('response writer waits for drain before consuming next Web stream chunk', async () => {
    const streamChunkEncoder = new TextEncoder();
    const receivedChunks: Buffer[] = [];
    let writeCallIndex = 0;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let resolved = false;
    let done!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      done = resolve;
    });

    const responseWriter = {
      statusCode: 0,
      writeHead() {
        return undefined;
      },
      write(chunk: string | Buffer) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        receivedChunks.push(buf);
        writeCallIndex++;
        // Return false on first write to trigger drain wait
        return writeCallIndex !== 1;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) {
          receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        resolved = true;
        done();
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return undefined;
      },
      off(event: string) {
        handlers.delete(event);
        return undefined;
      },
    };

    const nodeHandler = createNodeStyleHandler('drain.test', {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(streamChunkEncoder.encode('first'));
              queueMicrotask(() => {
                controller.enqueue(streamChunkEncoder.encode('second'));
                controller.close();
              });
            },
          }),
          { status: 200 },
        ),
    });

    nodeHandler(
      {
        method: 'GET',
        url: '/',
        headers: {},
        on() {
          return undefined;
        },
      },
      responseWriter as unknown as NodeStyleResponse,
    );

    // Allow first read/write cycle to complete
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    // Only first chunk should have been written (write returned false => drain wait)
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual(Buffer.from('first'));

    // Fire drain to unblock the write loop; second chunk is consumed and written
    const drainHandler = handlers.get('drain');
    drainHandler?.();

    await donePromise;

    expect(resolved).toBe(true);
    expect(receivedChunks).toHaveLength(2);
    expect(receivedChunks[1]).toEqual(Buffer.from('second'));
  });

  test('response writer stops reading after close fires during backpressure wait (no second write)', async () => {
    const streamChunkEncoder = new TextEncoder();
    const receivedChunks: Buffer[] = [];
    let writeCallIndex = 0;
    let endCalled = false;
    const handlers = new Map<string, (...args: unknown[]) => void>();

    const responseWriter = {
      statusCode: 0,
      writeHead() {
        return undefined;
      },
      write(chunk: string | Buffer) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        receivedChunks.push(buf);
        writeCallIndex++;
        // Return false on first write to trigger drain wait
        return writeCallIndex !== 1;
      },
      end(chunk?: string | Buffer) {
        endCalled = true;
        if (chunk !== undefined) {
          receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return undefined;
      },
      off(event: string) {
        handlers.delete(event);
        return undefined;
      },
    };

    const nodeHandler = createNodeStyleHandler('close-before-drain-2.test', {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Two chunks: first triggers backpressure, second must NOT be written
              controller.enqueue(streamChunkEncoder.encode('first'));
              controller.enqueue(streamChunkEncoder.encode('second'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    nodeHandler(
      {
        method: 'GET',
        url: '/',
        headers: {},
        on() {
          return undefined;
        },
      },
      responseWriter as unknown as NodeStyleResponse,
    );

    // Allow first read/write cycle to complete (backpressure wait should be active)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    // Only first chunk should have been written (write returned false => drain wait)
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual(Buffer.from('first'));

    // Fire close instead of drain — writer must stop, no second write
    const closeHandler = handlers.get('close');
    closeHandler?.();
    closeHandler?.(); // idempotent: second call is no-op

    // writeResponseBody returns synchronously in microtask after close resolves.
    // Wait a macrotask so all pending microtasks drain and the IIFE completes.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });

    // end() must NOT have been called (sink was closed externally)
    expect(endCalled).toBe(false);
    // Only the first chunk should ever have been written
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual(Buffer.from('first'));
  });

  test('response writer stops reading after finish fires during backpressure wait (no second write)', async () => {
    const streamChunkEncoder = new TextEncoder();
    const receivedChunks: Buffer[] = [];
    let writeCallIndex = 0;
    let endCalled = false;
    const handlers = new Map<string, (...args: unknown[]) => void>();

    const responseWriter = {
      statusCode: 0,
      writeHead() {
        return undefined;
      },
      write(chunk: string | Buffer) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        receivedChunks.push(buf);
        writeCallIndex++;
        // Return false on first write to trigger drain wait
        return writeCallIndex !== 1;
      },
      end(chunk?: string | Buffer) {
        endCalled = true;
        if (chunk !== undefined) {
          receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return undefined;
      },
      off(event: string) {
        handlers.delete(event);
        return undefined;
      },
    };

    const nodeHandler = createNodeStyleHandler('finish-before-drain.test', {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(streamChunkEncoder.encode('first'));
              controller.enqueue(streamChunkEncoder.encode('second'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    nodeHandler(
      {
        method: 'GET',
        url: '/',
        headers: {},
        on() {
          return undefined;
        },
      },
      responseWriter as unknown as NodeStyleResponse,
    );

    // Allow first read/write cycle to complete (backpressure wait should be active)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    // Only first chunk should have been written (write returned false => drain wait)
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual(Buffer.from('first'));

    // Fire finish instead of drain — writer must stop, no second write
    const finishHandler = handlers.get('finish');
    finishHandler?.();
    finishHandler?.(); // idempotent

    // writeResponseBody returns synchronously in microtask after finish resolves.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(endCalled).toBe(false);
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual(Buffer.from('first'));
  });

  test('request body stream pauses Node source when consumer buffer is full and resumes on pull', async () => {
    const streamChunkEncoder = new TextEncoder();
    let pauseCallCount = 0;
    let resumeCallCount = 0;
    const dataHandlers: Array<(chunk: unknown) => void> = [];
    let endHandler: (() => void) | undefined;

    const mockRequest = {
      method: 'POST',
      url: '/body-backpressure',
      headers: { 'content-type': 'text/plain' },
      on(event: string, handler: (...args: readonly [unknown]) => void) {
        if (event === 'data') {
          dataHandlers.push(handler as (chunk: unknown) => void);
        }
        if (event === 'end') {
          endHandler = handler as () => void;
        }
        return undefined;
      },
      pause() {
        pauseCallCount++;
      },
      resume() {
        resumeCallCount++;
      },
    };

    const bodyStream = streamRequestBody(mockRequest as unknown as NodeStyleRequest);
    const reader = bodyStream.getReader();

    // Fire first data event — should be enqueued, then pause called (desiredSize <= 0)
    dataHandlers[0]?.(streamChunkEncoder.encode('chunk-a'));
    expect(pauseCallCount).toBe(1);

    // Read the first chunk — pull() fires, resume() is called
    const result1 = await reader.read();
    expect(result1.done).toBe(false);
    const value1 = result1.value;
    expect(value1).toBeDefined();
    if (value1 !== undefined) {
      expect(Buffer.from(value1).toString()).toBe('chunk-a');
    }
    expect(resumeCallCount).toBe(1);

    // Fire second data event while consumer buffer has room
    dataHandlers[0]?.(streamChunkEncoder.encode('chunk-b'));

    // Read the second chunk
    const result2 = await reader.read();
    expect(result2.done).toBe(false);
    const value2 = result2.value;
    expect(value2).toBeDefined();
    if (value2 !== undefined) {
      expect(Buffer.from(value2).toString()).toBe('chunk-b');
    }

    // End the stream
    endHandler?.();

    const result3 = await reader.read();
    expect(result3.done).toBe(true);

    // pause() was called again after re-enqueueing if desiredSize <= 0
    expect(pauseCallCount).toBeGreaterThanOrEqual(2);
    reader.releaseLock();
  });

  test('request body stream cancel destroys the Node source and removes specific listeners only', async () => {
    const removedEvents: string[] = [];
    let destroyed = false;

    const mockRequest = {
      method: 'POST',
      url: '/body-cancel',
      headers: {},
      on() {
        return undefined;
      },
      off(event: string) {
        removedEvents.push(event);
        return undefined;
      },
      pause() {},
      resume() {},
      destroy() {
        destroyed = true;
      },
    };

    const bodyStream = streamRequestBody(mockRequest as unknown as NodeStyleRequest);
    const reader = bodyStream.getReader();
    await reader.cancel('test-cancel');

    expect(destroyed).toBe(true);
    // Should have removed data, end, and error listeners only
    expect(removedEvents.sort()).toEqual(['data', 'end', 'error']);
  });
});

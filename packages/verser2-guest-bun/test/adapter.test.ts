import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import {
  MinimalServerResponse,
  NativeVerserWebSocket,
  VerserWebSocket,
} from '@signicode/verser2-guest-node';
import { createVerserBroker, createVerserBunGuest } from '../src/index';
import {
  createBunWebSocketFacade,
  createNodeStyleHandler,
  createNodeStyleWebSocketHandler,
  dispatchVerserBunRequestInternal,
  streamRequestBody,
} from '../src/lib/adapter';
import type { NodeStyleRequest, NodeStyleResponse } from '../src/lib/adapter';

type StreamEventHandler = (chunk?: unknown) => void;

class AdapterRequest extends EventEmitter {
  public destroyed = false;

  public constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super();
  }

  public pause(): void {}

  public resume(): void {}

  public destroy(error?: Error): void {
    this.destroyed = true;
    if (error !== undefined) this.emit('error', error);
    this.emit('close');
  }
}

class AdapterResponse extends EventEmitter {
  public statusCode = 0;

  public finished = false;

  public destroyed = false;

  public readonly chunks: Buffer[] = [];

  public writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  public write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  public end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.finished = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }

  public closePrematurely(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

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
  test('inherits rejected-Promise local Broker header validation and native Fetch ByteString boundaries', async () => {
    const broker = createVerserBroker({
      hostUrl: 'https://localhost:1',
      brokerId: 'bun-local-headers',
    });
    await expect(
      broker.request({ targetId: 'guest', method: 'GET', path: '/', headers: { 'x-emoji': '😀' } }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(() => new Headers({ 'x-emoji': '😀' })).toThrow();
    expect(() => new Response('ok', { headers: { 'x-emoji': '😀' } })).toThrow();
  });

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

describe('createVerserBroker WebSocket API', () => {
  test('exposes Bun and native WebSocket factories with distinct surfaces', () => {
    const broker = createVerserBroker({
      hostUrl: 'https://localhost:1',
      brokerId: 'bun-websocket-api-test',
    });

    expect(typeof broker.webSocket).toBe('function');
    expect(typeof broker.nativeWebSocket).toBe('function');
  });
});

describe('Bun WebSocket backpressure facade', () => {
  test('reports drain only after the real VWS transport drains', async () => {
    const transport = new PassThrough();
    transport.write = (() => false) as typeof transport.write;
    const vws = new VerserWebSocket(transport as never, '', true);
    const native = new NativeVerserWebSocket(vws);
    const socket = createBunWebSocketFacade(native);
    let drains = 0;
    (socket as unknown as { setDrainListener(listener: () => void): void }).setDrainListener(() => {
      drains += 1;
    });

    socket.send('waiting-for-drain');
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    await Promise.resolve();
    expect(drains).toBe(0);

    transport.emit('drain');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.bufferedAmount).toBe(0);
    expect(drains).toBe(1);
    transport.destroy();
  });

  test('returns -1 only while an underlying send is pending and drains on relief', async () => {
    let release!: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = false;
    const transport = {
      readyState: 1,
      protocol: '',
      bufferedAmount: 0,
      send: () => sendPromise,
      close: () => {
        closed = true;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const socket = createBunWebSocketFacade(transport);
    let drains = 0;
    (socket as unknown as { setDrainListener(listener: () => void): void }).setDrainListener(() => {
      drains += 1;
    });

    expect(socket.send('first')).toBe(5);
    expect(socket.send('second')).toBe(-1);
    expect(socket.bufferedAmount).toBe(11);
    expect(drains).toBe(0);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.bufferedAmount).toBe(0);
    expect(drains).toBe(1);
    expect(closed).toBe(false);
  });

  test('awaits rejected async callbacks and closes the transport', async () => {
    let closed = false;
    const transport = {
      readyState: 1,
      protocol: '',
      send: () => Promise.resolve(),
      close: () => {
        closed = true;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const handler = createNodeStyleWebSocketHandler('async-callback.test', {
      fetch: (_request, server) => {
        server.upgrade(_request);
        return undefined;
      },
      websocket: {
        message: async () => {
          throw new Error('async callback failed');
        },
      },
    });

    await handler({ domain: 'async-callback.test', path: '/', protocol: '' }, transport as never);
    (transport.onmessage as unknown as (event: { data: string }) => void)({ data: 'boom' });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(true);
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
  test('forwards native Fetch header failures through a MinimalServerResponse error channel', async () => {
    const response = new MinimalServerResponse();
    const receivedError = new Promise<Error>((resolve) => response.once('error', resolve));
    createNodeStyleHandler('metadata.test', {
      fetch: () => new Response('ok', { headers: { 'x-emoji': '😀' } }),
    })({ method: 'GET', url: '/', headers: {}, on() {} }, response);

    await expect(receivedError).resolves.toBeInstanceOf(TypeError);
    expect(response.headersStarted).toBe(false);
    expect(response.finished).toBe(false);
  });

  test('writes Bun metadata into a real MinimalServerResponse without numeric headers', async () => {
    const dispatch = async (response: Response, requestId: string) => {
      const nodeResponse = new MinimalServerResponse();
      const finished = new Promise<void>((resolve) => nodeResponse.once('finish', resolve));
      createNodeStyleHandler('metadata.test', { fetch: () => response })(
        { method: 'GET', url: '/', headers: {}, on() {} },
        nodeResponse,
      );
      await finished;
      return nodeResponse.toDispatchResponse(requestId);
    };

    const custom = await dispatch(
      new Response('ok', {
        status: 218,
        statusText: 'Bun Status',
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
          ['x-repeat', 'one'],
          ['x-repeat', 'two'],
        ],
      }),
      'bun-custom',
    );
    expect(custom.statusText).toBe('Bun Status');
    expect(custom.headerPairs).toEqual([
      ['x-repeat', 'one, two'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect(custom.headers).toEqual({ 'set-cookie': 'b=2', 'x-repeat': 'one, two' });
    expect(Object.keys(custom.headers)).not.toContain('0');

    const empty = await dispatch(new Response(null, { status: 204 }), 'bun-empty');
    expect(empty.statusText).toBe('');

    const omittedResponse = new MinimalServerResponse();
    omittedResponse.end();
    expect(omittedResponse.toDispatchResponse('bun-omitted').statusText).toBeUndefined();
  });

  test('propagates status text and repeated response header pairs to the Node surface', async () => {
    const calls: Array<unknown[]> = [];
    let ended!: () => void;
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const handler = createNodeStyleHandler('metadata.test', {
      fetch: () =>
        new Response('ok', {
          status: 218,
          statusText: 'Bun Status',
          headers: [
            ['x-repeat', 'one'],
            ['x-repeat', 'two'],
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
          ],
        }),
    });
    handler({ method: 'GET', url: '/', headers: {}, on() {} }, {
      statusCode: 0,
      writeHead(...args: unknown[]) {
        calls.push(args);
      },
      write() {
        return true;
      },
      end() {
        ended();
      },
    } as unknown as NodeStyleResponse);
    await done;
    expect(calls).toEqual([
      [
        218,
        'Bun Status',
        [
          ['x-repeat', 'one, two'],
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      ],
    ]);
  });
  test('reuses static route Responses by cloning each dispatch body', async () => {
    const staticResponse = new Response('reusable-static-body');
    const handler = { routes: { '/static': staticResponse } };

    const first = await dispatchVerserBunRequestInternal(handler, {
      ...baseRequest,
      path: '/static',
    });
    const second = await dispatchVerserBunRequestInternal(handler, {
      ...baseRequest,
      path: '/static',
    });

    await expect(first.text()).resolves.toBe('reusable-static-body');
    await expect(second.text()).resolves.toBe('reusable-static-body');
  });

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
      headers?: unknown;
    }> = [];
    let endChunk: string | Buffer | undefined;
    let done!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      done = resolve;
    });

    const responseWriter = {
      statusCode: 0,
      writeHead(status: number, statusTextOrHeaders: unknown, headers?: unknown) {
        const responseHeaders =
          typeof statusTextOrHeaders === 'string' ? headers : statusTextOrHeaders;
        writeHeadCalls.push({ status, headers: responseHeaders });
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
          headers: [['content-type', 'text/plain']],
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
        headers: unknown;
      }> = [];
      let streamDone!: () => void;
      const streamDonePromise = new Promise<void>((resolve) => {
        streamDone = resolve;
      });

      const responseWriter = {
        statusCode: 0,
        writeHead(status: number, statusTextOrHeaders: unknown, headers?: unknown) {
          const responseHeaders =
            typeof statusTextOrHeaders === 'string' ? headers : statusTextOrHeaders;
          writeHeadCalls.push({ status, headers: responseHeaders });
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
          headers: [['content-type', 'text/plain']],
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
        headers: [['content-type', 'text/plain']],
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
    let sourceCanceled = false;
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
            },
            cancel() {
              sourceCanceled = true;
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
    expect(sourceCanceled).toBe(true);
    // Only the first chunk should ever have been written
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual(Buffer.from('first'));
  });

  test('response writer stops reading after finish fires during backpressure wait (no second write)', async () => {
    const streamChunkEncoder = new TextEncoder();
    const receivedChunks: Buffer[] = [];
    let writeCallIndex = 0;
    let endCalled = false;
    let sourceCanceled = false;
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
            },
            cancel() {
              sourceCanceled = true;
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
    expect(sourceCanceled).toBe(true);
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
    let closeHandler: (() => void) | undefined;

    const mockRequest = {
      method: 'POST',
      url: '/body-cancel',
      headers: {},
      on(event: string, handler: (...args: readonly unknown[]) => void) {
        if (event === 'close') closeHandler = () => handler();
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
        closeHandler?.();
      },
    };

    const bodyStream = streamRequestBody(mockRequest as unknown as NodeStyleRequest);
    const reader = bodyStream.getReader();
    await reader.cancel('test-cancel');

    expect(destroyed).toBe(true);
    // Flow listeners are removed at cancel; the error guard remains until close.
    expect(removedEvents.sort()).toEqual(['close', 'data', 'end', 'error']);
  });

  test('Bun fetch response only pulls a bounded amount while the Web consumer is slow', async () => {
    const broker = createVerserBroker({
      hostUrl: 'https://localhost:1',
      brokerId: 'bun-slow-consumer-test',
    });
    let yielded = 0;
    let destroyed = false;
    const source = Readable.from(
      (async function* () {
        for (let index = 0; index < 64; index++) {
          yielded++;
          yield Buffer.alloc(1024, index);
        }
      })(),
    );
    source.on('close', () => {
      destroyed = true;
    });
    (broker as unknown as { getRoutes: () => unknown }).getRoutes = () => [
      { targetId: 'target', domain: 'slow.test' },
    ];
    (broker as unknown as { request: () => Promise<unknown> }).request = async () => ({
      statusCode: 200,
      headers: {},
      body: source,
    });

    const response = await broker.createFetch()('http://slow.test/data');
    const reader = response.body?.getReader();
    expect(reader).not.toBeNull();
    if (reader === undefined || reader === null) return;

    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(yielded).toBeLessThanOrEqual(2);
    } finally {
      await reader.cancel('slow-consumer');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(destroyed).toBe(true);
  });

  test('Bun fetch sends the selected routeDomain and URL authority as Host', async () => {
    const broker = createVerserBroker({
      hostUrl: 'https://localhost:1',
      brokerId: 'bun-route-domain-test',
    });
    (broker as unknown as { getRoutes: () => unknown }).getRoutes = () => [
      { targetId: 'target', domain: 'route.test' },
    ];
    let captured: Record<string, unknown> | undefined;
    (broker as unknown as { request: (request: unknown) => Promise<unknown> }).request = async (
      request,
    ) => {
      captured = request as Record<string, unknown>;
      return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('ok')]) };
    };
    const response = await broker.createFetch()('http://route.test:8443/path');
    expect(await response.text()).toBe('ok');
    expect(captured?.routeDomain).toBe('route.test');
    expect((captured?.headers as Record<string, string>).host).toBe('route.test:8443');
  });

  test('Bun Broker fetch preserves routed response status text and header pairs', async () => {
    const broker = createVerserBroker({
      hostUrl: 'https://localhost:1',
      brokerId: 'bun-fetch-response-metadata-test',
    });
    (broker as unknown as { getRoutes: () => unknown }).getRoutes = () => [
      { targetId: 'target', domain: 'metadata.test' },
    ];
    (broker as unknown as { request: () => Promise<unknown> }).request = async () => ({
      statusCode: 418,
      statusText: 'Custom Teapot',
      headers: { 'x-legacy': 'wrong' },
      headerPairs: [
        ['set-cookie', 'first=1'],
        ['set-cookie', 'second=2'],
        ['x-repeat', 'one'],
        ['x-repeat', 'two,three'],
        ['x-empty', ''],
      ],
      body: Readable.from([Buffer.from('body')]),
    });

    const response = await broker.createFetch()('http://metadata.test/teapot');
    expect(response.status).toBe(418);
    expect(response.statusText).toBe('Custom Teapot');
    expect(response.headers.get('x-repeat')).toBe('one, two,three');
    expect(response.headers.get('x-empty')).toBe('');
    const setCookies = (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.();
    if (setCookies !== undefined) {
      expect(setCookies).toEqual(['first=1', 'second=2']);
    } else {
      expect(response.headers.get('set-cookie')).toBe('first=1, second=2');
    }
    expect(await response.text()).toBe('body');
  });

  test('accepts Latin-1 response metadata at the Fetch adapter boundary', async () => {
    const broker = createVerserBroker({
      hostUrl: 'https://localhost:1',
      brokerId: 'bun-fetch-latin1-metadata-test',
    });
    (broker as unknown as { getRoutes: () => unknown }).getRoutes = () => [
      { targetId: 'target', domain: 'latin1.test' },
    ];
    (broker as unknown as { request: () => Promise<unknown> }).request = async () => ({
      statusCode: 200,
      statusText: 'Café',
      headers: {},
      headerPairs: [['x-cafe', 'café']],
      body: Readable.from([Buffer.from('ok')]),
    });

    const response = await broker.createFetch()('http://latin1.test/');
    expect(response.statusText).toBe('Café');
    expect(response.headers.get('x-cafe')).toBe('café');
  });

  test('response writer cancels its Web source when the Node sink errors', async () => {
    let sourceCanceled = false;
    let errorHandler: ((error: unknown) => void) | undefined;
    let writeCalls = 0;
    const responseWriter = {
      statusCode: 0,
      writeHead() {},
      write() {
        writeCalls++;
        return false;
      },
      end() {},
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'error') errorHandler = handler;
      },
      off() {},
    };
    let done!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const nodeHandler = createNodeStyleHandler('error.test', {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'));
            },
            cancel() {
              sourceCanceled = true;
              done();
            },
          }),
        ),
    });

    nodeHandler(
      { method: 'GET', url: '/', headers: {}, on() {} },
      responseWriter as unknown as NodeStyleResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writeCalls).toBe(1);
    errorHandler?.(new Error('sink-error'));
    await donePromise;
    expect(sourceCanceled).toBe(true);
  });
});

describe('Bun adapter request cancellation lifecycle', () => {
  test('forwards active fetch and route rejection(undefined) exactly once', async () => {
    for (const mode of ['fetch', 'route'] as const) {
      const response = new AdapterResponse();
      let errorCount = 0;
      const receivedError = new Promise<Error>((resolve) => {
        response.once('error', (error: Error) => {
          errorCount++;
          resolve(error);
        });
      });
      const handler =
        mode === 'fetch'
          ? { fetch: () => Promise.reject(undefined) }
          : { routes: { '/reject': () => Promise.reject(undefined) } };
      createNodeStyleHandler(`undefined-rejection-${mode}.test`, handler as never)(
        new AdapterRequest('GET', '/reject'),
        response,
      );

      const error = await receivedError;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(error.message).toBe('undefined');
      expect(errorCount).toBe(1);
      expect(response.finished).toBe(false);
      expect(response.listenerCount('error')).toBe(0);
    }
  });

  test('observes late rejection(undefined) after request termination without responding', async () => {
    const request = new AdapterRequest('GET', '/late-undefined-rejection');
    const response = new AdapterResponse();
    let rejectHandler!: (reason: unknown) => void;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const nodeHandler = createNodeStyleHandler('late-undefined-rejection.test', {
      fetch: () => {
        resolveEntered();
        return new Promise<Response>((_resolve, reject) => {
          rejectHandler = reject;
        });
      },
    });
    nodeHandler(request, response);
    await entered;
    request.emit('error', new Error('request ended first'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectHandler(undefined);
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

    expect(response.statusCode).toBe(0);
    expect(response.chunks).toHaveLength(0);
    expect(response.finished).toBe(false);
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(request.listenerCount('error')).toBe(0);
  });

  test('streams a long live response with bounded counters and cancels cleanly', async () => {
    const request = new AdapterRequest('GET', '/long-live-stream');
    const response = new AdapterResponse();
    response.write = () => true;
    let writes = 0;
    let canceled = 0;
    let pulled = 0;
    let signal!: AbortSignal;
    let resolveEntered!: () => void;
    let resolveCanceled!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const sourceCanceled = new Promise<void>((resolve) => {
      resolveCanceled = resolve;
    });
    response.write = () => {
      writes++;
      if (writes === 4096) request.emit('error', new Error('stop long stream'));
      return true;
    };
    createNodeStyleHandler('long-live-stream.test', {
      fetch: (webRequest) => {
        signal = webRequest.signal;
        resolveEntered();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array([pulled % 256]));
            },
            cancel() {
              canceled++;
              resolveCanceled();
            },
          }),
        );
      },
    })(request, response);
    await entered;
    await sourceCanceled;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(writes).toBe(4096);
    expect(pulled).toBeLessThanOrEqual(writes + 2);
    expect(canceled).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(response.chunks).toHaveLength(0);
    expect(request.listenerCount('error')).toBe(0);
  });

  test('request error wakes a backpressured writer without a sink event', async () => {
    const request = new AdapterRequest('GET', '/drain-abort');
    const response = new AdapterResponse();
    let signal!: AbortSignal;
    let cancelCount = 0;
    let writeCount = 0;
    let ended = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const originalWrite = response.write.bind(response);
    response.write = (chunk) => {
      writeCount++;
      originalWrite(chunk);
      return false;
    };
    response.end = () => {
      ended = true;
      return response;
    };
    const canceled = new Promise<void>((resolve) => {
      createNodeStyleHandler('drain-abort.test', {
        fetch: (webRequest) => {
          signal = webRequest.signal;
          resolveEntered();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('first'));
                controller.enqueue(new TextEncoder().encode('second'));
              },
              cancel() {
                cancelCount++;
                resolve();
              },
            }),
          );
        },
      })(request, response);
    });
    await entered;
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(writeCount).toBe(1);
    request.emit('error', new Error('request reset while waiting for drain'));
    await canceled;
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(signal.aborted).toBe(true);
    expect(cancelCount).toBe(1);
    expect(writeCount).toBe(1);
    expect(ended).toBe(false);
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(request.listenerCount('error')).toBe(0);
  });

  test('aborts exactly at handler fulfillment without orphaning the response body', async () => {
    const request = new AdapterRequest('GET', '/fulfillment-boundary');
    const response = new AdapterResponse();
    let cancelCount = 0;
    let abortSignal!: AbortSignal;
    let resolveEntered!: () => void;
    let resolveHandler!: (value: Response) => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const handlerResult = new Promise<Response>((resolve) => {
      resolveHandler = resolve;
    });
    const originalThen = Promise.prototype.then;
    let injected = false;
    createNodeStyleHandler('fulfillment-boundary.test', {
      fetch: (webRequest) => {
        abortSignal = webRequest.signal;
        resolveEntered();
        return handlerResult;
      },
    })(request, response);
    await entered;
    // biome-ignore lint/suspicious/noThenProperty: serial adoption-boundary instrumentation
    Promise.prototype.then = function (onFulfilled, onRejected) {
      return originalThen.call(
        this,
        (value: unknown) => {
          const result = onFulfilled?.(value);
          if (
            !injected &&
            typeof value === 'object' &&
            value !== null &&
            'headerPairs' in value &&
            'body' in value
          ) {
            injected = true;
            request.emit('error', new Error('abort at response handoff'));
          }
          return result;
        },
        onRejected,
      );
    } as typeof Promise.prototype.then;
    try {
      resolveHandler(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('owned once'));
            },
            cancel() {
              cancelCount++;
            },
          }),
        ),
      );
      await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    } finally {
      // biome-ignore lint/suspicious/noThenProperty: restore serial test instrumentation
      Promise.prototype.then = originalThen;
    }
    expect(injected).toBe(true);
    expect(abortSignal.aborted).toBe(true);
    expect(cancelCount).toBe(1);
    expect(response.statusCode).toBe(0);
    expect(response.chunks).toHaveLength(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(request.listenerCount('error')).toBe(0);
  });

  test('aborts pending route handlers, observes late rejection, and discards a late Response', async () => {
    const request = new AdapterRequest('GET', '/pending');
    const response = new AdapterResponse();
    let resolveEntered!: () => void;
    let resolveCleanup!: () => void;
    let resolveHandler!: (value: Response) => void;
    let resolveBodyCanceled!: () => void;
    let signal!: AbortSignal;
    let abortEvents = 0;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const handlerCompletion = new Promise<Response>((resolve) => {
      resolveHandler = resolve;
    });
    const bodyCanceled = new Promise<void>((resolve) => {
      resolveBodyCanceled = resolve;
    });
    const nodeHandler = createNodeStyleHandler('pending-bun.test', {
      routes: {
        '/pending': (webRequest) => {
          signal = webRequest.signal;
          signal.addEventListener(
            'abort',
            () => {
              abortEvents += 1;
              resolveCleanup();
            },
            { once: true },
          );
          resolveEntered();
          return handlerCompletion;
        },
      },
    });

    nodeHandler(request, response);
    await entered;
    const transportError = new Error('remote request reset');
    request.emit('error', transportError);
    request.emit('close');
    await cleanup;
    expect(signal.aborted).toBe(true);
    expect(abortEvents).toBe(1);

    resolveHandler(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('late response'));
          },
          cancel() {
            resolveBodyCanceled();
          },
        }),
      ),
    );
    await bodyCanceled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(response.statusCode).toBe(0);
    expect(response.chunks).toHaveLength(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(request.listenerCount('error')).toBe(0);
  });

  test('aborts a streaming response on premature sink close and cancels its producer', async () => {
    const request = new AdapterRequest('GET', '/stream');
    const response = new AdapterResponse();
    let signal!: AbortSignal;
    let abortEvents = 0;
    let resolveEntered!: () => void;
    let resolveFirstWrite!: () => void;
    let resolveSourceCanceled!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const sourceCanceled = new Promise<void>((resolve) => {
      resolveSourceCanceled = resolve;
    });
    const nodeHandler = createNodeStyleHandler('streaming-bun.test', {
      fetch: (webRequest) => {
        signal = webRequest.signal;
        signal.addEventListener('abort', () => {
          abortEvents += 1;
        });
        resolveEntered();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'));
            },
            cancel() {
              resolveSourceCanceled();
            },
          }),
        );
      },
    });
    const originalWrite = response.write.bind(response);
    response.write = (chunk) => {
      const result = originalWrite(chunk);
      resolveFirstWrite();
      return result;
    };

    nodeHandler(request, response);
    await entered;
    await firstWrite;
    response.closePrematurely();
    await sourceCanceled;
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(signal.aborted).toBe(true);
    expect(abortEvents).toBe(1);
    expect(response.finished).toBe(false);
    expect(response.chunks).toHaveLength(1);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
  });

  test('observes a pending handler rejection after response transport error', async () => {
    const request = new AdapterRequest('GET', '/pending-rejection');
    const response = new AdapterResponse();
    let rejectHandler!: (error: Error) => void;
    let resolveEntered!: () => void;
    let signal!: AbortSignal;
    let abortEvents = 0;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const nodeHandler = createNodeStyleHandler('pending-rejection-bun.test', {
      fetch: (webRequest) => {
        signal = webRequest.signal;
        signal.addEventListener('abort', () => {
          abortEvents += 1;
        });
        resolveEntered();
        return new Promise<Response>((_resolve, reject) => {
          rejectHandler = reject;
        });
      },
    });

    nodeHandler(request, response);
    await entered;
    response.emit('error', new Error('remote response stream failed'));
    expect(signal.aborted).toBe(true);
    request.emit('close');
    rejectHandler(new Error('handler rejected after disconnect'));
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

    expect(abortEvents).toBe(1);
    expect(response.statusCode).toBe(0);
    expect(response.chunks).toHaveLength(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(request.listenerCount('error')).toBe(0);
  });

  test('does not abort on GET/HEAD completion or POST upload EOF and normal finish/close', async () => {
    for (const method of ['GET', 'HEAD']) {
      const request = new AdapterRequest(method, '/bodyless');
      const response = new AdapterResponse();
      let signal!: AbortSignal;
      let bodyIsNull = false;
      const finished = new Promise<void>((resolve) => response.once('finish', resolve));
      createNodeStyleHandler('bodyless-bun.test', {
        fetch: (webRequest) => {
          signal = webRequest.signal;
          bodyIsNull = webRequest.body === null;
          return new Response(null, { status: 204 });
        },
      })(request, response);
      await finished;
      expect(bodyIsNull).toBe(true);
      expect(signal.aborted).toBe(false);
      request.emit('close');
      expect(signal.aborted).toBe(false);
    }

    const request = new AdapterRequest('POST', '/upload');
    const response = new AdapterResponse();
    let signal!: AbortSignal;
    let resolveEntered!: () => void;
    let observedBody = '';
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const finished = new Promise<void>((resolve) => response.once('finish', resolve));
    createNodeStyleHandler('upload-bun.test', {
      fetch: async (webRequest) => {
        signal = webRequest.signal;
        resolveEntered();
        observedBody = await webRequest.text();
        return new Response(observedBody);
      },
    })(request, response);
    await entered;
    request.emit('data', new TextEncoder().encode('upload-data'));
    request.emit('end');
    request.emit('close');
    await finished;
    expect(observedBody).toBe('upload-data');
    expect(response.chunks.map((chunk) => chunk.toString()).join('')).toBe('upload-data');
    expect(signal.aborted).toBe(false);
  });
});

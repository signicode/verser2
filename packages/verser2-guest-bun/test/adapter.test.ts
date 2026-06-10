import { describe, expect, test } from 'bun:test';
import { createVerserBunGuest } from '../src/index';
import { createNodeStyleHandler, dispatchVerserBunRequestInternal } from '../src/lib/adapter';

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
});

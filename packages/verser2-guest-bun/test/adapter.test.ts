import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  type VerserBunDispatchRequest,
  __internal,
  createVerserBunGuest,
  dispatchVerserBunRequest,
} from '../src/index';

interface NodeTestRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  on(event: string | symbol, handler: (...args: readonly [unknown]) => void): this;
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

interface NodeTestResponse {
  statusCode: number;
  headers: Record<string, string | number | boolean>;
  body?: string | Buffer;
}

describe('dispatchVerserBunRequest fetch handlers', () => {
  test('forwards Buffer and ReadableStream request bodies into Bun Request APIs', async () => {
    const seen: Array<{ method: string; url: string; body: string; contentType: string | null }> =
      [];

    const response = await dispatchVerserBunRequest(
      {
        fetch: async (request) => {
          const body = await request.text();
          seen.push({
            method: request.method,
            url: request.url,
            body,
            contentType: request.headers.get('content-type'),
          });
          return new Response(body, {
            status: 201,
            headers: { 'x-reply': 'streamed' },
          });
        },
      },
      {
        method: 'POST',
        path: '/binary',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('buffer-body'),
        origin: 'http://bun.local.test',
      },
    );

    expect(seen).toEqual([
      {
        method: 'POST',
        url: 'http://bun.local.test/binary',
        body: 'buffer-body',
        contentType: 'application/octet-stream',
      },
    ]);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('buffer-body');

    const streamed = await dispatchVerserBunRequest(
      {
        fetch: async (request) => {
          return new Response(`streamed:${await request.text()}`);
        },
      },
      {
        method: 'POST',
        path: '/streamed',
        origin: 'http://bun.local.test',
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('hello '));
            controller.enqueue(encoder.encode('streams'));
            controller.close();
          },
        }),
      },
    );

    expect(await streamed.text()).toBe('streamed:hello streams');
  });

  test('forwards Web Response stream and Buffer bodies', async () => {
    const response = await dispatchVerserBunRequest(
      {
        fetch: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode('stream-body'));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/plain; charset=utf-8' } },
          ),
      },
      {
        method: 'GET',
        path: '/resp-stream',
        origin: 'http://bun.local.test',
      },
    );

    expect(response.body).toEqual(Buffer.from('stream-body'));
    expect(await response.text()).toBe('stream-body');

    const binary = await dispatchVerserBunRequest(
      {
        fetch: () => new Response(Buffer.from('byte-stream'), { status: 201 }),
      },
      {
        method: 'GET',
        path: '/resp-buffer',
        origin: 'http://bun.local.test',
      },
    );

    expect(binary.status).toBe(201);
    expect(binary.body).toEqual(Buffer.from('byte-stream'));
  });

  test('passes method, URL, query, headers, and body into a Bun fetch handler', async () => {
    const seen: Array<{
      method: string;
      url: string;
      header: string | null;
      body: string;
    }> = [];

    const response = await dispatchVerserBunRequest(
      {
        fetch: async (request) => {
          seen.push({
            method: request.method,
            url: request.url,
            header: request.headers.get('x-test'),
            body: await request.text(),
          });
          return new Response('created', {
            status: 201,
            headers: { 'x-reply': 'yes' },
          });
        },
      },
      {
        method: 'POST',
        path: '/submit?ok=1',
        headers: { 'x-test': 'present', 'content-type': 'text/plain' },
        body: 'payload',
        origin: 'http://bun.local.test',
      },
    );

    expect(seen).toEqual([
      {
        method: 'POST',
        url: 'http://bun.local.test/submit?ok=1',
        header: 'present',
        body: 'payload',
      },
    ]);
    expect(response.status).toBe(201);
    expect(response.headers['x-reply']).toBe('yes');
    expect(await response.text()).toBe('created');
  });

  test('supports async responses and fetch(req, server)-style handlers', async () => {
    const request: VerserBunDispatchRequest = {
      method: 'GET',
      path: '/server',
      origin: 'http://bun.local.test',
    };

    const response = await dispatchVerserBunRequest(
      {
        fetch: async (_request, server) => Response.json({ upgrade: server.upgrade(_request) }),
      },
      request,
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({ upgrade: false });
  });

  test('explicitly marks websocket upgrade unsupported via server.upgrade() false', async () => {
    const response = await dispatchVerserBunRequest(
      {
        fetch: async (_request, server) => {
          const upgrade = server.upgrade(_request);
          return Response.json({ upgrade, attempted: true }, { status: 500 });
        },
      },
      {
        method: 'GET',
        path: '/ws',
        origin: 'http://bun.local.test',
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ upgrade: false, attempted: true });
  });

  test('fails clearly when a handler does not return a Response', async () => {
    await expect(
      dispatchVerserBunRequest(
        {
          fetch: () => undefined,
        },
        {
          method: 'GET',
          path: '/upgrade',
          origin: 'http://bun.local.test',
        },
      ),
    ).rejects.toThrow(/Response/);
  });

  test('fails clearly when no route or fetch handler is available', async () => {
    await expect(
      dispatchVerserBunRequest(
        {},
        {
          method: 'GET',
          path: '/missing',
          origin: 'http://bun.local.test',
        },
      ),
    ).rejects.toThrow(/No matching route or fetch handler/);
  });
});

describe('dispatchVerserBunRequest routes', () => {
  test('dispatches ordinary method handlers by path and method', async () => {
    const response = await dispatchVerserBunRequest(
      {
        routes: {
          '/items': {
            POST: async (request) =>
              new Response(`created:${await request.text()}`, {
                status: 202,
                headers: { 'x-route': request.headers.get('x-route') ?? '' },
              }),
          },
        },
      },
      {
        method: 'POST',
        path: '/items',
        headers: { 'x-route': 'matched' },
        body: 'abc',
        origin: 'http://bun.local.test',
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers['x-route']).toBe('matched');
    expect(await response.text()).toBe('created:abc');
  });

  test('returns 404 for missing routes and 405 for unsupported methods', async () => {
    const handler = {
      routes: {
        '/items': {
          GET: () => new Response('items'),
        },
      },
    };

    const missing = await dispatchVerserBunRequest(handler, {
      method: 'GET',
      path: '/missing',
      origin: 'http://bun.local.test',
    });
    const unsupported = await dispatchVerserBunRequest(handler, {
      method: 'POST',
      path: '/items',
      origin: 'http://bun.local.test',
    });

    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('No Bun route matched');
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.allow).toBe('GET');
  });

  test('supports static Response routes and function routes', async () => {
    const staticResponse = await dispatchVerserBunRequest(
      {
        routes: {
          '/static': new Response('static'),
        },
      },
      {
        method: 'GET',
        path: '/static',
        origin: 'http://bun.local.test',
      },
    );
    const functionResponse = await dispatchVerserBunRequest(
      {
        routes: {
          '/function': (request) => new Response(request.url),
        },
      },
      {
        method: 'GET',
        path: '/function',
        origin: 'http://bun.local.test',
      },
    );

    expect(await staticResponse.text()).toBe('static');
    expect(await functionResponse.text()).toBe('http://bun.local.test/function');
  });
});

describe('Bun adapter Node-style bridge interop', () => {
  test('forwards Buffer chunks from node EventEmitter request streams', async () => {
    const request = new EventEmitter() as unknown as NodeTestRequest;
    request.method = 'POST';
    request.url = '/node-events';
    request.headers = { 'content-type': 'text/plain' };

    const captured: { body: string } = { body: '' };
    const responsePromise = new Promise<NodeTestResponse>((resolve) => {
      const response: NodeTestResponse = {
        statusCode: 0,
        headers: {},
      };
      const onFinish = (chunk?: string | Buffer): void => {
        response.body = chunk;
        resolve(response);
      };

      __internal.createNodeStyleHandler('bun.local.test', {
        fetch: async (r) => {
          captured.body = await r.text();
          return new Response('from-node-event');
        },
      })(request, {
        statusCode: response.statusCode,
        writeHead: (statusCode, headers) => {
          response.statusCode = statusCode;
          if (headers !== undefined) {
            for (const [name, value] of Object.entries(headers)) {
              response.headers[name] = value;
            }
          }
        },
        end: onFinish,
      });

      queueMicrotask(() => {
        request.emit('data', Buffer.from('node-'));
        request.emit('data', new Uint8Array([98, 117, 102, 102, 101, 114]));
        request.emit('end');
      });
    });

    const response = await responsePromise;
    expect(captured.body).toBe('node-buffer');
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(Buffer.from('from-node-event'));
  });

  test('supports Node Readable streams via EventEmitter-backed chunks', async () => {
    const request = new EventEmitter() as unknown as NodeTestRequest;
    request.method = 'POST';
    request.url = '/node-readable';
    request.headers = {};

    const stream = Readable.from([
      Buffer.from('part-'),
      Buffer.from('one-'),
      Buffer.from('stream'),
    ]);
    const sourceChunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        sourceChunks.push(Buffer.from(chunk));
      });
      stream.on('end', () => resolve());
    });

    const responseBody = await new Promise<string>((resolve) => {
      const response: NodeTestResponse = { statusCode: 0, headers: {} };

      __internal.createNodeStyleHandler('bun.local.test', {
        fetch: async (r) => {
          const body = await r.text();
          return new Response(body);
        },
      })(request, {
        statusCode: response.statusCode,
        writeHead: (statusCode, headers) => {
          response.statusCode = statusCode;
          if (headers !== undefined) {
            for (const [name, value] of Object.entries(headers)) {
              response.headers[name] = value;
            }
          }
        },
        end: (chunk) => {
          resolve(typeof chunk === 'undefined' ? '' : String(chunk));
        },
      });

      queueMicrotask(() => {
        for (const chunk of sourceChunks) {
          request.emit('data', chunk);
        }
        request.emit('end');
      });
    });

    expect(responseBody).toBe('part-one-stream');
  });

  test('handles stream-like request body inputs from Bun dispatch directly', async () => {
    const response = await dispatchVerserBunRequest(
      {
        fetch: async (request) => {
          const body = await request.text();
          return Response.json({ echoed: body });
        },
      },
      {
        method: 'POST',
        path: '/node-readable-indirect',
        origin: 'http://bun.local.test',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('streamed-dispatch'));
            controller.close();
          },
        }),
      },
    );

    expect(await response.json()).toEqual({ echoed: 'streamed-dispatch' });
  });
});

describe('createVerserBunGuest lifecycle wiring', () => {
  test('tracks listener registration and unsubscription', async () => {
    const guest = createVerserBunGuest({
      hostUrl: 'https://localhost:1',
      guestId: 'bun-adapter-test',
    });
    const events: unknown[] = [];
    const unsubscribe = guest.onLifecycle((event) => events.push(event));

    expect(guest.connected).toBe(false);
    expect(guest.attach({ origin: 'http://bun.local.test', fetch: () => new Response() })).toBe(
      guest,
    );
    expect(events.length).toBe(0);

    unsubscribe();
    expect(typeof unsubscribe).toBe('function');
  });
});

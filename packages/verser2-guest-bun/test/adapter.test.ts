import { describe, expect, test } from 'bun:test';
import {
  type VerserBunDispatchRequest,
  createVerserBunGuest,
  dispatchVerserBunRequest,
} from '../src/index';

describe('dispatchVerserBunRequest fetch handlers', () => {
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

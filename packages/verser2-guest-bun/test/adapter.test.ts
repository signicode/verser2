import { describe, expect, test } from 'bun:test';
import { createVerserBunGuest } from '../src/index';

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

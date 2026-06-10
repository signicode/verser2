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

# @signicode/verser2-guest-bun

Bun Guest package and Bun-facing Broker wrapper for verser2. Reuses the
`@signicode/verser2-guest-node` transport for Host connection, route
advertisement, Broker requests, and lease lifecycle while adapting local
handlers to Bun/Fetch-style handler semantics.

## Public API

- `VERSER2_GUEST_BUN_PACKAGE_NAME`
- `createVerserBunGuest(options)` — create a Bun Guest
- `createVerserBroker(options)` — create a Bun-facing Broker wrapper
- Types: Guest/Broker options, request/response, lifecycle, route/handler types

## Basic usage

Unlike a normal Bun server, a Bun Guest does **not** call `Bun.serve()` or
`listen()` for this routing path.

```ts
import { createVerserBunGuest } from '@signicode/verser2-guest-bun';

const guest = createVerserBunGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'bun-client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

guest.attach({
  fetch(request) {
    if (request.method === 'GET' && request.url.endsWith('/health')) {
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
}, 'bun-client-a.local.test');

await guest.connect();
```

## Broker usage

The Bun package exports `createVerserBroker` wired to the same Node transport:

```ts
import { createVerserBroker } from '@signicode/verser2-guest-bun';
import http from 'node:http';

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

const agent = broker.createAgent();
const dispatcher = broker.createDispatcher();
const routedFetch = broker.createFetch();

await broker.connect();
await broker.waitForRoute('bun-client-a.local.test');

http.get('http://bun-client-a.local.test/health', { agent }, (res) => res.resume());
await routedFetch('http://bun-client-a.local.test/health');
await fetch('http://bun-client-a.local.test/health', { dispatcher });
```

## Local route dispatch

The handler object can include a `routes` table for local path matching. This is
local dispatch only and does not affect Host route advertisements.

```ts
guest.attach({
  routes: {
    '/health': new Response('ok', { status: 200 }),
    '/users/:id': (request) => new Response(request.params.id),
    '/files/*': () => new Response('wildcard', { status: 200 }),
    '/items': {
      GET: new Response('read', { status: 200 }),
      POST: () => new Response('created', { status: 201 }),
    },
  },
  fetch: (request) => new Response('fallback', { status: 404 }),
}, 'bun-client-a.local.test');
```

Matching precedence: exact path → `:param` routes → `*` wildcard → `fetch`
fallback.

## Caveats

- The Bun Guest uses the same transport as the Node Guest; route advertisement,
  lifecycle events, close behavior, and lease management are consistent.
- WebSocket upgrade forwarding is **not** implemented — `server.upgrade(request)`
  returns `false`.
- Direct Broker request bodies use the Node Broker surface: omit the body, pass
  `Buffer` chunks, or stream with a Node `Readable`. Fetch-style request bodies
  are available through `createFetch()` / `createDispatcher()`.
- Bun Guest handler responses are Web `Response` objects; Broker responses follow
  the Node Broker response stream surface.
- When no domain is supplied to `attach()`, the Guest ID is used as the route
  domain.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Exposing HTTP](../../docs/exposing-http.md)
- [Docs: Routes](../../docs/routes.md)

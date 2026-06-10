# @signicode/verser2-guest-bun

This package implements the Bun Guest path for `verser2`. It reuses the existing
`@signicode/verser2-guest-node` transport for Host connection, route
advertisement, and lease lifecycle, while adapting local handlers to Bun/Fetch
style handler semantics.

## Public API

- `VERSER2_GUEST_BUN_PACKAGE_NAME`
- `createVerserBunGuest(options)`
- `createVerserBroker(options)`


## Bun Guest usage

Unlike a normal Bun server, a Bun Guest does **not** call `Bun.serve()` or
`listen()` for this routing path.

```ts
import { VERSER2_GUEST_BUN_PACKAGE_NAME, createVerserBunGuest } from '@signicode/verser2-guest-bun';

const guest = createVerserBunGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'bun-client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

guest.attach({
  fetch(request, server) {
    if (request.method === 'GET' && request.url.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (request.url.endsWith('/ws-check')) {
      return Response.json({ upgraded: server.upgrade(request) });
    }

    return new Response('not found', { status: 404 });
  },
}, 'bun-client-a.local.test');

await guest.connect();
console.log(VERSER2_GUEST_BUN_PACKAGE_NAME);
```

Send traffic through a standard Broker API:

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

http.get('http://bun-client-a.local.test/health', { agent }, (response) => response.resume());
await routedFetch('http://bun-client-a.local.test/health');
await fetch('http://bun-client-a.local.test/health', { dispatcher });
```

To detach from the Host:

```ts
await guest.close();
```

### Route handler examples

`createVerserBunGuest()` attaches a Bun handler object with a normal `fetch`
entrypoint.

```ts
guest.attach({
  fetch(request, server) {
    if (request.method === 'GET' && request.url.endsWith('/health')) {
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false }, { status: 404 });
  },
}, 'bun-client-a.local.test');
```

### Bun-style `routes` contract (local dispatch)

`attach()` also accepts a local `routes` map following Bun-style matching. This
is only local dispatch on the attached Bun handler and does not affect host route
advertisement.

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

Matching precedence is exact path, then parameter (`:id`) routes, then wildcard
(`*`). `fetch(request, server)` is only used when no route entry matches the path.

## Fetch and response semantics

- Incoming `body` inputs are accepted as strings, `Buffer`, and Web
  `ReadableStream` values.
- Incoming `method`, `path`, `query string`, and `headers` are preserved in the
  generated Bun `Request`.
- Outgoing `Response` bodies remain available through standard `Response` stream
  access plus `text()`/`json()` helpers.

## Node compatibility and boundary notes

The Bun package uses the same transport helpers as the Node Guest path so route
advertisement, lifecycle events, close behavior, and lease management remain
consistent with the rest of `verser2`.

The adapter is specifically a Bun/Fetch shim; it does not add a built-in Bun
`Bun.serve()` wrapper in-package and does not require that your code actually
start a listening server.

### Streaming behavior

- Request bodies stream into a Web `Request` where supported by Bun.
- Response helper methods keep text/JSON ergonomics while still returning binary
  data through `body` when a response body is not directly text-oriented.
- Streaming behavior follows the established routing path behavior and does not rely
  on permanent adapter buffering.

### WebSocket limitation

WebSocket upgrade forwarding is not implemented for this track.

`server.upgrade(request)` intentionally returns `false` for Bun-style handlers,
so upgrade-oriented handlers can detect and handle the limitation explicitly.

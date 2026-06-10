# @signicode/verser2-guest-bun

This package implements the Bun Guest path for `verser2`. It reuses the existing
`@signicode/verser2-guest-node` transport for Host connection, route
advertisement, and lease lifecycle, while adapting local handlers to Bun/Fetch
style handler semantics.

## Public API

- `VERSER2_GUEST_BUN_PACKAGE_NAME`
- `createVerserBunGuest(options)`
- `dispatchVerserBunRequest(handler, request)`

## Bun Guest usage

Unlike a normal Bun server, a Bun Guest does **not** call `Bun.serve()` without a
port or `listen()` for this routing path.

```ts
import { createVerserBunGuest } from '@signicode/verser2-guest-bun';

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
});

await guest.connect();
```

Then send traffic through an existing Broker as you would with any other guest
domain:

```ts
const response = await fetch('http://bun-client-a.local.test/health', {
  method: 'GET',
  headers: { 'accept': 'application/json' },
  dispatcher: broker.createDispatcher(),
});

console.log(response.status);
```

To detach from the Host:

```ts
await guest.close();
```

### Route handler examples

`dispatchVerserBunRequest` and `attach()` support Bun-style route tables.

```ts
import { dispatchVerserBunRequest } from '@signicode/verser2-guest-bun';

const routeTable = {
  '/health': new Response('ok'),
  '/upload': {
    POST: async (request) => {
      const payload = await request.text();
      return Response.json({ uploaded: payload.length });
    },
    GET: () => new Response('method required', { status: 405 }),
  },
  '/items': (request) => new Response(`items ${request.url}`),
};

const routeResponse = await dispatchVerserBunRequest(
  { routes: routeTable },
  {
    method: 'POST',
    path: '/upload',
    origin: 'http://bun-client-a.local.test',
    body: 'hello',
    headers: { 'content-type': 'text/plain' },
  },
);

console.log(routeResponse.status, await routeResponse.text());
```

## Fetch and response semantics

- Incoming `body` inputs are accepted as strings, `Buffer`, and Web
  `ReadableStream` values.
- Incoming `method`, `path`, `query string`, and `headers` are preserved in the
  generated Bun `Request`.
- Outgoing `Response` bodies are materialized as a `Buffer`, while helpers still
  expose `text()` and `json()` for common use.
- Route dispatch supports:
  - exact-path `routes[path] = Response`
  - exact-path function handler `routes[path] = (request) => Response`
  - per-method handlers `routes[path] = { GET, POST, ... }`
- Unsupported route/method pairs return `404`/`405` with the expected `Allow`
  header.

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
- Streaming behavior follows the current adapter limits in this package; large
  responses are currently materialized in memory during response conversion.

### WebSocket limitation

WebSocket upgrade forwarding is not implemented for this track.

`server.upgrade(request)` intentionally returns `false` for Bun-style handlers,
so upgrade-oriented handlers can detect and handle the limitation explicitly.

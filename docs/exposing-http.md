# Exposing HTTP handlers

A Guest attaches a local HTTP handler to a verser Host. The handler never needs
to call `listen()` — it receives requests dispatched through the Host route
path. Remote Guests receive requests over the TLS HTTP/2 connection; local Host
Guests use `host.attachLocalGuest()` in the same process without a separate
Guest connection.

## Node Guest

Attach an `http.Server` or a listener function:

```ts
import http from 'node:http';
import { createVerserNodeGuest } from '@signicode/verser2-guest-node';

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Handled ${req.method} ${req.url}`);
});

guest.attach(server, 'client-a.local.test');
await guest.connect();
```

**Domain defaulting:** When no domain is supplied to `attach()`, the Guest ID is
used as the route domain.

```ts
guest.attach(server);  // routes match guestId 'client-a'
```

**Handler differences:** Local handlers receive minimal HTTP/1-style request and
response objects. The following are outside the supported surface:

- HTTP upgrade / WebSocket forwarding
- CONNECT tunneling
- Trailers and informational (1xx) responses
- Full `IncomingMessage` / `ServerResponse` socket internals

### Local Host-side Node Guest

The Host package can attach the same listener shape directly through
`attachLocalGuest()`. The listener type is `VerserLocalGuestRequestListener`, or
you may pass an `http.Server` without calling `listen()`:

```ts
import http from 'node:http';
import { createVerserHost } from '@signicode/verser2-host';

const host = createVerserHost({
  tls: { certFile: '/etc/verser/host.crt', keyFile: '/etc/verser/host.key' },
});

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`Handled ${request.method} ${request.url}`);
});

const localGuest = await host.attachLocalGuest({
  guestId: 'local-node-guest',
  routedDomains: ['local-node-guest.local.test'],
  listener: server,
});
```

## Bun Guest

Attach a Bun-style handler object with `fetch` and/or `routes`:

```ts
import { createVerserBunGuest } from '@signicode/verser2-guest-bun';

const bunGuest = createVerserBunGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'bun-client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

bunGuest.attach({
  fetch(request, server) {
    if (request.url.endsWith('/health')) {
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
}, 'bun-client-a.local.test');

await bunGuest.connect();
```

**Domain defaulting:** Same as Node Guest — omitting the domain defaults to the
Guest ID.

**Local route dispatch:** The handler object can include a `routes` table for
local path matching (exact paths, `:param` segments, `*` wildcards, and method
maps). This is local dispatch only and does not affect Host route advertisements:

```ts
bunGuest.attach({
  routes: {
    '/health': new Response('ok'),
    '/users/:id': (request) => Response.json({ id: request.params.id }),
    '/items': {
      GET: new Response('list'),
      POST: () => new Response('created', { status: 201 }),
    },
  },
  fetch: (request) => new Response('fallback', { status: 404 }),
});
```

**WebSocket limitation:** `server.upgrade(request)` returns `false` — WebSocket
upgrade is not forwarded.

## Python Guest

Attach an ASGI 3 application:

```py
from verser2_guest_python import create_verser_guest


async def app(scope, receive, send):
    body = b""
    while True:
        event = await receive()
        body += event.get("body", b"")
        if not event.get("more_body", False):
            break
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/plain")],
    })
    await send({"type": "http.response.body", "body": b"Handled " + body})


guest = create_verser_guest(
    host_url="https://localhost:8443",
    guest_id="python-client-a",
    app=app,
    routed_domains=["python-client-a.local.test"],
    tls_ca_file="/etc/verser/ca.crt",
    # For mTLS Hosts:
    # tls_cert_file="/etc/verser/client.crt",
    # tls_key_file="/etc/verser/client.key",
    # tls_pfx_file="/etc/verser/client.p12",
    # tls_pfx_password="...",
)
await guest.connect()
```

**Domain defaulting:** Unlike Node and Bun Guests, the Python Guest does **not**
default the route domain to the Guest ID. You must provide `routed_domains`
explicitly.

**FastAPI compatibility:** FastAPI and Starlette apps work because the Guest
calls the standard ASGI 3 interface. FastAPI is not a runtime dependency of the
package.

```py
from fastapi import FastAPI
from verser2_guest_python import create_verser_guest

app = FastAPI()

@app.get("/health")
async def health():
    return {"ok": True}

guest = create_verser_guest(
    host_url="https://localhost:8443",
    guest_id="fastapi-guest",
    app=app,
    routed_domains=["fastapi-guest.local.test"],
    tls_ca_file="/etc/verser/ca.crt",
)
```

## Route revocation

Guests can revoke advertised routes without disconnecting. The revocation
sends a request to the Host's dedicated `/verser/guest/revoke` path.

### Node Guest

```ts
const result = await guest.revokeRoutes(['client-a.local.test', 'extra.example.com']);
// result.status === 'ack'     (all revoked)
// result.status === 'partial' (some failed, check result.failedDomains)
// result.status === 'error'   (entire request rejected)
```

### Bun Guest

```ts
const result = await bunGuest.revokeRoutes(['bun-client-a.local.test']);
```

The Bun wrapper delegates to the same Node Guest revocation path.

### Python Guest

```py
result = await guest.revoke_routes(["python-guest-a.local.test"])
# result["status"] == "ack" | "partial" | "error"
```

### Local Host-side Guest

The local Guest handle returned by `host.attachLocalGuest()` provides
`revokeRoutes()` as a synchronous operation:

```ts
const { revoked, notFound } = localGuest.revokeRoutes(['local-node-guest.local.test']);
```

The Host emits lifecycle events for revoked routes so connected Brokers
receive timely updates. See [Routes](./routes.md) and
[Lifecycle and errors](./lifecycle-and-errors.md).

## Streaming

All Guest runtimes support streaming request and response bodies through the
Host routing path:

- Node/Bun/H2: request bodies can be `Readable` streams or web `ReadableStream`.
  Response bodies are available as `Readable` streams.
- Local Host Guests: request and response bodies stream through the in-process
  bridge; there is no mandatory full-body buffering.
- Python: ASGI `http.request` events deliver body chunks with `more_body` flags.
  ASGI `http.response.body` events stream back through the lease.

Direct `dispatchRoutedRequest()` calls (Node and Python) are batch-only — they
buffer the full response and enforce `maxResponseBytes`. Use leased routing for
streaming.

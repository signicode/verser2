# Example: tiny Bun gateway to Node and Python Guests

This example shows a small public HTTP gateway built **by your application**.
`verser2` supplies the Broker routing client; it does not open the public HTTP
listener, choose gateway policy, authenticate callers, rate-limit requests, or
own observability.

The topology:

```txt
public clients
    │ HTTP
    ▼
Bun gateway container
    │ uses Broker createFetch()
    ▼
Verser Host
    │ exact hostname routes
    ├── Node Guest:   node-api.internal
    └── Python Guest: python-api.internal
```

## Host container

```ts
import { createVerserHost } from '@signicode/verser2-host';

const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
  },
});

await host.start();
```

## Node service container

The Node service attaches a local HTTP handler and connects outbound. It does
not call `listen()` for the service route.

```ts
import http from 'node:http';
import { createVerserNodeGuest } from '@signicode/verser2-guest-node';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'node', ok: true }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const guest = createVerserNodeGuest({
  hostUrl: 'https://verser-host:8443',
  guestId: 'node-api',
  tls: { caFile: '/etc/verser/ca.crt' },
});

guest.attach(server, 'node-api.internal');
await guest.connect();
```

## Python service container

The Python service attaches an ASGI app and connects outbound. Python Guests
currently support Host CA trust, but not client certificate identity. If your
Host requires mTLS client certificates for Guests, use Node/Bun Guests today or
add Python Guest client identity support in a future implementation track.

```py
from verser2_guest_python import create_verser_guest


async def app(scope, receive, send):
    path = scope.get("path", "/")
    if path == "/health":
        body = b'{"service":"python","ok":true}'
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": body})
        return

    await send({"type": "http.response.start", "status": 404, "headers": []})
    await send({"type": "http.response.body", "body": b"not found"})


guest = create_verser_guest(
    host_url="https://verser-host:8443",
    guest_id="python-api",
    app=app,
    routed_domains=["python-api.internal"],
    tls_ca_file="/etc/verser/ca.crt",
)

await guest.connect()
```

## Bun gateway container

The gateway owns the public listener. It connects a Broker outbound to the Host,
waits for the private service routes, then forwards public paths through a
Broker-backed fetch helper.

```ts
import { createVerserBroker } from '@signicode/verser2-guest-bun';

const broker = createVerserBroker({
  hostUrl: 'https://verser-host:8443',
  brokerId: 'public-gateway',
  tls: { caFile: '/etc/verser/ca.crt' },
});

await broker.connect();
await broker.waitForRoute('node-api.internal');
await broker.waitForRoute('python-api.internal');

const routedFetch = broker.createFetch();

Bun.serve({
  port: 8080,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/node/')) {
      return routedFetch(toInternalUrl(request, 'node-api.internal', '/node'));
    }

    if (url.pathname.startsWith('/python/')) {
      return routedFetch(toInternalUrl(request, 'python-api.internal', '/python'));
    }

    return Response.json({ error: 'route not found' }, { status: 404 });
  },
});

function toInternalUrl(request: Request, hostname: string, publicPrefix: string): Request {
  const source = new URL(request.url);
  const targetPath = source.pathname.slice(publicPrefix.length) || '/';
  const target = new URL(`http://${hostname}${targetPath}${source.search}`);

  return new Request(target, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // Required by Fetch implementations for streamed request bodies.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}
```

Public requests now map like this:

| Public request | Internal routed request |
|---|---|
| `GET /node/health` | `GET http://node-api.internal/health` |
| `GET /python/health` | `GET http://python-api.internal/health` |

## Gateway responsibilities

Add these at the application boundary as needed:

- public TLS termination and HTTP listener configuration;
- request authentication and session/token validation;
- per-route authorization;
- rate limiting and request size limits;
- access logs, metrics, tracing, and audit events;
- fallback behavior when `broker.waitForRoute()` has not observed a route;
- deployment topology for one or more Hosts. Route state is per Host instance.

Future `verser2` tracks may add gateway helpers, per-request Broker target
authorization, and Host HA/shared route-state patterns.

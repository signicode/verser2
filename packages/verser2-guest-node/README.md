# @signicode/verser2-guest-node

Node Guest and Broker package for verser2. Connects outbound to a verser2 Host
over TLS HTTP/2 and provides request routing without opening inbound ports.

## Public API

- `createVerserNodeGuest(options)` — create a Node Guest
- `createVerserBroker(options)` — create a Node Broker
- `MinimalIncomingMessage`, `MinimalServerResponse` — minimal HTTP/1 request/response
  shims for local handler dispatch
- Types: Guest/Broker options, request/response, lifecycle, dispatch
- Constant: `VERSER2_GUEST_NODE_PACKAGE_NAME`

## Basic usage

```ts
import http from 'node:http';
import { createVerserNodeGuest, createVerserBroker } from '@signicode/verser2-guest-node';

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

guest.attach(server, 'client-a.local.test');

await broker.connect();
await guest.connect();
await broker.waitForRoute('client-a.local.test');

const response = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/',
});
```

## Broker routing

The Broker provides multiple ways to route requests:

- `broker.request()` — direct request API
- `broker.createAgent()` — `http:` Agent that routes via the Broker without DNS
- `broker.createDispatcher()` — Undici Dispatcher for `fetch(url, { dispatcher })`
- `broker.createFetch()` — pre-wired fetch helper

Broker request paths follow internal `307` and `308` redirects by default when
the response `Location` hostname exactly matches an advertised verser2 route.
The redirected request is resolved through the Broker route table, preserves the
original method, headers, path/query, and replayable body, and is bounded by
`maxInternalRedirects` (default `3`) and `internalRedirectReplayBufferBytes`
(default `16 KiB`). If the body is too large to replay or the target hostname is
not advertised, the original redirect response is returned unchanged. Exceeding
the redirect count fails with a `protocol-error`.

## Caveats

- Node Guest/Broker use outbound TLS HTTP/2.
- `attach()` accepts an `http.Server` with a request listener or a listener
  function; it does **not** call `listen()`.
- When no domain is supplied to `attach()`, the Guest ID is used as the route
  domain.
- Minimal HTTP objects do not implement the full Node `IncomingMessage` /
  `ServerResponse` / socket surface.
- WebSocket upgrade, CONNECT, trailers, and informational responses are not
  forwarded.
- Agent keep-alive pooling, HTTPS Agent behavior, and advanced socket features
  are not implemented.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Exposing HTTP](../../docs/exposing-http.md)
- [Docs: Making requests](../../docs/making-requests.md)
- [Docs: Lifecycle and errors](../../docs/lifecycle-and-errors.md)

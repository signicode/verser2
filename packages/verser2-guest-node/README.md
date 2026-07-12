# @signicode/verser2-guest-node

Node Guest and Broker package for verser2. Connects outbound to a verser2 Host
over TLS HTTP/2 and provides request routing without opening inbound ports.

## Public API

- `createVerserNodeGuest(options)` — create a Node Guest
- `createVerserBroker(options)` — create a Node Broker
- `MinimalIncomingMessage`, `MinimalServerResponse` — minimal HTTP/1 request/response
  shims for local handler dispatch
- Types: Guest/Broker options, request/response, lifecycle, dispatch, route lifecycle events
- `guest.revokeRoutes(domains)` — revoke advertised route domains via the dedicated
  `/verser/guest/revoke` request path; resolves with `{ status: 'ack'|'partial'|'error' }`
- `broker.onRouteChange(listener)` — observe route lifecycle events (`added`, `removed`,
  `changed`, `degraded`) with payload `{ type, targetId, domain, reason?, generation? }`
- Constant: `VERSER2_GUEST_NODE_PACKAGE_NAME`
- `VerserWebSocket` — VWS/1 WebSocket object; `webSocket()` and
  `attachWebSocket()` provide the direct Broker/Guest APIs.

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

## VWS/1 WebSockets

Node Broker and Guest WebSockets use explicit VWS/1 framed messages over the
existing TLS HTTP/2 connection:

```ts
guest.attachWebSocket((_open, ws) => {
  ws.on('message', async (data, options) => await ws.send(data, options));
  ws.on('close', (code, reason) => console.log(code, reason));
}, 'chat.local.test');

const ws = await broker.webSocket({ targetId: 'client-a', domain: 'chat.local.test' });
await ws.send('hello', { type: 'text' });
```

`send()` observes backpressure. This is not generic HTTP/1 upgrade forwarding;
Agent/Dispatcher upgrades, CONNECT/RFC8441, L4 forwarding, and federated
WebSocket routes are unsupported.

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

`broker.createFetch()` defaults Undici's redirect option to `manual` so fallback
redirect responses remain visible to callers instead of being followed through
DNS. Pass an explicit `redirect` option to override that fetch-level behavior.

### Broker route lifecycle observation

Brokers can observe route changes reactively without polling:

```ts
const unsubscribe = broker.onRouteChange((event) => {
  console.log(event.type, event.domain, event.reason);
  // e.g. 'added', 'removed', 'changed', 'degraded'
});
// Later, to stop observing:
unsubscribe();
```

The internal route snapshot (`getRoutes()`) is updated before listeners fire.
See the [Lifecycle and errors docs](../../docs/lifecycle-and-errors.md) for
event types, reasons, and degraded-route behavior.

### Guest route revocation

A connected Guest can selectively revoke its advertised routes without closing
the connection:

```ts
const result = await guest.revokeRoutes(['app.example.com', 'api.example.com']);
// result.status === 'ack' | 'partial' | 'error'
```

The Host responds with `ack` (all revoked), `partial` (some failed), or `error`
(entire request rejected). The revocation uses the dedicated
`/verser/guest/revoke` request path.

## Caveats

- Node Guest/Broker use outbound TLS HTTP/2.
- `attach()` accepts an `http.Server` with a request listener or a listener
  function; it does **not** call `listen()`.
- When no domain is supplied to `attach()`, the Guest ID is used as the route
  domain.
- Minimal HTTP objects do not implement the full Node `IncomingMessage` /
  `ServerResponse` / socket surface.
- Generic WebSocket upgrade, CONNECT/RFC8441, trailers, and informational
  responses are not forwarded. VWS/1 is the only supported WebSocket surface.
- Agent keep-alive pooling, HTTPS Agent behavior, and advanced socket features
  are not implemented.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Exposing HTTP](../../docs/exposing-http.md)
- [Docs: Making requests](../../docs/making-requests.md)
- [Docs: VWS/1 WebSockets](../../docs/websockets.md)
- [Docs: Lifecycle and errors](../../docs/lifecycle-and-errors.md)

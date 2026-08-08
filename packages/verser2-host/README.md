# @signicode/verser2-host

Host package for verser2. The Host listens for outbound Peer (Guest and Broker)
connections over TLS HTTP/2 and routes requests to advertised Guest routes. It
can also attach in-process local Guests and local Brokers directly to the Host,
and can connect outbound to upstream Hosts for route-aware federation.

## Public API

- `createVerserHost(options?: VerserHostOptions): VerserHost`
- Host methods: `host.attachLocalGuest(options)`,
  `host.attachLocalBroker(options)`, `host.connectUpstream(options)`,
  `host.getUpstreams()`
- Types: `VerserHost`, `VerserHostLifecycleEvent`, `VerserHostOptions`,
  `VerserHostRegistrationRequest`, `VerserHostUpstreamOptions`,
  `VerserHostUpstreamStatus`, `VerserHostUpstreamHandle`,
  `VerserLocalGuestRequestListener`, `VerserLocalGuestResponse`, `VerserLocalGuestOptions`,
  `VerserLocalBrokerOptions`, `VerserLocalBrokerRequest`,
  `VerserLocalBrokerResponse`, `VerserLocalGuestHandle`,
  `VerserLocalBrokerHandle`, `VerserRouteLifecycleEvent`
- Local Guest handle: `guest.revokeRoutes(domains)` — revoke route domains
  synchronously; returns `{ revoked: string[], notFound: string[] }`
- Local Broker handle: `broker.onRouteChange(listener)` — observe route lifecycle events
  (`added`, `removed`, `changed`, `degraded`); returns unsubscribe function
- Host option: `degradedRouteTimeoutMs` — timeout before degraded/disconnected
  routes are fully removed (default 5000 ms)
- Host option: `tls.clientAuth.unauthorizedClientHandler` — one bounded
  HTTP/2 response for the first non-reserved request from a client without a
  valid certificate, while gating the Verser protocol after TLS (see
  [Docs: Certificates](../../docs/certificates.md) and
  [Docs: Authorization](../../docs/authorization.md))
- Re-exported: `VerserPeerRole`
- Constant: `VERSER2_HOST_PACKAGE_NAME`

## Basic usage

```ts
import fs from 'node:fs';
import { createVerserHost } from '@signicode/verser2-host';

const host = createVerserHost({
  hostId: 'host-edge-a',
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
  },
});

await host.start();
```

### Upstream Host links

Use upstream links when this Host should participate in Host federation and
exchange routes with another Host:

```ts
const upstream: VerserHostUpstreamHandle = await host.connectUpstream({
  upstreamId: 'manager',
  url: 'https://manager.internal:8443',
  tls: { caFile: '/etc/verser/manager-ca.crt' },
});

console.log(host.getUpstreams());
await upstream.close('planned-maintenance');
```

### Local Host peers

Use local peers when the Guest handler and Broker caller run in the same Node.js
process as the Host. Local Guests use the same minimal Node HTTP listener shape
as remote Node Guests, but do not create a TLS HTTP/2 Guest connection.

```ts
const guest: VerserLocalGuestHandle = await host.attachLocalGuest({
  guestId: 'in-process-guest',
  routedDomains: ['in-process.local.test'],
  listener(request, response) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`Handled ${request.method} ${request.url}`);
  },
});

const broker: VerserLocalBrokerHandle = await host.attachLocalBroker({
  brokerId: 'in-process-broker',
});

await broker.waitForRoute('in-process.local.test');
const response = await broker.request({
  targetId: 'in-process-guest',
  method: 'GET',
  path: '/health',
});

response.body.pipe(process.stdout);
await broker.close();
await guest.close();
```

## VWS/1 WebSockets

The Host admits explicit VWS/1 framed WebSocket streams from registered Node,
Bun-facing, or Python Brokers to Node, Bun, or Python Guests over TLS HTTP/2.
Imported routes use the authenticated versioned federation-VWS stream hop by
hop, with the normal route topology and hop/loop checks. Route advertisements
remain neutral and do not preflight WebSocket capability. The Host does not
forward HTTP/1 upgrade bytes, CONNECT/RFC8441, or L4 traffic. Agent/Dispatcher
upgrades are unsupported; Bun `server.upgrade()` is implemented by the Bun Guest
adapter, not by this Host package.

## Unauthorized client handler

Strict transport-level mTLS remains the default: when `tls.clientAuth.ca` or
`tls.clientAuth.caFile` is configured and no handler is present, the TLS
handshake rejects clients that present no client certificate or an untrusted
one.

Configuring `tls.clientAuth.unauthorizedClientHandler` is the only opt-in that
changes this default. The TLS layer still requests a client certificate but
lets the session complete, and the Host gates the Verser protocol instead of
rejecting at the transport. A session without a valid certificate can produce
exactly **one** bounded HTTP/2 response for a non-reserved first request:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
    clientAuth: {
      caFile: '/etc/verser/client-ca.crt',
      unauthorizedClientHandler(context) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: `Hello ${context.path}`,
        };
      },
    },
  },
});
```

Behavior contract:

- **Strict default unchanged** — without the handler, client authentication is
  strict and rejects invalid clients at the TLS handshake. The handler is the
  sole opt-in; there is no public `rejectUnauthorized: false` switch.
- **One bounded callback request** — the Host claims the first stream on the
  session synchronously, sends GOAWAY, and invokes the handler at most once.
  Concurrent and later streams are refused without being parsed or answered.
- **No raw HTTP/2** — the context exposes `method`, `path`, ordinary headers
  (pseudo-headers removed), a byte-preserving `Buffer` body, and an
  `AbortSignal`. Node HTTP/2 stream and session objects are not exposed.
- **Reserved Verser paths silently close** — a first request whose path is
  `/verser` or starts with `/verser/` is refused and the session is closed
  without invoking the handler or any Verser protocol handler.
- **Valid cert reconnect** — an unauthorized session is never admitted to the
  Verser protocol and is closed after the one request. A client that later
  presents a valid certificate must open a new TLS connection.
- **Limits and errors** — request bodies and handler response bodies default
  to 64 KiB and are configurable via `unauthorizedClientMaxRequestBodyBytes`
  and `unauthorizedClientMaxResponseBodyBytes`; request and handler deadlines
  default to 5000 ms via `unauthorizedClientRequestTimeoutMs` and
  `unauthorizedClientHandlerTimeoutMs`. Oversize, incomplete, timed-out,
  invalid, and throwing cases receive a bounded HTTP error (413, 400, 408, or
  500) where possible, then the session closes.
- **Protocol gate, not transport mTLS** — handler mode is optionally
  client-authenticated TLS with strict Host protocol gating: the unauthorized
  session cannot reach registration, Guest control/lease, Broker request or
  WebSocket, or federation paths, and it produces no lifecycle events. A
  session that never sends a request, or whose TLS handshake or ALPN fails
  before HTTP/2 is established, receives no callback response.

## Caveats

- Host uses Node TLS HTTP/2 and requires TLS options.
- Defaults to `127.0.0.1` and port `0` (ephemeral).
- `host.address` throws before the Host starts listening.
- Server certificate material can be reloaded while running via
  `host.reloadTlsCertificate()`.
- Host federation route state is eventually consistent. New requests can fall
  back to another route candidate before forwarding starts, but active in-flight
  requests are not migrated or transparently replayed.
- Automatic upstream reconnect policy is not yet configurable; applications can
  observe lifecycle events and reconnect at their boundary.
- Registration authorization is a registration-time mTLS/client-certificate hook
  only — it is not complete application authentication/authorization, and
  per-request Broker target authorization is not implemented.
- Local peers bypass TLS. Local registration still invokes
  `authorizeRegistration`, but the Host supplies `certificate: undefined` and
  Host-owned metadata `{ local: true, authorized: true }`.
- `tls.clientAuth.unauthorizedClientHandler` gates the Verser protocol after
  TLS instead of preserving transport-level strict mTLS. An unauthorized
  session receives one bounded response and is then closed; a client that
  later presents a valid certificate must reconnect.
- The Host package exposes raw local `request()` primitives only. Agent,
  Dispatcher, and fetch helpers remain in `@signicode/verser2-guest-node` for
  remote Node Brokers.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Certificates](../../docs/certificates.md)
- [Docs: Authorization](../../docs/authorization.md)
- [Docs: Host federation and upstreams](../../docs/host-federation.md)

# Host federation and upstreams

Host federation lets one Verser2 Host connect outbound to another Host over TLS
HTTP/2. The connected Hosts exchange route availability, and either side can
route Broker requests to eligible imported route candidates over the federated
Host link.

This is route-aware Host-to-Host federation. It is not generic L4 tunneling or
HTTP/2 CONNECT tunneling.

## Concepts

```txt
Broker ──outbound──▶ manager Host
                       ▲
                       │ outbound upstream link
runner Host ───────────┘
    ▲
    └── Guest: app.internal
```

- A federated Host has a stable `hostId`.
- A downstream Host calls `connectUpstream()` to connect outbound to an upstream
  Host.
- Hosts exchange federated route records containing `domain`, `targetId`,
  `originHostId`, `nextHopHostId`, `hopCount`, `viaHostIds`, and `source`.
- Brokers still receive the legacy `{ domain, targetId }` route shape.
- Request bodies and response bodies are streamed; ordinary forwarded requests do
  not require full-body buffering.
- A Broker connected to the upstream Host can reach a downstream Guest route, and
  a Broker connected to the downstream Host can reach routes imported from the
  upstream Host.

## Minimal upstream setup

```ts
import { createVerserHost } from '@signicode/verser2-host';

const manager = createVerserHost({
  hostId: 'host-manager',
  port: 8443,
  tls: {
    certFile: '/etc/verser/manager.crt',
    keyFile: '/etc/verser/manager.key',
  },
});
await manager.start();

const runner = createVerserHost({
  hostId: 'host-runner-a',
  tls: {
    certFile: '/etc/verser/runner.crt',
    keyFile: '/etc/verser/runner.key',
  },
});

const upstream = await runner.connectUpstream({
  upstreamId: 'manager',
  url: 'https://manager.internal:8443',
  tls: { caFile: '/etc/verser/manager-ca.crt' },
});

console.log(runner.getUpstreams()); // [{ upstreamId: 'manager', connected: true }]
await upstream.close('planned-maintenance');
```

`upstreamId` is the local link identifier on the downstream Host. The remote
Host identity comes from the upstream federation handshake and is used in route
loop prevention.

## Broker reaching a downstream Guest

```ts
import http from 'node:http';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';
import { createVerserHost } from '@signicode/verser2-host';

const manager = createVerserHost({
  hostId: 'host-manager',
  port: 8443,
  tls: { certFile: '/etc/verser/manager.crt', keyFile: '/etc/verser/manager.key' },
});
await manager.start();

const runner = createVerserHost({
  hostId: 'host-runner-a',
  port: 8443,
  tls: { certFile: '/etc/verser/runner.crt', keyFile: '/etc/verser/runner.key' },
});
await runner.start();
await runner.connectUpstream({
  upstreamId: 'manager',
  url: 'https://manager.internal:8443',
  tls: { caFile: '/etc/verser/manager-ca.crt' },
});

const service = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('handled by runner');
});

const guest = createVerserNodeGuest({
  hostUrl: 'https://runner.internal:8443',
  guestId: 'guest-runner-api',
  tls: { caFile: '/etc/verser/runner-ca.crt' },
});
guest.attach(service, 'runner-api.internal');
await guest.connect();

const broker = createVerserBroker({
  hostUrl: 'https://manager.internal:8443',
  brokerId: 'broker-manager',
  tls: { caFile: '/etc/verser/manager-ca.crt' },
});
await broker.connect();
await broker.waitForRoute('runner-api.internal');

const response = await broker.request({
  targetId: 'guest-runner-api',
  method: 'GET',
  path: '/health',
  headers: { host: 'runner-api.internal' },
});
```

The Broker connects only to the manager Host. The manager selects the imported
route candidate and forwards the request over the federated Host link to the
runner Host, which dispatches it to the Guest.

## Broker reaching an upstream route

The reverse request direction is also supported. A Broker connected to a
downstream Host can request a route imported from the upstream Host:

```txt
Broker ──▶ runner Host ──upstream link──▶ manager Host ──▶ Guest: manager-api.internal
```

```ts
await runner.connectUpstream({
  upstreamId: 'manager',
  url: 'https://manager.internal:8443',
  tls: { caFile: '/etc/verser/manager-ca.crt' },
});

const broker = createVerserBroker({
  hostUrl: 'https://runner.internal:8443',
  brokerId: 'broker-runner',
  tls: { caFile: '/etc/verser/runner-ca.crt' },
});
await broker.connect();
await broker.waitForRoute('manager-api.internal');

const response = await broker.request({
  targetId: 'guest-manager-api',
  method: 'POST',
  path: '/jobs',
  headers: { host: 'manager-api.internal' },
  body: [Buffer.from('payload')],
});
```

The downstream Host opens a one-shot federated request stream over its existing
upstream link for the selected imported candidate. Existing inbound federation
request streams continue to handle upstream-to-downstream requests.

Node and Bun-facing Brokers can also follow native `307`/`308` redirects across
advertised imported routes. For example, a manager route can return
`308 Location: http://target-runner.internal/final`, and the Broker will replay
the request to the advertised target route when its redirect safeguards allow it.

## Runner -> hub -> manager topology

Multi-level topologies work by connecting each lower Host outbound to its
upstream:

```txt
Broker ──▶ manager Host
             ▲
             │
           hub Host
             ▲
             │
         runner Host ──▶ Guest routes
```

The runner exports local Guest routes to the hub. The hub imports those routes,
then exports eligible candidates to the manager with an incremented `hopCount`
and updated `viaHostIds`. Routes that would revisit a Host or exceed the Host's
`maxFederationHopCount` are suppressed.

## Route selection and HA behavior

When multiple candidates exist for the same target/domain, the Host ranks them
deterministically:

1. local Guest routes first;
2. imported routes with a shorter `hopCount`;
3. stable target/domain/next-hop/owner ordering.

Route tables are eventually consistent. When a Guest, downstream Host, or
upstream link disconnects, imported routes are withdrawn and Brokers receive a
replacement route table. New requests can fall back to another candidate when a
preferred federated request stream is unavailable before any forwarded request
bytes are sent.

Verser2 does **not** migrate active requests. If a selected Host/session/stream
fails after forwarding starts, the in-flight request fails instead of being
replayed transparently.

## TLS and mTLS authorization

Upstream links use the same TLS trust and client identity option model as other
Node/Bun Verser clients:

```ts
await runner.connectUpstream({
  upstreamId: 'manager',
  url: 'https://manager.internal:8443',
  tls: {
    caFile: '/etc/verser/manager-ca.crt',
    certFile: '/etc/verser/runner-client.crt',
    keyFile: '/etc/verser/runner-client.key',
  },
});
```

The receiving Host can configure `tls.clientAuth.authorizeFederation` to allow or
reject upstream Host links based on the declared Host ID, TLS authorization
state, and certificate identity:

```ts
const manager = createVerserHost({
  hostId: 'host-manager',
  tls: {
    certFile: '/etc/verser/manager.crt',
    keyFile: '/etc/verser/manager.key',
    clientAuth: {
      caFile: '/etc/verser/host-client-ca.crt',
      authorizeFederation(context) {
        if (context.hostId === 'host-runner-a' && context.metadata.authorized === true) {
          return { action: 'allow' };
        }
        return { action: 'close', reason: 'upstream Host is not allowed' };
      },
    },
  },
});
```

mTLS proves transport identity according to Node.js TLS validation. Application
policy still belongs in the callback.

## Failure modes and limits

- `upstream-unavailable` — no usable federated request stream is available.
- `route-loop` — an imported route would revisit a Host or exceed the hop limit.
- `authorization-denied` — upstream federation authorization rejected a link.
- `unsafe-retry` — reserved for retry policy failures; non-replayable active
  streams are not retried transparently.

Current limits:

- Route state is eventually consistent; there is no consensus, leader election,
  durable route registry, or exactly-once delivery.
- Automatic reconnect policy is not yet configurable. Applications can observe
  `getUpstreams()`/lifecycle events and reconnect at their boundary.
- Host federation is implemented for the Node Host package only.
- HTTP/3, browser/Rust/Go/Java/Python Host behavior, WebSocket/upgrade
  forwarding, trailers, informational responses, generic L4 tunneling, and
  HTTP/2 CONNECT tunneling are not implemented.

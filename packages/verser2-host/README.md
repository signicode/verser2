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
  `VerserLocalBrokerHandle`
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
- The Host package exposes raw local `request()` primitives only. Agent,
  Dispatcher, and fetch helpers remain in `@signicode/verser2-guest-node` for
  remote Node Brokers.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Certificates](../../docs/certificates.md)
- [Docs: Authorization](../../docs/authorization.md)
- [Docs: Host federation and upstreams](../../docs/host-federation.md)

# @signicode/verser2-host

Host package for verser2. The Host listens for outbound Peer (Guest and Broker)
connections over TLS HTTP/2 and routes requests to advertised Guest routes. It
can also attach in-process local Guests and local Brokers directly to the Host.

## Public API

- `createVerserHost(options?: VerserHostOptions): VerserHost`
- Host methods: `host.attachLocalGuest(options)`,
  `host.attachLocalBroker(options)`
- Types: `VerserHost`, `VerserHostLifecycleEvent`, `VerserHostOptions`,
  `VerserHostRegistrationRequest`, `VerserLocalGuestRequestListener`,
  `VerserLocalGuestOptions`, `VerserLocalBrokerOptions`,
  `VerserLocalBrokerRequest`, `VerserLocalBrokerResponse`,
  `VerserLocalGuestHandle`, `VerserLocalBrokerHandle`
- Re-exported: `VerserPeerRole`
- Constant: `VERSER2_HOST_PACKAGE_NAME`

## Basic usage

```ts
import fs from 'node:fs';
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

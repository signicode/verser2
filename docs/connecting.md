# Connecting

This guide covers creating a Host and connecting Guests and Brokers.

## Host

The Host listens for outbound Peer connections over TLS HTTP/2. It accepts
Guest and Broker registrations and routes requests to advertised Guest routes.

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

**Runtime notes:**

- Host defaults to `127.0.0.1` and port `0` (ephemeral).
- TLS is required; see [Certificates](./certificates.md).
- `host.address` throws before the Host starts listening.
- Server certificate material can be reloaded while running via
  `host.reloadTlsCertificate()`.
- Examples often use one Host, but this is not a built-in cluster or HA model.
  Route state is per Host instance and per connected peer set. Multi-Host
  topologies and shared route state are deployment architecture and future work.

### Local Host peers

When a Guest handler or Broker caller runs in the same Node.js process as the
Host, attach it directly with the Host local peer APIs instead of opening a TLS
HTTP/2 Guest or Broker connection:

```ts
const localGuest = await host.attachLocalGuest({
  guestId: 'local-client-a',
  routedDomains: ['local-client-a.local.test'],
  listener(request, response) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`Handled ${request.method} ${request.url}`);
  },
});

const localBroker = await host.attachLocalBroker({
  brokerId: 'local-broker-a',
});

await localBroker.waitForRoute('local-client-a.local.test');
```

Local Host peers share the Host route table with remote TLS HTTP/2 peers:
local Brokers can request remote H2 Guests, and remote H2 Brokers can request
local Guests. Local peers bypass TLS, but still run through registration-time
authorization with Host-owned local metadata.

## Guest

A Guest connects outbound to a Host, registers as role `guest`, and attaches a
local HTTP handler. The Guest does **not** call `listen()` or open an inbound
port for verser routing.

### Node Guest

```ts
import { createVerserNodeGuest } from '@signicode/verser2-guest-node';

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

guest.attach(localHttpServer, 'client-a.local.test');
await guest.connect();
```

### Bun Guest

```ts
import { createVerserBunGuest } from '@signicode/verser2-guest-bun';

const bunGuest = createVerserBunGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'bun-client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

bunGuest.attach({
  fetch(request) {
    return new Response('ok', { status: 200 });
  },
}, 'bun-client-a.local.test');

await bunGuest.connect();
```

### Python Guest

```py
from verser2_guest_python import create_verser_guest


async def app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


guest = create_verser_guest(
    host_url="https://localhost:8443",
    guest_id="python-client-a",
    app=app,
    routed_domains=["python-client-a.local.test"],
    tls_ca_file="/etc/verser/ca.crt",
)
await guest.connect()
```

## Broker

A Broker connects outbound to a Host, registers as role `broker`, and sends
requests to advertised Guest routes.

### Node Broker

```ts
import { createVerserBroker } from '@signicode/verser2-guest-node';

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

await broker.connect();
await broker.waitForRoute('client-a.local.test');
```

### Bun Broker

The Bun package provides a Broker wrapper that reuses the Node transport and
adapts `createFetch()` for Bun/Web Fetch usage:

```ts
import { createVerserBroker } from '@signicode/verser2-guest-bun';

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

await broker.connect();
```

### Python Broker

```py
from verser2_guest_python import create_verser_broker

broker = create_verser_broker(
    host_url="https://localhost:8443",
    broker_id="broker-a",
    tls_ca_file="/etc/verser/ca.crt",
)
await broker.connect()
```

The Python Broker supports request helpers (`request`, `get`, `post`, `put`,
`patch`, `delete`) and returns `VerserBrokerResponse` objects.

## Close

All Peers support `close()` to disconnect from the Host:

```ts
await guest.close('guest-shutdown');
await broker.close();
await localGuest.close();
await localBroker.close();
```

The optional reason string is local lifecycle context for implementations that
surface close events; it is not a cross-runtime application close message.

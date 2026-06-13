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
```

The optional reason string is local lifecycle context for implementations that
surface close events; it is not a cross-runtime application close message.

# verser2

verser2 is a reverse HTTP connectivity toolkit that lets applications route
requests to HTTP handlers that connect **outbound** to a Host instead of
listening for inbound traffic. It uses TLS HTTP/2 for multiplexed transport
between three roles:

- **Host** — listens for outbound Peer connections, can connect outbound to
  upstream Hosts, and routes requests to advertised Guest routes.
- **Guest** — connects outbound to a Host and attaches a local HTTP handler
  without calling `listen()`.
- **Broker** — connects outbound to a Host and sends requests to advertised
  Guest routes.

## Quickstart

```ts
import fs from 'node:fs';
import http from 'node:http';
import { createVerserHost } from '@signicode/verser2-host';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const ca = fs.readFileSync('/etc/verser/ca.crt', 'utf8');
const cert = fs.readFileSync('/etc/verser/host.crt', 'utf8');
const key = fs.readFileSync('/etc/verser/host.key', 'utf8');

// Start the Host
const host = createVerserHost({ port: 8443, tls: { cert, key } });
await host.start();

// Create a Guest and attach a local HTTP handler
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { ca },
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Handled ${req.method} ${req.url}`);
});

guest.attach(server, 'client-a.local.test');

// Create a Broker and connect
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { ca },
});

await broker.connect();
await guest.connect();
await broker.waitForRoute('client-a.local.test');

// Send a request through the Broker
const response = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/health',
});

response.body.pipe(process.stdout);
```

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@signicode/verser-common` | [packages/verser-common](./packages/verser-common) | Shared protocol, types, utilities |
| `@signicode/verser2-host` | [packages/verser2-host](./packages/verser2-host) | Host creation and lifecycle |
| `@signicode/verser2-guest-js-common` | [packages/verser2-guest-js-common](./packages/verser2-guest-js-common) | JS foundations for adapters |
| `@signicode/verser2-guest-node` | [packages/verser2-guest-node](./packages/verser2-guest-node) | Node Guest, Broker, Agent, Dispatcher, Fetch |
| `@signicode/verser2-guest-bun` | [packages/verser2-guest-bun](./packages/verser2-guest-bun) | Bun Guest and Broker wrapper |
| `@signicode/verser2-guest-python` | [packages/verser2-guest-python](./packages/verser2-guest-python) | Python ASGI Guest and Broker |

## Documentation

- [Connecting](./docs/connecting.md) — create a Host, connect Guests and Brokers
- [Exposing HTTP handlers](./docs/exposing-http.md) — attach Node, Bun, or Python handlers
- [Making requests](./docs/making-requests.md) — Broker request, Agent, Dispatcher, Fetch
- [Routes](./docs/routes.md) — route advertisement and exact hostname matching
- [Host federation and upstreams](./docs/host-federation.md) — Host-to-Host links, topology, and HA limits
- [Certificates](./docs/certificates.md) — TLS configuration, mTLS, self-signed certs
- [Authorization](./docs/authorization.md) — registration-time and upstream federation mTLS authorization
- [Lifecycle and errors](./docs/lifecycle-and-errors.md) — events, errors, reconnection
- [Development](./docs/development.md) — repository setup, validation, and package staging

## Development

```sh
npm install          # Install dependencies
npm run build        # Build all workspace packages
npm test             # Run tests
npm run test:coverage
npm run lint         # Biome linting and formatting
```

See [Development](./docs/development.md) for package staging and release-oriented
validation commands.

## What verser2 is not

- HTTP/3 is not implemented.
- Browser, Rust, Go, Java, and Python Host implementations are not implemented.
- WebSocket upgrade, CONNECT tunneling, trailers, and informational responses
  are not forwarded through the verser transport.
- verser2 is not a complete public gateway. Applications remain responsible for
  authentication, authorization, and routing policy.
- Per-request Broker target authorization is not implemented.
- Host-to-Host federation is route-aware; generic L4 tunneling and active
  in-flight request migration are not implemented.

## Status

verser2 uses TLS HTTP/2 for multiplexed transport. HTTP/3 remains roadmap work.

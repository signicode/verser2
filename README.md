# verser2

verser2 is a **reverse HTTP connectivity** toolkit. Instead of exposing an
inbound port and waiting for traffic, a service opens an **outbound** connection
to a verser2 **Host**, and the Host routes requests back to it over that
connection. Guests and Brokers dial out to the Host; the Host is the single
place that listens.

Every remote connection is a **persistent TLS HTTP/2 session**, so many
requests and responses multiplex over one long-lived socket. **Mutual TLS
(mTLS) is optional** — enable it when you want the Host to authenticate each
Guest and Broker by client certificate.

## Why this shape

- **No inbound ports on your services.** A Guest attaches its ordinary local
  HTTP handler and connects out to the Host — it never calls `listen()`. The
  Host dispatches routed requests to that handler **in-process**.
- **Bridges isolated networks without a VPN.** Because every Peer connects
  outbound, verser2 reaches handlers behind NAT, firewalls, and private
  networks using only the egress path those machines already have.
- **One connection, many requests.** TLS HTTP/2 multiplexing keeps a single
  persistent session warm instead of opening a socket per request.
- **Build your own public gateway.** verser2 supplies the routing substrate;
  authentication, authorization, and routing policy stay in your application
  through Host callbacks — registration authorization, a `routeAuthorizer`, and
  an optional unauthorized-client handler. You assemble the gateway your product
  needs rather than adopting someone else's defaults.

## Roles

- **Host** — the listening edge. Accepts outbound Guest and Broker connections,
  routes requests to advertised Guest routes, connects outbound to upstream
  Hosts for federation, and attaches in-process local Guests and Brokers.
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
- [VWS/1 WebSockets](./docs/websockets.md) — Node, Bun, and Python ASGI WebSocket APIs,
  including Host federation
- [Routes](./docs/routes.md) — route advertisement and exact hostname matching
- [Host federation and upstreams](./docs/host-federation.md) — Host-to-Host links, topology, and HA limits
- [Certificates](./docs/certificates.md) — TLS configuration, mTLS, self-signed certs
- [Authorization](./docs/authorization.md) — registration-time and upstream federation mTLS authorization
- [Lifecycle and errors](./docs/lifecycle-and-errors.md) — events, errors, reconnection
- [Development](./docs/development.md) — repository setup, validation, and package staging

## Contributing and security

- [Contributing](./CONTRIBUTING.md) — setup, validation, pull requests, and signoff expectations
- [Security policy](./SECURITY.md) — private vulnerability reporting and supported-version expectations
- [Code of conduct](./CODE_OF_CONDUCT.md) — public collaboration baseline

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

verser2 is a deliberately focused routing toolkit. These are scope boundaries
that follow from the model, not gaps in it:

- **Application-owned policy.** verser2 is the substrate for a public gateway,
  not a turnkey one. Authentication, authorization, and routing policy are your
  application's responsibility, expressed through the Host's registration,
  route, and client callbacks.
- **WebSockets are VWS/1, not raw upgrades.** [VWS/1 WebSockets](./docs/websockets.md)
  carry explicit framed messages over the existing TLS HTTP/2 transport: Node
  exposes `broker.webSocket()` and `guest.attachWebSocket()`, and the Python
  Guest maps VWS leases to ASGI websocket scopes. Generic HTTP/1 upgrades,
  CONNECT/RFC8441, and L4 forwarding are out of scope, as is Agent/Dispatcher
  upgrade handling. Bun `server.upgrade()` is supported only as the VWS/1 Guest
  adapter, not as a generic upgrade path or a listening Bun server.
- **Route-aware federation, not L4 tunneling.** Host-to-Host links import and
  export routes and carry federated VWS/1 connections across Hosts that
  implement the authenticated federation endpoint; they do not migrate active
  in-flight requests.
- **HTTP/2 transport today.** verser2 uses persistent TLS HTTP/2 for multiplexed
  transport; HTTP/3 remains roadmap work.
- **Node, Bun, and Python Guests today.** Browser, Rust, Go, and Java Guests —
  and a Python Host — are roadmap directions rather than shipped packages.

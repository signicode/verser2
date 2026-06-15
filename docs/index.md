# Verser2 documentation

Verser2 lets applications route HTTP requests to Guest-side handlers that
connect outbound to a Host instead of listening for inbound traffic.

## Roles

Three implemented roles work together:

- **[Host](./connecting.md#host)** — listens for outbound Guest and Broker
  connections, can connect outbound to upstream Hosts, and routes requests to
  advertised Guest routes.
- **[Guest](./connecting.md#guest)** — connects outbound to a Host and attaches a
  local HTTP handler without calling `listen()`.
- **[Broker](./connecting.md#broker)** — connects outbound to a Host and sends
  requests to advertised Guest routes.
- The Node Host can also attach **in-process local peers** with
  `attachLocalGuest()` and `attachLocalBroker()` when a Guest or Broker runs in
  the same process as the Host.

## Getting started

- [Connecting](./connecting.md) — create a Host, attach a Guest, connect a Broker.
- [Exposing HTTP handlers](./exposing-http.md) — attach Node, Bun, or Python
  handlers without opening a port.
- [Making requests](./making-requests.md) — send requests through a Broker using
  `request()`, Agent, Dispatcher, or fetch.
- [Routes](./routes.md) — route advertisement, exact hostname matching, and route
  state.
- [Host federation and upstreams](./host-federation.md) — Host IDs, upstream
  links, route import/export, multi-Host topology, and HA limits.
- [Certificates](./certificates.md) — TLS configuration, self-signed certificates,
  mTLS, and certificate reloading.
- [Authorization](./authorization.md) — registration-time and upstream
  federation authorization via mTLS and client certificates.
- [Lifecycle and errors](./lifecycle-and-errors.md) — lifecycle events, error
  handling, and reconnection.
- [Development](./development.md) — repository setup, validation, and package
  staging.
- [Examples: tiny Bun gateway](./examples/gateway.md) — application-owned public
  gateway forwarding to Node and Python Guests.

## Transport

- Host, Guest, and Broker communicate over TLS HTTP/2 for remote peer
  connections.
- Federated Host-to-Host upstream links also use TLS HTTP/2.
- In-process local peers are supported on the Node Host as an alternative to a
  TLS HTTP/2 Guest or Broker connection when all participants are colocated.
- Guests attach local handlers in-process: Node HTTP handlers, Bun Fetch-style
  handlers, or Python ASGI apps. They never call `listen()` for this routing
  path.
- HTTP/3 is roadmap work and is not implemented.
- WebSocket upgrade, CONNECT tunneling, trailers, and informational responses are
  not forwarded.

## Terminology

| Term     | Meaning                                                   |
|----------|------------------------------------------------------------|
| **Host** | A TLS HTTP/2 server that accepts outbound Peer connections |
| **Guest**| A Peer that registers HTTP routes and handles requests     |
| **Broker**| A Peer that sends requests to advertised Guest routes      |
| **Peer** | A generic Host-connected client (Guest or Broker), either remote over TLS HTTP/2 or local in-process |
| **Upstream** | A Host-to-Host link opened outbound from one Host to another Host |
| **Route**| A domain name that the Host maps to a registered Guest or imported federated candidate |
| **Lease**| A one-use HTTP/2 stream assigned for request/response body transport |

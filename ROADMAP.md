# Verser2 roadmap

This roadmap lists future implementation work only. Completed Node, Bun, Python
Guest/Broker, TLS, packaging, and documentation work is described in the README,
task docs, package READMEs, and codemaps.

Future work is tracked as Conductor tracks before implementation. Roadmap items
below are not implemented unless a linked track and source code say otherwise.

## Priority 1

### Gateway and deployment work

`verser2` is a reverse connectivity and routing layer, not a complete public API
gateway. Applications can build gateways on top of Brokers today, but the public
HTTP listener, auth, policy, observability, and operational behavior are owned by
the application.

Future gateway-oriented tracks, in priority order:

- P1.1: Per-request Broker target authorization so a Host can decide whether a
  Broker may route to a specific Guest, target ID, or domain.
- P1.2: Host high-availability and shared route-state patterns. Current route
  state is per Host instance and per connected peer set.
- P1.3: Public gateway helper examples or small framework integrations that show how
  to accept inbound HTTP and forward through a Broker.
- P1.4: Built-in gateway policy helpers for authentication, rate limiting, and
  observability primitives, without turning `verser2` into a mandatory gateway
  framework.
- P1.5: Additional gateway examples for container, Kubernetes, and service-mesh-style
  deployments.

## Priority 2

### Transport work

- P2.1: HTTP/3/QUIC transport remains future work. Current remote
  Host/Guest/Broker transport uses TLS HTTP/2.
- P2.2: WebSocket/HTTP upgrade forwarding is not implemented. A future transport
  track should specify upgrade semantics, routing policy, and runtime adapter
  behavior before implementation.
## Priority 3

### Runtime expansion

Future Guest runtimes remain later work:

- P3.1: Browser Guest using Fetch API and Service Worker concepts.
- P3.2: Rust Guest using Hyper-compatible concepts.
- P3.3: Go Guest compatible with `net/http` concepts.
- P3.4: Java Guest using `net.httpserver` or similar concepts.

Non-Node Host implementations are not on the current roadmap.

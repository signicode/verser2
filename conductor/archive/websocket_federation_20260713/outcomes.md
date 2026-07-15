# WebSocket Federation Outcomes

## Decisions & Rationale

- VWS/1 remains the shared, versioned WebSocket transport; federation forwards it over dedicated authenticated HTTP/2 streams rather than generic upgrades.
- Persistent acquisition streams are directional send leases. Reverse traffic opens a fresh federation-VWS stream, preventing reader collisions during simultaneous bidirectional opens.
- Frame limits and queue accounting remain bounded at every hop. Python Broker admission measures the actual compact serialized frame size.

## Outcomes & Results

- Node, Bun, and Python Brokers can reach Node, Bun, and Python Guests across local, direct remote, and multi-hop federated topologies.
- Host routing preserves VWS metadata, text/binary messages, subprotocols, ping/pong, close propagation, structured negotiation failures, and pre-accept-only failover.
- Phase 5 validation: 238 targeted tests passed; canonical `npm test` passed 408 tests with 4 expected skips; build, lint, and diff checks passed. Focused changed-behavior coverage was 99.30% for WebSocket tests and 96.66% for Python Broker integration.
- Phase 6 verified exact Python VWS frame-size admission with 125 Python workspace tests and focused bounded integration passing.

## Verification Summary

- Oracle review verified authenticated session binding, route traversal controls, directional stream ownership, atomic lease reservation, shutdown/disconnect cleanup, bounded resource behavior, documentation alignment, and direct HTTP regression safety.
- Guarded validation enforced bounded heap settings and a 1 MiB per-test growth guard; no unresolved Critical, High, or deferred findings remain.

## Constraints

- VWS/1 runs over TLS HTTP/2; generic HTTP upgrade, CONNECT/RFC8441, HTTP/3, and a Python Host remain unsupported.
- Browser, Rust, Go, and Java guests remain future work. Accepted sockets do not reconnect, migrate, or fail over after acceptance.

## Risks & Open Items

- No known open items.

## Follow-ups

- None identified.

## PR / Base Branch

- PR: https://github.com/signicode/verser2/pull/52
- Base branch: `main`
- Implementation branch: `conductor/websocket_federation_20260713`

# Outcomes: Route Revocation Events

## Completed work

- Added first-class Guest route revocation APIs for Node, Bun, Python, and local Guest handles, allowing Guests to revoke only their own advertised routes without closing the connection.
- Added Broker route lifecycle observation APIs for Node, Bun-facing, Python, and local Broker surfaces while keeping Brokers observational-only.
- Added shared route lifecycle and revocation protocol shapes in `@signicode/verser-common`, including ACK/error responses, lifecycle event reasons, and minimal generation/session metadata.
- Extended Host route state to support per-route revocation, degraded/disconnected routes, delayed removal, restoration, route lifecycle broadcasts, and stale-route safety.
- Added a dedicated Guest-to-Host revocation request path with ownership and HTTP/2 session binding checks.
- Propagated explicit revocation, degraded/disconnected state, restoration, and removal through local peers and Host federation/upstream route forwarding.
- Documented Guest revocation APIs, Broker route-change events, degraded-route behavior, timeout configuration, snapshot versus lifecycle semantics, and local/remote parity.

## Validation and reviews

- Added focused tests before implementation across common protocol helpers, Host route registry behavior, remote and local routing, Broker lifecycle events, federation propagation, Bun wrapper parity, Python Guest/Broker parity, and docs.
- Focused Node validations passed for common protocol, Host route registry, Broker routing, Host behavior, local peers, and upstream/federation suites.
- Bun wrapper validation passed with the workspace test suite and package build.
- Python validation passed with `uv run pytest` in `packages/verser2-guest-python`.
- Documentation validation passed with `node --test test/docs.test.js`.
- Final validation recorded in the track plan covered full repository tests, build/type checks, lint, route lifecycle coverage expectations, and shared-helper deduplication.
- Maintainability/API review cleared the implementation with no remaining P0/P1 blockers after in-scope fixes.

## Deferred or intentional limits

- Brokers still cannot mutate or revoke routes.
- The track does not implement HTTP/3, browser, Rust, Go, Java, or public gateway authorization behavior.
- Generation/session metadata remains minimal and scoped to stale-route safety and lifecycle observation rather than a comprehensive end-to-end generation protocol.
- Existing full route snapshots remain supported for compatibility, with lifecycle events added as the explicit observation mechanism.

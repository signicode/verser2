# Outcomes: Streaming Improvements

## Completed work

- Hardened streaming, cancellation, backpressure, lease, federation, Bun, and Python ASGI behavior across the Host, Guest, and Broker paths.
- Added VWS/1 explicit framed WebSockets for Node Broker/Guest and Python ASGI Guest surfaces, with bounded frames, close/ping behavior, and lifecycle tests.
- Added route-domain routing that preserves an external authority in `X-Forwarded-Host` while the Host authorizes the exact active route domain.
- Added canonical bounded test execution in two deterministic partitions with a fixed, non-bypassable 10-second timeout per test and timing output.

## Validation and reviews

- Canonical bounded tests pass in two partitions (390 tests total); no test exceeds the 10-second timeout.
- Repository lint and required PR CI checks pass.
- Oracle review found no remaining actionable P0-P2 findings.

## Deferred or intentional limits

- Federated WebSocket connections remain unsupported.
- Imported-only federated WebSocket routes can currently return `missing-guest` before the explicit unsupported-route error; correct that error path in a future dedicated track without enabling federated WebSockets.

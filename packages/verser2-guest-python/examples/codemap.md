# packages/verser2-guest-python/examples/

## Responsibility

Contains example Python Guest/Broker programs for manual package consumers and
integration experiments.

## Design

Examples are intentionally small scripts that demonstrate ASGI handler creation,
Guest connection, Broker request helpers, TLS CA/client identity options, and
route waiting without adding production framework dependencies.

## Flow

Example programs create a Guest or Broker, connect to an already-running Host,
advertise or wait for a route domain, and then either serve ASGI requests or send
Broker requests by URL hostname.

## Integration

- Imports from `verser2_guest_python` public entrypoints.
- Complements task docs in `docs/connecting.md`, `docs/exposing-http.md`, and
  `docs/making-requests.md`.

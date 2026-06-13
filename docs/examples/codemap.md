# docs/examples/

## Responsibility

Contains task-focused example architectures that combine multiple Verser2 roles
into application patterns. These examples are documentation-only and do not add
new runtime behavior.

## Design/Patterns

- **Application-owned composition:** examples show how user applications combine
  Host, Guest, and Broker APIs rather than implying built-in gateway behavior.
- **Boundary-first examples:** each example calls out what Verser2 provides and
  what the consuming application must own, such as public listeners, auth, rate
  limits, observability, and deployment topology.

## Data & Control Flow

`gateway.md` shows public HTTP requests entering a Bun-owned listener, being
rewritten to internal route hostnames, forwarded by a Broker-backed fetch helper,
and delivered through the Host to Node and Python Guests.

## Integration

- Linked from `docs/index.md` and `docs/making-requests.md`.
- Complements `docs/connecting.md`, `docs/exposing-http.md`, `docs/routes.md`,
  and `docs/certificates.md`.

# Outcomes: In-Process Local Host Peers

## Completed work

- Added in-process Host-side local Guest and local Broker attachment without opening a TLS HTTP/2 connection.
- Preserved externally observable Host routing semantics across local and H2 peers, including route registration, full route-table replacement updates, duplicate peer ID checks, route retraction, lifecycle events, and close/detach behavior.
- Added local Guest dispatch using adapted minimal HTTP request/response handling instead of the buffered direct-dispatch path as the primary local routing implementation.
- Added local Broker request routing through Host target checks and route state, supporting local Broker -> local Guest, local Broker -> H2 Guest, and H2 Broker -> local Guest flows.
- Reused existing registration authorization callbacks with Host-owned local metadata (`local: true`, `authorized: true`, no TLS certificate identity) while preserving H2 authorization metadata from TLS socket state.
- Added public Host local peer primitives and guest-node compatibility through existing Broker request/router shapes without adding runtime-specific dependencies to the Host package.
- Hardened error parity and lifecycle behavior for closed handles, pending route waiters, body stream failures, local response metadata validation, and active stream cleanup.
- Documented local peer attachment, local authorization metadata, supported routing combinations, streaming behavior, lifecycle, close/detach behavior, and boundaries.

## Validation and reviews

- Failing local registration, lifecycle, authorization, routing, streaming, API, and error-parity tests were added before implementation.
- Focused validations covered Host, Broker routing, local peers, Agent, Dispatcher, package API, and docs.
- Final validation passed with `npm test`, `npm run test:package-tarballs`, and `npm run lint`.
- Review findings led to fixes for H2 initial route snapshots, route waiter hangs on close, post-close handle use, request body stream error mapping, and response metadata validation through common helpers.

## Deferred or intentional limits

- Local peer support does not add per-request Broker target authorization, new authentication systems, HTTP/3, WebSocket/upgrade/CONNECT forwarding, trailers, informational responses, or public gateway policy.
- Local Broker route waiter/minimal HTTP shim logic remains Host-local; a future shared route-table/waiter helper may be useful if another runtime-independent Broker state emerges.

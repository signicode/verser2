# Specification: Route Revocation Events

## Overview

Implement first-class route revocation and route lifecycle observation for Verser2, based on GitHub issue #48: https://github.com/signicode/verser2/issues/48.

Today route removals are mostly implicit: Host route snapshots shrink after Guest disconnection, and Brokers replace their route table from full snapshots. This track makes route removal, route degraded/disconnected state, route restoration, and route changes observable and actionable across remote and local Guest/Broker APIs.

## Goals

- Allow Guests to revoke their own advertised routes explicitly.
- Notify Brokers of route lifecycle changes through an observational route-change API.
- Preserve Broker inability to revoke routes.
- Propagate route additions, removals, degraded/disconnected state, and restoration through Host route state and federation where applicable.
- Provide local Guest/Broker parity with remote Guest/Broker behavior.
- Cover all current runtimes and public wrappers: Node, Bun, Python, and local Host handles.

## Functional Requirements

### Guest route revocation

- Add a Guest API equivalent to `revokeRoutes(domains)` for all current Guest surfaces:
  - Node Guest.
  - Bun Guest wrapper.
  - Python Guest.
  - Local Guest handle.
- A Guest may revoke only routes it owns.
- Revoking a subset of routes must not remove the Guest’s other advertised routes.
- Revocation must update Host route state and notify interested Brokers.
- Revocation must reject or report errors for routes the Guest does not own, invalid route domains, unavailable connection state, or Host-side rejection.

### Guest-to-Host revocation transport

- Use the existing Guest control stream direction as the preferred transport for explicit revocation messages.
- Define ACK/error semantics so a Promise-returning `revokeRoutes()` can resolve only after the Host accepts the revocation or reject on failure.
- Preserve compatibility with current registration and request routing semantics.

### Broker route lifecycle events

- Add an observational Broker API equivalent to `onRouteChange(listener)` for all current Broker surfaces:
  - Node Broker.
  - Bun-facing Broker wrapper where applicable.
  - Python Broker.
  - Local Broker handle.
- Broker route events must include at least:
  - event type;
  - domain;
  - targetId / Guest peer id;
  - minimal generation/session metadata where feasible;
  - optional reason for removal, disconnection, or degraded state.
- Broker route event types must cover:
  - route added;
  - route removed/revoked;
  - route changed/replaced/restored;
  - route disconnected/degraded.
- Brokers must not gain any route revocation API.

### Wire/control model

- Add new explicit route lifecycle control frames rather than relying only on full route-table snapshots.
- Maintain compatibility with existing full route snapshot behavior where practical.
- Broker route snapshots such as `getRoutes()` must remain useful, but snapshots must not be the only way to observe removals or replacements.
- Event ordering must be deterministic enough that Broker route snapshots are consistent after processing a control frame.

### Disconnection degraded state and delayed removal

- When a Guest disconnects, its routes must immediately enter a visible degraded/disconnected state instead of being fully removed immediately.
- Brokers must receive an immediate route lifecycle event for affected routes indicating the disconnected/degraded state.
- During the degraded period, the route remains visible as degraded and requests to the affected route must fail fast with a 502-like failure rather than silently routing to a stale Guest.
- The Host must expose a Host-level configuration option for the degraded-route removal timeout, with a documented default.
- If the same Guest/target reconnects and re-registers in time, the Host must restore the affected routes, preserve stale-route safety, and emit changed/restored or added events as appropriate.
- If the timeout expires without restoration, the Host must fully remove the degraded routes and notify Brokers.

### Minimal generation/session metadata

- Add minimal Host-assigned generation/session metadata where feasible to distinguish stale route visibility from a newly restored or replaced route.
- Generation metadata should help downstream users reason about same-id restarts and reconnections.
- Full end-to-end generation semantics beyond the minimal stale-route safety requirement are not required.

### Federation and forwarding

- Forwarded/federated route changes must propagate removals and degraded/restored state the same way additions are propagated.
- A downstream Broker should receive lifecycle information for relevant federated routes when an upstream route is revoked, degraded, restored, or removed.
- The implementation should avoid unnecessary federation protocol complexity, but explicit lifecycle frames must carry enough information to satisfy the event requirements.

### Local parity

- Local Guest handles must support revoking their own routes.
- Local Brokers must receive the same route lifecycle events as remote Brokers for additions, revocations, degraded/disconnected state, restoration, and removals.
- Local Brokers must remain observational only and must not be able to revoke routes.

### Documentation

- Update public docs and package API documentation for:
  - Guest route revocation;
  - Broker route-change events;
  - degraded/disconnected route behavior;
  - delayed removal timeout configuration;
  - route snapshot versus lifecycle event semantics;
  - local/remote parity and Broker limitations.

## Non-Functional Requirements

- Preserve existing request/response HTTP semantics except for the explicit degraded-route fast-failure behavior.
- Keep shared protocol types and helpers in `@signicode/verser-common` where reusable.
- Maintain backward compatibility for existing route snapshot consumers where practical.
- Avoid granting Brokers authority to mutate route state.
- Use focused tests before implementation and preserve the repository’s coverage expectations.
- Keep behavior portable across Node, Bun wrapper, and Python implementations.

## Acceptance Criteria

- A remote Guest can revoke one or more of its own routes without closing the Guest connection.
- Revoking a route removes it from active Host route state and Broker snapshots after lifecycle processing.
- Revoking one route does not revoke other routes owned by the same Guest.
- Brokers observe route added, removed/revoked, changed/restored, and disconnected/degraded events.
- Broker event payloads include domain, targetId, event type, and minimal generation/session metadata where feasible.
- Broker APIs remain observational; Brokers cannot revoke routes.
- Guest disconnection immediately marks affected routes visible degraded/disconnected and causes route requests to fail fast with a 502-like response.
- Host delayed-removal timeout fully removes degraded routes when the Guest does not reconnect in time.
- Same Guest/target reconnection before the timeout restores affected routes and emits lifecycle events that distinguish the restored route from stale visibility.
- Local Guest revocation and Local Broker route-change observation match remote behavior.
- Federation propagates route additions, revocations/removals, degraded/disconnected state, and restoration.
- Node, Bun wrapper, and Python APIs are updated consistently.
- Tests cover remote Guest revocation, local Guest revocation, Broker route events, degraded disconnected routes, timed removal, reconnection restoration, and federated revoke propagation.
- Documentation describes the new APIs and lifecycle semantics.

## Out of Scope

- Broker-side route mutation or revocation.
- HTTP/3, browser, Rust, Go, or Java implementations.
- A complete public gateway authorization system.
- Blocking direct target-id dispatch beyond the specified route discoverability and degraded-route fast-failure semantics, unless required by the existing route path to satisfy tests.
- Comprehensive generation/session protocol beyond minimal metadata needed for stale-route safety in this track.

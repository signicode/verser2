# Specification: In-Process Local Host Peers

## Overview

Add an in-process Host-side Guest/Broker attachment capability for colocated participants such as Transform Hub Manager and STH. The feature should avoid opening a TLS HTTP/2 connection when a participant is in the same process as the Host, while preserving the same externally observable Host routing semantics as normal H2 Guest/Broker peers.

The implementation should short-wire existing Guest/Broker behavior where practical, especially Node Guest handler dispatch and Broker request surfaces, instead of creating a divergent local-only behavior path. The current TLS H2 path remains supported and acceptable for remote participants.

## Functional Requirements

- The Host must support registering local Guests without an H2 connection.
- The Host must support registering local Brokers without an H2 connection.
- Local Guest registration must advertise routed domains through the existing Host route table.
- Local Broker route discovery must receive the same full route table semantics as H2 Brokers.
- Local peers must participate in duplicate peer ID checks together with H2 peers.
- Closing or detaching a local Guest must retract its routes and notify Brokers.
- Closing or detaching a local Broker must stop local Broker operations without affecting unrelated peers.
- Local Broker requests must route through Host targeting rules rather than bypassing Host route state.
- These routing combinations must work:
  - local Broker to local Guest
  - local Broker to H2 Guest
  - H2 Broker to local Guest
- Request and response body streaming must be preserved for local peers. The implementation must not rely on the existing buffered direct-dispatch path as the primary local routing mechanism.
- Existing Node Guest handler ergonomics should be reused where practical, including normal `http.Server`/request-listener attachment behavior without calling `listen()`.
- Existing Broker request ergonomics should be reused where practical, including compatibility with the existing request path and higher-level routing helpers where feasible.
- Local registration authorization must reuse the existing registration authorization callback.
- For local peers, authorization context metadata must be Host-owned and not caller-tamperable. It should identify the registration as local, for example with `local: true` and `authorized: true`, and should provide no TLS certificate identity.
- H2 peer authorization metadata must remain derived from Host-side TLS socket state and must not become caller-controlled.
- Error behavior should match H2 routing behavior as closely as possible, including missing target, duplicate registration, disconnected target, timeout, local handler failure, and stream/cancellation errors.
- Host lifecycle events should remain meaningful for local peers and should use existing lifecycle event names where applicable.

## Non-Functional Requirements

- Preserve existing public TLS H2 Guest/Broker behavior.
- Keep Host/Guest/Broker terminology precise.
- Prefer shared or transport-neutral abstractions over duplicated local-only protocol logic.
- Keep the Host package free of runtime-specific dependencies that belong in guest-node, such as `undici`, unless already present.
- Maintain streaming and backpressure behavior where Node streams support it.
- Keep changes incremental and test-driven.

## Acceptance Criteria

- Tests prove local Guest route registration and route retraction.
- Tests prove local Broker route discovery and `waitForRoute`-style behavior where exposed.
- Tests prove duplicate peer IDs are rejected across local and H2 peers.
- Tests prove local Broker to local Guest request routing with method, path, headers, status, and body preserved.
- Tests prove local Broker to H2 Guest request routing.
- Tests prove H2 Broker to local Guest request routing.
- Tests prove request and response bodies stream through local peer routing without using the buffered direct-dispatch path.
- Tests prove local handler errors map to Broker-visible errors consistently with H2 lease behavior.
- Tests prove local Guest close/detach retracts routes and fails or prevents subsequent requests.
- Tests prove local peer registration authorization calls the existing callback with Host-owned local metadata and rejects when the callback returns `close`.
- Existing H2 integration tests continue to pass.
- Documentation or API docs describe local peer attachment, authorization metadata, lifecycle, and boundaries.

## Out of Scope

- Per-request Broker target authorization.
- New authentication systems beyond existing registration authorization.
- HTTP/3, browser, Rust, Go, Java, or Python Host behavior.
- Public gateway policy, rate limiting, or application-level access control.
- WebSocket, HTTP upgrade, CONNECT tunneling, trailers, or informational response forwarding unless already supported by the existing path.
- Replacing the existing TLS H2 Guest/Broker transport.

# Specification: Streaming Improvements

## Overview

Improve Verser2 HTTP streaming semantics across the existing Host/Guest/Broker paths, including abort propagation, backpressure, half-open stream behavior, upstream/federated streaming robustness, and keep-alive behavior for long-lived waiting streams. This track also includes WebSocket support as a late, gated phase within the same track, and prunes roadmap/documentation claims for CONNECT tunneling, generic L4 forwarding, Python Host, and Python-side fetch/Agent/Dispatcher helpers. Python remains scoped to ASGI Guest/Broker behavior.

The track treats “chunked encoding” as semantic streaming: preserve byte streaming, flush/backpressure behavior, and application write boundaries where practical. It does not require forwarding literal HTTP/1 `Transfer-Encoding: chunked` frames through HTTP/2, because HTTP/2 represents payloads as DATA frames and strips hop-by-hop transfer framing.

## Functional Requirements

1. Improve HTTP request and response streaming across these surfaces:
   - Host routing between Broker and Guest lease streams.
   - Node Guest and Node Broker `request()` paths.
   - Node Agent and Dispatcher/fetch paths.
   - Local peer request/response paths.
   - Host-to-Host upstream/federated forwarding paths.
   - Bun wrapper parity where the underlying Node transport supports the behavior.
   - Python ASGI HTTP streaming, without adding Python Host, Python fetch helper, Python Agent, or Python Dispatcher APIs.
2. Preserve semantic streaming behavior:
   - Avoid buffering full request/response bodies when streaming is possible.
   - Preserve streaming flush/write boundaries where practical, but do not promise literal HTTP/1 chunk-frame preservation across HTTP/2.
   - Preserve Node/Bun/Python runtime-compatible body streaming semantics.
3. Harden abort propagation:
   - Broker request aborts should cancel Guest lease/request work and clean up Host state.
   - Guest response aborts should cancel or fail the Broker response path with structured diagnostics.
   - Federation/upstream aborts should propagate across Host-to-Host forwarding without leaking streams or waiters.
   - Abort signals for Agent/Dispatcher/fetch paths should map to the remote request path where feasible.
4. Define and test half-open stream behavior:
   - Request body completion while response remains open.
   - Response completion/failure while request upload is ending or cancelled.
   - Route revocation, Guest disconnect, Broker disconnect, and upstream disconnect during an active stream.
5. Improve keep-alive/liveness behavior for long-lived waiting sockets/streams:
   - Clarify and test idle lease/upstream waiting behavior.
   - Avoid leaks for waiting leases, upstream requests, and half-open streams.
   - Preserve existing HTTP/2 transport semantics unless a specific option is introduced and documented.
6. Include WebSocket support as a late gated phase:
   - First design the WebSocket strategy, including HTTP/1.1 upgrade versus HTTP/2 RFC 8441 extended CONNECT constraints, full-duplex lifecycle, close codes, ping/pong, backpressure, aborts, and runtime parity expectations.
   - Implement WebSocket support only after the design gate is approved during the track.
   - Ensure WebSocket docs/API claims match the implemented runtime surface.
7. Prune roadmap and docs:
   - Remove CONNECT tunneling and generic L4 forwarding from roadmap/future-work claims.
   - Remove Python Host from roadmap/future-work claims.
   - Remove Python fetch helper, Agent, and Dispatcher helper roadmap/future claims.
   - Keep Python ASGI Guest/Broker as the Python scope.
   - Update README, docs, package READMEs, and codemaps to match the new streaming/WebSocket support and removed roadmap items.

## Non-Functional Requirements

1. Preserve existing public API compatibility unless a WebSocket phase explicitly introduces reviewed API additions.
2. Preserve HTTP method, path, headers, status, body, streaming, lifecycle, and structured-error semantics except where this specification explicitly changes them.
3. Do not introduce CONNECT tunneling, generic L4 forwarding, HTTP/3, trailers, or informational response forwarding.
4. Maintain backpressure and avoid unbounded buffering for large or long-lived streams.
5. Ensure stream, lease, waiter, and upstream cleanup is deterministic on success, abort, timeout, route revocation, and disconnect.
6. Keep reusable protocol-neutral helpers in `@signicode/verser-common` only when they are genuinely cross-package and runtime-neutral.
7. Maintain TypeScript strictness, lint cleanliness, and meaningful coverage for changed behavior.

## Acceptance Criteria

1. New or updated tests prove large streaming request and response bodies do not require full-body buffering on supported paths.
2. Tests cover slow producer/consumer backpressure, Broker abort, Guest abort, upstream/federated abort, disconnect during active stream, route revocation during stream, and half-open request/response behavior.
3. Node Agent and Dispatcher/fetch streaming and abort behavior are covered where applicable.
4. Python ASGI HTTP streaming behavior is covered without adding Python Host/fetch/Agent/Dispatcher APIs.
5. Bun wrapper behavior is documented and tested where parity is supported by the shared Node transport.
6. WebSocket support has a documented design gate and, once implemented, tests for lifecycle, close, abort, and backpressure behavior on the implemented runtime surface.
7. Roadmap and documentation no longer present CONNECT/L4 forwarding, Python Host, or Python fetch/Agent/Dispatcher helpers as future implementation targets.
8. Final validation passes with focused package/test commands plus full repository test and lint validation.

## Out of Scope

1. Literal preservation of HTTP/1 `Transfer-Encoding: chunked` framing across HTTP/2.
2. CONNECT tunneling, extended CONNECT as a generic tunnel, and generic L4 forwarding.
3. HTTP/3/QUIC transport.
4. Trailers and informational response forwarding.
5. Python Host implementation.
6. Python fetch helper, Python Agent, and Python Dispatcher APIs.
7. Turning Verser2 into a complete public gateway or adding built-in application authentication/authorization policy.

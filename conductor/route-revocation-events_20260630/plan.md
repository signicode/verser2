# Implementation Plan: Route Revocation Events

## Phase 1: Track Execution Setup and Baseline Review

- [x] Task: Create implementation branch during implementation execution
    - [x] Captured `main` as the PR base branch.
    - [x] Created the implementation branch `conductor/route-revocation-events_20260630` from the current HEAD.
    - [x] Pushed the implementation branch immediately so branch-protected `main` does not need to receive track changes directly.
    - [x] Opened the initial draft PR immediately using the track `spec.md` as the PR body.
    - [x] Draft PR URL: https://github.com/signicode/verser2/pull/49
    - [x] Do not make granular start-marker commits beyond the Conductor track setup commit already used to create the review surface.
    - [x] Perform implementation work on this branch and keep future checkpointing on the draft PR.
- [x] Task: Review common route and control-frame foundations
    - [x] Inspected `packages/verser-common` for existing route, control-frame, lifecycle event, error, and NDJSON helpers to reuse.
    - [x] Inspected Host route registry, local peer, registration, Broker advertisement, upstream federation, Node Guest/Broker, Bun wrapper, and Python Guest/Broker route handling.
    - [x] Recorded reusable common primitives and intentional package-specific behavior before implementation tasks begin.
    - [x] Phase 1 notes: reuse common NDJSON helpers and `VerserBrokerControlFrame`/registration factory patterns for route lifecycle frames; extend common lifecycle constants for route removed/changed/degraded events.
    - [x] Phase 1 notes: `HostRouteRegistry` stores routes by peer and currently supports whole-peer set/remove only, so per-domain revocation needs registry support rather than repeated package-local filtering.
    - [x] Phase 1 notes: remote and local Broker route-change events require diffing or explicit lifecycle-frame processing because existing route snapshots are full replacements.
    - [x] Phase 1 notes: federation already propagates shorter full-route replacements, but explicit lifecycle propagation needs careful compatibility with existing `federated-routes` control handling.
    - [x] Phase 1 notes: existing Guest control stream is Host-read-only in practice; ACK/error semantics over that stream require bidirectional Guest control-stream reading, while a new request/response path would be simpler but deviates from the accepted preference.
    - [x] Phase 1 notes: use a Host option such as `degradedRouteTimeoutMs`; user approved `5000` ms as the default.
- [x] Task: Confirm implementation semantics before public API changes
    - [x] Confirmed Guest revocation should use a dedicated request/response path such as `POST /verser/guest/revoke` instead of bidirectional control-stream ACKs.
    - [x] Confirmed Broker lifecycle control-frame event types should cover added, removed/revoked, changed/restored, and disconnected/degraded.
    - [x] Confirmed Host degraded-route removal timeout option default should be `5000` ms.
    - [x] Paused for user review before making public API, wire protocol, and Host option changes.
- [x] Task: Conductor - Phase Checkpoint 'Track Execution Setup and Baseline Review' (Protocol in workflow.md)
    - [x] Completed Phase 1 review against the phase goal and recorded implementation-decision notes.
    - [x] Confirmed common libraries and shared control-frame helpers were scanned for reuse.
    - [x] Deduplication result: no product code changed; shared-first decisions recorded for Phase 2.
    - [x] Validation: no product-code tests required for planning-only Phase 1; verified draft PR availability.
    - [x] Phase checkpoint commit: represented by the latest pushed PR head for https://github.com/signicode/verser2/pull/49 under the amended single-commit policy.

## Phase 2: Shared Protocol, Types, and Route Registry Tests

- [x] Task: Write failing common protocol tests
    - [x] Add tests for explicit route lifecycle control frame preservation and validation.
    - [x] Add tests for Guest revocation request/response messages and ACK/error response shapes.
    - [x] Add tests for minimal generation/session metadata propagation where common types cover it.
- [x] Task: Write failing Host route registry tests
    - [x] Cover per-peer subset revocation without removing unrelated routes.
    - [x] Cover route degraded/disconnected state, restoration, and final timed removal state transitions.
    - [x] Cover generation/session metadata changes for restored routes.
- [x] Task: Implement shared protocol and route registry foundations
    - [x] Add reusable shared types/constants/helpers in `@signicode/verser-common` for route lifecycle frames, Guest revocation frames, ACK/error responses, event reasons, and minimal generation metadata.
    - [x] Extend Host route registry behavior for per-route revocation, degraded route state, restoration, and timed removal support.
    - [x] Preserve full route snapshot compatibility for existing Broker route consumers where practical.
- [x] Task: Validate shared protocol and registry changes
    - [x] Run the narrowest relevant common protocol and route registry tests: `node --test test/common-protocol.test.js test/host-route-registry.test.js` passed 60/60.
    - [x] Run TypeScript build checks needed for changed common/Host type surfaces: common build passed; host build passed after rerunning sequentially because the first parallel attempt raced with common declaration generation.
    - [x] Record coverage applicability and deduplication result: tests added for changed behavior; shared protocol helpers centralized in `@signicode/verser-common`; no duplicated route lifecycle helper code identified.
- [x] Task: Conductor - Phase Checkpoint 'Shared Protocol, Types, and Route Registry Tests' (Protocol in workflow.md)
    - [x] Reviewed completed Phase 2 tasks against shared protocol and registry foundation goals.
    - [x] Confirmed common libraries were scanned and reused/adapted.
    - [x] Performed deduplication check; reusable protocol and route lifecycle helpers live in `@signicode/verser-common`.
    - [x] Validation passed with focused tests and sequential workspace builds.

## Phase 3: Host Remote Control, Broker Events, and Degraded Routing

- [x] Task: Write failing Host and Node Broker integration tests
    - [x] Cover remote Guest `revokeRoutes()` over the dedicated Guest revocation request path with ACK/error behavior.
    - [x] Cover Broker `onRouteChange()` events for added, removed/revoked, changed/restored, and disconnected/degraded routes.
    - [x] Cover immediate degraded state on Guest disconnection and fast 502-like failure for degraded route requests.
    - [x] Cover Host-level delayed-removal timeout and full removal after timeout expiry.
    - [x] Cover same Guest/target reconnection before timeout restoring routes and emitting lifecycle events.
    - [x] Added regression coverage for spoofed `x-verser-peer-id` revocation attempts and empty/different-domain reconnects.
- [x] Task: Implement Host remote route lifecycle handling
    - [x] Handle Guest revocation messages on the dedicated Guest revocation request path.
    - [x] Enforce ownership checks so Guests can revoke only their own routes, including HTTP/2 session binding for wire-level spoof protection.
    - [x] Update Host route registry, route advertisements, lifecycle frame broadcasts, and request routing for revoked/degraded/restored routes.
    - [x] Add Host-level degraded route removal timeout option with documented default.
- [x] Task: Implement Node Broker route-change observation
    - [x] Add public observational `onRouteChange()` API to Node Broker types and implementation.
    - [x] Process new route lifecycle control frames and update Broker snapshots consistently.
    - [x] Emit event payloads with domain, targetId, event type, minimal generation/session metadata, and optional reason.
    - [x] Ensure Broker surfaces do not expose route revocation authority.
- [x] Task: Implement Node Guest revocation API
    - [x] Add public `revokeRoutes(domains)` API to Node Guest types and implementation.
    - [x] Send revocation requests and resolve/reject based on Host ACK/error responses.
    - [x] Handle invalid domains, closed connections, Host rejection, and partial subset revocation errors deterministically.
- [x] Task: Validate Host and Node behavior
    - [x] Run focused route-related Node tests: `node --test test/common-protocol.test.js test/host-route-registry.test.js test/broker-routing.test.js test/host.test.js test/local-peers.test.js` passed 125/125.
    - [x] Run narrow build/type checks for changed common, Host, and Node Guest packages: sequential builds passed for common, host, and guest-node; follow-up host/guest-node builds passed after tightened tests.
    - [x] Record coverage and deduplication result: Phase 3 route lifecycle behavior has focused regression coverage; shared types/helpers remain centralized in `@signicode/verser-common`.
    - [x] Review result: @oracle found no remaining P0/P1 blockers and cleared Phase 3 for manual verification.
- [x] Task: Conductor - User Manual Verification 'Host Remote Control, Broker Events, and Degraded Routing' (Protocol in workflow.md)
    - [x] Ensured the draft PR was pushed and current before requesting manual verification.
    - [x] Returned the PR URL with the Phase 3 validation summary.
    - [x] User approved proceeding to Phase 4.

## Phase 4: Local Guest/Broker Parity

- [x] Task: Write failing local parity tests
    - [x] Cover local Guest subset route revocation.
    - [x] Cover local Broker route-change events for added, removed/revoked, changed/restored, and disconnected/degraded routes.
    - [x] Cover local Guest close causing degraded state, timeout removal, and restoration where applicable.
    - [x] Confirm local Broker cannot revoke routes.
- [x] Task: Implement local Guest and Broker route lifecycle APIs
    - [x] Add `revokeRoutes(domains)` to the local Guest handle.
    - [x] Add local Broker route-change subscription support matching remote event payload semantics.
    - [x] Route local lifecycle updates through the same shared Host route registry and event helpers where practical.
    - [x] Preserve existing local `getRoutes()` behavior while adding lifecycle events.
- [x] Task: Validate local parity
    - [x] Run focused local peer tests: `node --test test/local-peers.test.js test/host.test.js test/host-route-registry.test.js` passed 46/46.
    - [x] Run narrow build/type checks for changed Host/local peer APIs: `npm run build --workspace=@signicode/verser2-host` passed.
    - [x] Record coverage and deduplication result: local parity behavior covered by focused local peer tests; shared registry/lifecycle helpers reused.
- [x] Task: Conductor - Phase Checkpoint 'Local Guest/Broker Parity' (Protocol in workflow.md)
    - [x] Reviewed completed Phase 4 tasks against local parity goals.
    - [x] Confirmed common Host route registry and route lifecycle helpers were reused.
    - [x] Performed deduplication check; no duplicated route lifecycle implementation identified.
    - [x] Validation passed with focused tests and host build.

## Phase 5: Federation and Forwarded Route Lifecycle Propagation

- [x] Task: Write failing federation propagation tests
    - [x] Cover explicit revocation propagating across upstream/downstream route forwarding.
    - [x] Cover degraded/disconnected route state propagation for federated routes.
    - [x] Cover restoration before timeout and full removal after timeout for federated routes.
    - [x] Cover Broker event payloads for federated lifecycle changes.
- [x] Task: Implement federated route lifecycle propagation
    - [x] Extend federation control handling to propagate explicit route lifecycle frames where required.
    - [x] Keep full snapshot export/import compatibility where practical.
    - [x] Preserve route ownership/source identity so downstream Brokers can distinguish stale from restored routes.
    - [x] Avoid unnecessary federation protocol complexity beyond the accepted lifecycle semantics.
- [x] Task: Validate federation behavior
    - [x] Run focused upstream/federation tests: `node --test test/host-upstreams.test.js test/host-route-registry.test.js` passed 49/49.
    - [x] Run narrow build/type checks for changed Host and common protocol surfaces: `npm run build --workspace=@signicode/verser2-host` passed.
    - [x] Record coverage and deduplication result: federation lifecycle behavior covered by focused upstream/registry tests; existing shared lifecycle helpers reused.
- [x] Task: Conductor - Phase Checkpoint 'Federation and Forwarded Route Lifecycle Propagation' (Protocol in workflow.md)
    - [x] Reviewed completed Phase 5 tasks against federation propagation goals.
    - [x] Confirmed shared registry and lifecycle-frame helpers were reused/adapted.
    - [x] Performed deduplication check; no duplicate federation lifecycle protocol helpers identified.
    - [x] Validation passed with focused federation tests and host build.

## Phase 6: Bun and Python API Parity

- [x] Task: Write failing Bun and Python parity tests
    - [x] Cover Bun wrapper exposure of Guest `revokeRoutes()` and Broker route-change observation where applicable.
    - [x] Cover Python Guest `revoke_routes()` revocation ACK/error behavior.
    - [x] Cover Python Broker route-change event subscription and route snapshot consistency.
    - [x] Cover Python/Bun behavior for degraded/disconnected and restored routes when routed through the Host.
- [x] Task: Implement Bun wrapper parity
    - [x] Update Bun Guest/Broker public types and wrappers to expose the new route revocation and route-change APIs consistently with Node internals.
    - [x] Preserve Bun-facing naming and runtime ergonomics.
- [x] Task: Implement Python Guest/Broker parity
    - [x] Add Python Guest route revocation API and request/response revocation handling.
    - [x] Add Python Broker route-change subscription support and lifecycle control-frame handling.
    - [x] Keep Python route snapshots consistent after lifecycle frames.
- [x] Task: Validate Bun and Python parity
    - [x] Run focused Bun wrapper tests: `npm run test --workspace=@signicode/verser2-guest-bun` passed 15/15.
    - [x] Run focused Python tests: `uv run pytest` in `packages/verser2-guest-python` passed 78/78.
    - [x] Run build/type checks needed for changed public exports: `npm run build --workspace=@signicode/verser2-guest-bun` passed.
    - [x] Record coverage and deduplication result: Bun wrapper delegates to Node internals; Python lifecycle handling covered by focused unit tests; Python dev dependency changes approved by user.
- [x] Task: Conductor - Phase Checkpoint 'Bun and Python API Parity' (Protocol in workflow.md)
    - [x] Reviewed completed Phase 6 tasks against Bun/Python parity goals.
    - [x] Confirmed shared protocol constants and frame shapes were reused across runtime implementations.
    - [x] Performed deduplication check; runtime-specific adapters remain thin around shared protocol shapes where practical.
    - [x] Validation passed with focused Bun/Python tests and Bun build.

## Phase 7: Documentation, Review, and Final Validation

- [x] Task: Update documentation and public API references
    - [x] Document Guest route revocation APIs for Node, Bun, Python, and local Guest handles.
    - [x] Document Broker `onRouteChange()` events and event payload semantics.
    - [x] Document snapshot versus lifecycle event behavior.
    - [x] Document degraded/disconnected route state, fast-failure behavior, Host timeout configuration, and restoration semantics.
    - [x] Document Broker observational-only limitations.
    - [x] Validation: `node --test test/docs.test.js` passed 5/5.
- [x] Task: Run code review and simplification pass
    - [x] Delegate a maintainability/API review to the configured review specialist after implementation is complete.
    - [x] Address review findings that are in scope and safe.
    - [x] Re-run focused validation for any review-driven changes: docs, broker routing, host/local/registry focused tests and build passed in delegated validation.
- [x] Task: Run final validation
    - [x] Run the narrowest complete validation set proving the track, escalating to `npm run test`, `npm run build`, and `npm run lint` if narrower commands are insufficient.
    - [x] Confirm tests cover remote revocation, local revocation, Broker events, degraded disconnection, timed removal, restoration, federation propagation, Bun wrapper parity, and Python parity.
    - [x] Confirm coverage expectations or record justified exceptions: changed behavior is covered by focused unit/integration tests plus full repository validation.
    - [x] Confirm common-library reuse and deduplication results: shared route lifecycle/revocation protocol helpers are centralized in `@signicode/verser-common`.
- [~] Task: Branching Policy finalization
    - [~] Create one final implementation commit with all track changes.
    - [ ] Push the implementation branch.
    - [ ] Update the existing draft PR, or create it if it does not already exist, targeting the captured base branch using the track `spec.md` as the PR body.
    - [ ] Post final verification results as a PR comment.
    - [ ] Mark the PR ready only after final verification is complete.
- [ ] Task: Conductor - Phase Checkpoint 'Documentation, Review, and Final Validation' (Protocol in workflow.md)

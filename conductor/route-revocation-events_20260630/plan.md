# Implementation Plan: Route Revocation Events

## Phase 1: Track Execution Setup and Baseline Review

- [ ] Task: Create implementation branch during implementation execution
    - [ ] Capture the current branch as the PR base branch.
    - [ ] Create the implementation branch `conductor/route-revocation-events_20260630` from the current HEAD.
    - [ ] Push the implementation branch immediately so branch-protected `main` does not need to receive track changes directly.
    - [ ] Open the initial draft PR immediately using the track `spec.md` as the PR body.
    - [ ] Draft PR URL: https://github.com/signicode/verser2/pull/49
    - [ ] Do not make granular start-marker commits beyond the Conductor track setup commit already used to create the review surface.
    - [ ] Perform implementation work on this branch and keep future checkpointing on the draft PR.
- [ ] Task: Review common route and control-frame foundations
    - [ ] Inspect `packages/verser-common` for existing route, control-frame, lifecycle event, error, and NDJSON helpers to reuse.
    - [ ] Inspect Host route registry, local peer, registration, Broker advertisement, upstream federation, Node Guest/Broker, Bun wrapper, and Python Guest/Broker route handling.
    - [ ] Record reusable common primitives and any intentional package-specific behavior in this plan before implementation tasks begin.
- [ ] Task: Confirm implementation semantics before public API changes
    - [ ] Confirm Guest control-stream ACK/error message shape for `revokeRoutes()`.
    - [ ] Confirm Broker lifecycle control-frame event types and payload fields.
    - [ ] Confirm degraded route request failure shape and default Host timeout value.
    - [ ] Pause for user review before making public API, wire protocol, and Host option changes.
- [ ] Task: Conductor - Phase Checkpoint 'Track Execution Setup and Baseline Review' (Protocol in workflow.md)

## Phase 2: Shared Protocol, Types, and Route Registry Tests

- [ ] Task: Write failing common protocol tests
    - [ ] Add tests for explicit route lifecycle control frame preservation and validation.
    - [ ] Add tests for Guest revocation control messages and ACK/error response shapes.
    - [ ] Add tests for minimal generation/session metadata propagation where common types cover it.
- [ ] Task: Write failing Host route registry tests
    - [ ] Cover per-peer subset revocation without removing unrelated routes.
    - [ ] Cover route degraded/disconnected state, restoration, and final timed removal state transitions.
    - [ ] Cover generation/session metadata changes for restored routes.
- [ ] Task: Implement shared protocol and route registry foundations
    - [ ] Add reusable shared types/constants/helpers in `@signicode/verser-common` for route lifecycle frames, Guest revocation frames, ACK/error responses, event reasons, and minimal generation metadata.
    - [ ] Extend Host route registry behavior for per-route revocation, degraded route state, restoration, and timed removal support.
    - [ ] Preserve full route snapshot compatibility for existing Broker route consumers where practical.
- [ ] Task: Validate shared protocol and registry changes
    - [ ] Run the narrowest relevant common protocol and route registry tests.
    - [ ] Run TypeScript build checks needed for changed common/Host type surfaces.
    - [ ] Record coverage applicability and deduplication result.
- [ ] Task: Conductor - Phase Checkpoint 'Shared Protocol, Types, and Route Registry Tests' (Protocol in workflow.md)

## Phase 3: Host Remote Control, Broker Events, and Degraded Routing

- [ ] Task: Write failing Host and Node Broker integration tests
    - [ ] Cover remote Guest `revokeRoutes()` over the Guest control stream with ACK/error behavior.
    - [ ] Cover Broker `onRouteChange()` events for added, removed/revoked, changed/restored, and disconnected/degraded routes.
    - [ ] Cover immediate degraded state on Guest disconnection and fast 502-like failure for degraded route requests.
    - [ ] Cover Host-level delayed-removal timeout and full removal after timeout expiry.
    - [ ] Cover same Guest/target reconnection before timeout restoring routes and emitting lifecycle events.
- [ ] Task: Implement Host remote route lifecycle handling
    - [ ] Handle Guest revocation messages on the Guest control stream.
    - [ ] Enforce ownership checks so Guests can revoke only their own routes.
    - [ ] Update Host route registry, route advertisements, lifecycle frame broadcasts, and request routing for revoked/degraded/restored routes.
    - [ ] Add Host-level degraded route removal timeout option with documented default.
- [ ] Task: Implement Node Broker route-change observation
    - [ ] Add public observational `onRouteChange()` API to Node Broker types and implementation.
    - [ ] Process new route lifecycle control frames and update Broker snapshots consistently.
    - [ ] Emit event payloads with domain, targetId, event type, minimal generation/session metadata, and optional reason.
    - [ ] Ensure Broker surfaces do not expose route revocation authority.
- [ ] Task: Implement Node Guest revocation API
    - [ ] Add public `revokeRoutes(domains)` API to Node Guest types and implementation.
    - [ ] Send control-stream revocation messages and resolve/reject based on Host ACK/error responses.
    - [ ] Handle invalid domains, closed connections, Host rejection, and partial subset revocation errors deterministically.
- [ ] Task: Validate Host and Node behavior
    - [ ] Run focused route-related Node tests such as `node --test test/broker-routing.test.js` and `node --test test/common-protocol.test.js` or narrower equivalent commands.
    - [ ] Run the narrowest build/type checks for changed common, Host, and Node Guest packages.
    - [ ] Record coverage and deduplication result.
- [ ] Task: Conductor - User Manual Verification 'Host Remote Control, Broker Events, and Degraded Routing' (Protocol in workflow.md)
    - [ ] Ensure the draft PR is pushed and current before requesting manual verification.
    - [ ] Return the PR URL with the Phase 3 validation summary.
    - [ ] Wait for user confirmation before proceeding to local parity, federation, Bun, or Python follow-up phases.

## Phase 4: Local Guest/Broker Parity

- [ ] Task: Write failing local parity tests
    - [ ] Cover local Guest subset route revocation.
    - [ ] Cover local Broker route-change events for added, removed/revoked, changed/restored, and disconnected/degraded routes.
    - [ ] Cover local Guest close causing degraded state, timeout removal, and restoration where applicable.
    - [ ] Confirm local Broker cannot revoke routes.
- [ ] Task: Implement local Guest and Broker route lifecycle APIs
    - [ ] Add `revokeRoutes(domains)` to the local Guest handle.
    - [ ] Add local Broker route-change subscription support matching remote event payload semantics.
    - [ ] Route local lifecycle updates through the same shared Host route registry and event helpers where practical.
    - [ ] Preserve existing local `getRoutes()` behavior while adding lifecycle events.
- [ ] Task: Validate local parity
    - [ ] Run focused local peer tests such as `node --test test/local-peers.test.js`.
    - [ ] Run narrow build/type checks for changed Host/local peer APIs.
    - [ ] Record coverage and deduplication result.
- [ ] Task: Conductor - Phase Checkpoint 'Local Guest/Broker Parity' (Protocol in workflow.md)

## Phase 5: Federation and Forwarded Route Lifecycle Propagation

- [ ] Task: Write failing federation propagation tests
    - [ ] Cover explicit revocation propagating across upstream/downstream route forwarding.
    - [ ] Cover degraded/disconnected route state propagation for federated routes.
    - [ ] Cover restoration before timeout and full removal after timeout for federated routes.
    - [ ] Cover Broker event payloads for federated lifecycle changes.
- [ ] Task: Implement federated route lifecycle propagation
    - [ ] Extend federation control handling to propagate explicit route lifecycle frames where required.
    - [ ] Keep full snapshot export/import compatibility where practical.
    - [ ] Preserve route ownership/source identity so downstream Brokers can distinguish stale from restored routes.
    - [ ] Avoid unnecessary federation protocol complexity beyond the accepted lifecycle semantics.
- [ ] Task: Validate federation behavior
    - [ ] Run focused upstream/federation tests such as `node --test test/host-upstreams.test.js` and `node --test test/host-route-registry.test.js` or narrower equivalents.
    - [ ] Run narrow build/type checks for changed Host and common protocol surfaces.
    - [ ] Record coverage and deduplication result.
- [ ] Task: Conductor - Phase Checkpoint 'Federation and Forwarded Route Lifecycle Propagation' (Protocol in workflow.md)

## Phase 6: Bun and Python API Parity

- [ ] Task: Write failing Bun and Python parity tests
    - [ ] Cover Bun wrapper exposure of Guest `revokeRoutes()` and Broker route-change observation where applicable.
    - [ ] Cover Python Guest `revoke_routes()` revocation ACK/error behavior.
    - [ ] Cover Python Broker route-change event subscription and route snapshot consistency.
    - [ ] Cover Python/Bun behavior for degraded/disconnected and restored routes when routed through the Host.
- [ ] Task: Implement Bun wrapper parity
    - [ ] Update Bun Guest/Broker public types and wrappers to expose the new route revocation and route-change APIs consistently with Node internals.
    - [ ] Preserve Bun-facing naming and runtime ergonomics.
- [ ] Task: Implement Python Guest/Broker parity
    - [ ] Add Python Guest route revocation API and control-stream message handling.
    - [ ] Add Python Broker route-change subscription support and lifecycle control-frame handling.
    - [ ] Keep Python route snapshots consistent after lifecycle frames.
- [ ] Task: Validate Bun and Python parity
    - [ ] Run focused Bun wrapper tests if present or the narrowest package validation covering Bun wrapper exports.
    - [ ] Run focused Python tests such as `uv run pytest` in `packages/verser2-guest-python` or the repository’s narrow equivalent.
    - [ ] Run build/type checks needed for changed public exports.
    - [ ] Record coverage and deduplication result.
- [ ] Task: Conductor - Phase Checkpoint 'Bun and Python API Parity' (Protocol in workflow.md)

## Phase 7: Documentation, Review, and Final Validation

- [ ] Task: Update documentation and public API references
    - [ ] Document Guest route revocation APIs for Node, Bun, Python, and local Guest handles.
    - [ ] Document Broker `onRouteChange()` events and event payload semantics.
    - [ ] Document snapshot versus lifecycle event behavior.
    - [ ] Document degraded/disconnected route state, fast-failure behavior, Host timeout configuration, and restoration semantics.
    - [ ] Document Broker observational-only limitations.
- [ ] Task: Run code review and simplification pass
    - [ ] Delegate a maintainability/API review to the configured review specialist after implementation is complete.
    - [ ] Address review findings that are in scope and safe.
    - [ ] Re-run focused validation for any review-driven changes.
- [ ] Task: Run final validation
    - [ ] Run the narrowest complete validation set proving the track, escalating to `npm run test`, `npm run build`, and `npm run lint` if narrower commands are insufficient.
    - [ ] Confirm tests cover remote revocation, local revocation, Broker events, degraded disconnection, timed removal, restoration, federation propagation, Bun wrapper parity, and Python parity.
    - [ ] Confirm coverage expectations or record justified exceptions.
    - [ ] Confirm common-library reuse and deduplication results.
- [ ] Task: Branching Policy finalization
    - [ ] Create one final implementation commit with all track changes.
    - [ ] Push the implementation branch.
    - [ ] Update the existing draft PR, or create it if it does not already exist, targeting the captured base branch using the track `spec.md` as the PR body.
    - [ ] Post final verification results as a PR comment.
    - [ ] Mark the PR ready only after final verification is complete.
- [ ] Task: Conductor - Phase Checkpoint 'Documentation, Review, and Final Validation' (Protocol in workflow.md)

# Implementation Plan: Host Implementation Large File Split

## Phase 1: Track Setup and Refactor Baseline

- [x] Task: Create implementation branch and PR review surface
    - [x] Capture the current branch as the PR base branch.
    - [x] Create the implementation branch with name `conductor/host_implementation_large_file_split_20260704` or a sanitized equivalent.
    - [x] Do NOT make granular start-marker commits or open a PR early during planning or track creation.
    - [x] Perform implementation work on this branch, making commits according to the resolved commit frequency policy: per task.
    - [ ] Open or update a draft PR targeting the captured base branch when the Branching Policy requires PR visibility or finalization.
- [x] Task: Establish source and behavior baseline
    - [x] Read `packages/verser2-host/codemap.md` and any Host library codemap before editing Host internals.
    - [x] Inspect `packages/verser2-host/src/lib/node-http2-verser-host.ts`, `route-registry.ts`, `local-peers.ts`, `types.ts`, and `http2-io.ts` for current boundaries and dependency direction.
    - [x] Record the intended extraction boundaries in this plan before implementation: federation/upstream handling, broker routing, Guest lease pool, and degraded-route cleanup.
        - Baseline responsibility map: `node-http2-verser-host.ts` currently owns private state shapes, peer/session registration, inbound and outbound federation links, federated route/request stream handling, local and HTTP/2 Broker request routing, route advertisements, degraded-route cleanup timers, Guest control/revocation, lease stream attachment, and lease pool state.
        - Intended extraction boundaries: `lease-pool.ts` for idle/active leases, acquisition queues, lease removal, timeout, and close/failure cleanup; `degraded-route-cleanup.ts` for timer start/stop and expired degraded-route checks with Host-owned callbacks; `broker-routing.ts` for Broker request dispatch, local lease routing, federated fallback/acquisition, cancellation propagation, and structured error preservation; federation/upstream helpers for upstream lifecycle, inbound federation handshake/streams, route frames, lifecycle forwarding, and federated request stream acquisition.
        - Dependency direction to preserve: `node-http2-verser-host.ts` remains the orchestrator and imports Host-internal leaf modules. Extracted modules must not import the Host class; dependencies should be passed through explicit callback/state interfaces to avoid cycles.
        - Common-library reuse decision: existing `@signicode/verser-common` protocol helpers, constants, route/federation factories, envelope/header utilities, TLS helpers, route-generation helpers, and loop/hop validation remain reused. New extraction logic stays Host-internal because it manages Node HTTP/2 stream/session state, Host-private lifecycle maps, lease queues, degraded-route timers, and federation link ownership.
    - [x] Confirm no public exports from `packages/verser2-host/src/index.ts` need to change.
- [x] Task: Write or update characterization tests before implementation
    - [x] Identify existing focused tests covering Host start/close, route lifecycle, degraded cleanup, Guest revocation, federation, Broker routing, and local peers.
        - Existing coverage: `test/host.test.js`, `test/host-route-registry.test.js`, `test/host-upstreams.test.js`, `test/broker-routing.test.js`, and `test/local-peers.test.js` cover Host start/close, route lifecycle, degraded cleanup/restoration/removal, Guest revocation and ownership, federation/upstreams, Broker routing/lease behavior, and local peers.
    - [x] Add only minimal characterization/regression tests if an existing behavior boundary is not already covered.
        - No new characterization test added before refactor: the existing suites provide broad behavior-preserving coverage. A possible future edge-case test for Host close while a Broker request is queued waiting for a lease is noted as optional rather than required for this split.
    - [x] Run the narrowest relevant pre-refactor test command and record whether the tests already pass or any added characterization test fails for the expected reason.
        - Pre-refactor focused validation passed: `node --test test/host.test.js test/host-route-registry.test.js test/host-upstreams.test.js` (60/60 passing) and `node --test test/broker-routing.test.js test/local-peers.test.js` (65/65 passing).
        - Coverage note: behavior-preserving refactor coverage is provided by the existing focused Host, routing, federation, lifecycle, revocation, and local-peer suites; no new failing characterization test was required.
- [x] Task: Conductor - Phase Checkpoint 'Track Setup and Refactor Baseline' (Protocol in workflow.md)
    - Phase 1 complete. Baseline boundaries were recorded before implementation and public exports were confirmed unchanged.
    - Common-library scan: existing `@signicode/verser-common` protocol helpers remain reused; planned extractions are Host-internal Node HTTP/2 orchestration and state-management concerns.
    - Deduplication check: no production code changed in this phase, so no repeated implementation code was introduced.
    - Validation: `node --test test/host.test.js test/host-route-registry.test.js test/host-upstreams.test.js` passed 60/60; `node --test test/broker-routing.test.js test/local-peers.test.js` passed 65/65.
    - Coverage: behavior-preserving refactor baseline uses existing focused/integration suites; no new behavior was introduced in Phase 1.

## Phase 2: Extract Low-Risk Host State Managers

- [x] Task: Extract Guest lease pool management
    - [x] Review existing common libraries and confirm lease-pool behavior is Host-internal and should not move to `@signicode/verser-common`.
        - Lease-pool behavior is Host-internal because it owns Node HTTP/2 lease streams, per-Guest idle/active lease maps, queued acquisition timers, and Host shutdown/session cleanup semantics; no new common export is needed.
    - [x] Create a Host-internal lease-pool module for idle leases, active leases, queued acquisitions, acquisition timeout handling, lease removal, close cleanup, and queued-acquisition failure.
        - Created `packages/verser2-host/src/lib/lease-pool.ts` with `LeasePool` class and `GuestLeaseStream` interface.
        - Exports: `LeasePool` class and `GuestLeaseStream` interface (type-only for Host usage).
        - Private types (`QueuedLeaseAcquisition`) remain internal to the module.
        - No circular dependencies: the module imports only `node:http2` and `@signicode/verser-common` types.
    - [x] Wire `NodeHttp2VerserHost` to delegate lease-pool operations while preserving cleanup order and session-close semantics.
        - Replaced private `idleLeases`, `activeLeases`, `queuedLeaseAcquisitions` maps with `this.leasePool = new LeasePool()`.
        - Replaced private `GuestLeaseStream` and `QueuedLeaseAcquisition` interfaces with imported `GuestLeaseStream`.
        - Redirected all lease operations (`addIdleLease`, `acquireLease`, `tryAcquireLease`, `removeLease`, `closeGuestLeases`, `closeAllLeases`, `failQueuedLeaseAcquisitions`, `failAllQueuedLeaseAcquisitions`, `removeQueuedLeaseAcquisition`) to `this.leasePool.*`.
        - Removed 9 private methods (~130 lines) from the Host class.
        - Cleanup order preserved: `closeAllLeases` before `failAllQueuedLeaseAcquisitions` in `close()`; `closeGuestLeases` before `failQueuedLeaseAcquisitions` in `removeSessionPeers` and `detachLocalPeer`.
        - Stream close/error handlers in `attachGuestLeaseStream` still use the Host's `emitLifecycle` before delegating `removeLease` to the pool.
    - [x] Run `npm run build --workspace=@signicode/verser2-host`.
        - Build succeeded.
    - [x] Run focused lease/routing tests that cover Guest lease acquisition and cleanup.
        - `node --test test/host.test.js test/broker-routing.test.js test/local-peers.test.js` passed 74/74.
    - [x] Commit this completed task according to the per-task commit policy.
- [x] Task: Extract degraded-route cleanup management
    - [x] Review existing common libraries and confirm degraded cleanup is Host-internal lifecycle orchestration.
        - Degraded cleanup is Host-internal because it coordinates Host timers, `HostRouteRegistry.removeExpiredDegradedRoutes()`, route advertisements, and lifecycle emission. Common exports remain limited to route lifecycle constants/types/factories already in use.
    - [x] Create a Host-internal degraded-route cleanup module for timer start/stop and expired degraded-route checks.
        - Created `packages/verser2-host/src/lib/degraded-route-cleanup.ts` with `DegradedRouteCleanup` class and `DegradedRouteCleanupCallbacks` interface.
        - The class owns the `setInterval` timer and the `check()` logic that captures generation metadata, calls `removeExpiredDegradedRoutes`, emits lifecycle events, re-advertises routes, and auto-stops the timer when no degraded routes remain.
        - No circular dependencies: the module imports only `@signicode/verser-common` and `./route-registry` types.
    - [x] Pass required state and callbacks by reference so route registry mutation, route advertisement, and lifecycle emission remain coordinated by the Host.
        - `DegradedRouteCleanup` receives an `DegradedRouteCleanupCallbacks` object with function references for `removeExpiredDegradedRoutes`, `hasAnyDegradedRoutes`, `getDegradedPeerIds`, `getDegradedBrokerRoutesForPeer`, `getRouteGeneration`, `advertiseRouteLifecycleEvents`, `advertiseRoutes`, and `advertiseFederatedRoutes`.
        - The Host builds these callbacks in `createDegradedCleanupCallbacks()`, which binds to `this.routeRegistry` and Host methods via arrow functions.
    - [x] Wire `NodeHttp2VerserHost` to delegate degraded cleanup timer operations while preserving current behavior and cleanup ordering.
        - Replaced `private degradedCleanupTimer` field with `private readonly degradedCleanup: DegradedRouteCleanup` and initialized in the constructor with the resolved timeout value.
        - `startDegradedRouteCleanupTimer()` now delegates to `this.degradedCleanup.start()`.
        - `stopDegradedRouteCleanupTimer()` now delegates to `this.degradedCleanup.stop()`.
        - Removed the ~70-line `checkExpiredDegradedRoutes()` method entirely (logic moved into `DegradedRouteCleanup.check()`).
        - Removed unused `type VerserRouteGeneration` import from the Host file.
        - All call sites (`close()`, `attachLocalGuest()`, `registerPeer()`, `detachLocalPeer()`, `removeSessionPeers()`) unchanged — they call the same thin wrapper methods.
        - Cleanup ordering preserved: degraded timer is stopped before server close; timer starts on Guest disconnect/degradation; timer stops when no degraded routes remain.
    - [x] Run `npm run build --workspace=@signicode/verser2-host`.
        - Build succeeded.
    - [x] Run focused Host route lifecycle/degraded-route tests.
        - `node --test test/host.test.js test/host-route-registry.test.js test/broker-routing.test.js test/local-peers.test.js` passed 91/91.
        - Additional lint validation after formatting fix: `npm run lint` passed.
    - [x] Commit this completed task according to the per-task commit policy.
- [x] Task: Review cleanup — Phase 2 code review findings
    - [x] Made `LeasePool.removeQueuedLeaseAcquisition()` private (it accepts module-private `QueuedLeaseAcquisition` and is only called internally).
    - [x] Removed unused `DegradedRouteCleanup.running` getter (no callers; timer state is managed internally).
    - [x] Removed unused boolean return from `LeasePool.addIdleLease()` — return type changed to `void`, internal behavior preserved.
    - [x] Ran `npm run lint` — passed (0 issues).
    - [x] Ran `npm run build --workspace=@signicode/verser2-host` — passed.
    - [x] Ran `node --test test/host.test.js test/broker-routing.test.js test/local-peers.test.js` — passed (74/74 tests).
    - [x] Record this review result in the Phase 2 checkpoint.
- [x] Task: Conductor - Phase Checkpoint 'Extract Low-Risk Host State Managers' (Protocol in workflow.md)
    - Phase 2 complete. `LeasePool` and `DegradedRouteCleanup` were extracted as Host-internal modules without public export changes or Host-class back imports.
    - Common-library scan: no new common code was added; extracted logic remains Host-specific because it owns Node HTTP/2 streams, Host timers, registry callbacks, and lifecycle/advertisement coordination.
    - Deduplication check: no repeated implementation code introduced; review cleanup made `removeQueuedLeaseAcquisition()` private, removed unused `DegradedRouteCleanup.running`, and removed the unused `LeasePool.addIdleLease()` return value.
    - Validation: `npm run lint`, `npm run build --workspace=@signicode/verser2-host`, `node --test test/host.test.js test/broker-routing.test.js test/local-peers.test.js`, `node --test test/host.test.js test/host-route-registry.test.js test/broker-routing.test.js test/local-peers.test.js`, and `node --test test/host-upstreams.test.js` passed during Phase 2 work/review.
    - Review: @oracle reported no blocking findings and confirmed Phase 3 can safely begin after checkpoint closure; P2 internal API cleanup findings were addressed.
    - Coverage: behavior-preserving refactor coverage is provided by existing focused Host/routing/degraded-route/federation/local-peer suites.

## Phase 3: Extract Broker Routing and Federated Forwarding Boundaries

- [x] Task: Extract Broker request routing helpers
    - [x] Review existing common libraries and confirm Broker routing orchestration remains Host-internal.
        - Broker routing orchestration is Host-internal because it coordinates Host-owned route registry decisions, local peer dispatch, lease-pool acquisition, federated fallback hooks, HTTP/2 stream response handling, and Host lifecycle/error semantics. Common protocol helpers remain reused from `@signicode/verser-common`.
    - [x] Create a Host-internal broker-routing module (`packages/verser2-host/src/lib/broker-routing.ts`) for Broker request dispatch, local lease routing, federated routing selection, cancellation propagation, and structured error preservation.
        - Extracted functions: `routeBrokerRequest`, `tryRouteH2BrokerRequestToFederatedHost`, `routeH2BrokerRequestOverFederationStream`, `routeH2BrokerRequestToLocalGuest`, `routeBrokerRequestOverLease`, `routeLocalBrokerRequest`, `routeLocalRequestDispatch`, `tryRouteLocalRequestToFederatedHost`, `routeLocalRequestOverFederationStream`, `routeLocalRequestToAttachedGuest`, `routeLocalRequestToH2Guest`, `readFederatedResponseMetadata`.
        - Uses `BrokerRoutingCallbacks` interface for Host-dependency injection to avoid circular imports.
        - Host remains the orchestrator; thin wrappers in `NodeHttp2VerserHost` delegate to module functions.
        - The extracted `routeLocalRequestDispatch` preserves the `localGuest`-defined check before dispatching to `routeLocalRequestToAttachedGuest`.
    - [x] Keep `NodeHttp2VerserHost` responsible for high-level orchestration, peer/session ownership, route registry ownership, lifecycle emission, and route advertisement.
        - Host retains: `routeBrokerRequest`, `routeLocalBrokerRequest`, `routeLocalRequest` as thin delegating wrappers.
        - Unused Host wrappers for sub-methods that are now called only from module internals removed to avoid TypeScript unused-private warnings.
    - [x] Preserve all existing timeout, abort, stream close, and response propagation behavior.
        - All stream plumbing (cancellation, piping, response metadata reading, error propagation) preserved in extracted functions.
    - [x] Run `npm run build --workspace=@signicode/verser2-host`.
        - Build succeeded.
    - [x] Run `node --test test/broker-routing.test.js test/local-peers.test.js`.
        - 65/65 tests passed.
        - Additional review validation: `node --test test/host-upstreams.test.js` passed 34/34.
    - [x] Lint clean.
        - `npm run lint` passed.
    - [x] Review cleanup applied.
        - @oracle found no P0/P1 findings. P2 cleanup reworded the plan note, narrowed helper exports, and replaced lifecycle string literals with `VERSER_LIFECYCLE_EVENTS` constants.
    - [x] Commit this completed task according to the per-task commit policy.
- [~] Task: Extract federation and upstream-link helpers
    - [x] Pause for review before this major architecture refactor if the required dependency shape changes beyond internal helper/module extraction.
        - User approved proceeding with the planned internal federation/upstream helper extraction using callback/facade boundaries, no public API/protocol changes, and preserved Host state ownership.
    - [x] Review existing common libraries and confirm federation orchestration remains Host-internal while protocol constants/types continue to come from `@signicode/verser-common`.
        - Federation orchestration remains Host-internal because it owns upstream/inbound link state, Node HTTP/2 sessions/streams, request-stream waiters, lifecycle forwarding coordination, and Host route import/export decisions. Protocol constants, envelope helpers, route factories, loop/hop validation, and federation frame types remain reused from `@signicode/verser-common`.
    - [x] Create Host-internal federation/upstream modules for upstream link lifecycle, inbound federation handshake/streams, federated route frames, federated lifecycle forwarding, and federated request stream acquisition where practical.
        - Created `packages/verser2-host/src/lib/federation.ts` with the following extracted components:
            - Shared types: `FederationRequestStream`, `AcquiredFederatedRequestStream` (removed duplication with `broker-routing.ts`)
            - Handshake/timeout utilities: `waitForUpstreamHandshakeResponse`, `withUpstreamHandshakeTimeout`, `getUpstreamRejectionReason`, `getUpstreamHandshakeHostId`
            - Upstream handshake: `sendUpstreamHandshake`
            - Stream opening helpers: `openUpstreamRouteStream`, `openUpstreamRequestStream`, `openUpstreamDispatchRequestStream`
            - Route frame handling: `FederatedRouteFrameCallbacks` interface, `handleFederatedRouteFrame`
            - Lifecycle forwarding: `forwardFederatedLifecycleEventsExcluding`, `tagFederatedLifecycleFrame`
            - Incoming request handling: `handleFederatedIncomingRequestStream`
            - Route writing: `writeFederatedRoutes`
        - Updated `broker-routing.ts` to import `FederationRequestStream` and `AcquiredFederatedRequestStream` from `federation.ts` instead of defining locally (no duplicate types).
        - Updated `node-http2-verser-host.ts`: removed federation helper methods and replaced them with thin delegating wrappers/callback boundaries.
        - Host file reduced from 2353 to ~1960 lines after review fixes.
    - [x] Preserve loop detection, hop validation, route import/export behavior, route lifecycle propagation, structured federated errors, and close ordering.
        - Loop detection (`seenFederationLifecycleEventIds`) remains Host-owned; `handleFederatedRouteFrame` receives it as a `Set<string>` parameter.
        - `tagFederatedLifecycleFrame` preserves the counter and seen-IDs management with the Host calling and updating its own counter.
        - `forwardFederatedLifecycleEventsExcluding` preserves the same excluded-owner filtering logic.
        - All error types, route import/export, lifecycle propagation, and close paths preserved.
        - Host retains `upstreamLinks`, `inboundFederationHosts`, `federatedRequestStreamWaiters` ownership.
    - [x] Avoid circular dependencies by using explicit callback/state interfaces rather than importing the Host class into extracted modules.
        - New `FederatedRouteFrameCallbacks` interface passes Host-owned operations.
        - `handleFederatedIncomingRequestStream` receives `routeFn` and `emitLifecycle` callbacks.
        - `writeFederatedRoutes` receives a `getRoutesForExport` callback.
        - `forwardFederatedLifecycleEventsExcluding` receives iterables for upstream/inbound host links.
    - [x] Run `npm run build --workspace=@signicode/verser2-host`.
        - Build succeeded.
    - [x] Run `node --test test/host-upstreams.test.js test/host-route-registry.test.js`.
        - 51/51 tests passed (34 upstream + 17 route registry).
    - [x] Run `node --test test/broker-routing.test.js test/local-peers.test.js` (shared routing/federated types touched).
        - 65/65 tests passed.
    - [x] Lint clean (`npm run lint` passed).
    - [x] P1 review fixes applied:
        - Restored structured upstream rejection context: `openUpstreamRequestStream` includes `statusCode`, and `openUpstreamDispatchRequestStream` now accepts `extraContext` for `remoteHostId`/`direction`; Host wrapper passes them from the link.
        - Restored upstream handshake wire shape: `maxHopCount` is now optional in `sendUpstreamHandshake`; Host wrapper passes `maxFederationHopCount` directly without `?? 8`.
        - Completed federation extraction: removed duplicate Host methods `handleFederatedRouteFrame`, `forwardFederatedLifecycleEventsExcluding`, `tagFederatedLifecycleFrame`, `writeFederatedRoutes` — all deployment now goes through `federation.ts` directly.
        - Updated `advertiseRouteLifecycleEvents` to use `forwardFederationEventsToPeers` instead of inline federation loop.
        - `handleHostFederationRouteStream` and `advertiseFederatedRoutes` now call `federation.*` functions directly.
    - [x] Commit this completed task according to the per-task commit policy.
- [x] Task: Conductor - Phase Checkpoint 'Extract Broker Routing and Federated Forwarding Boundaries' (Protocol in workflow.md)
    - Phase 3 complete. Broker routing helpers and federation helpers were extracted as Host-internal modules without public export changes or Host-class back imports.
    - Common-library scan: no new common code was added; extracted logic remains Host-specific because it coordinates Host route registry decisions, Node HTTP/2 streams, local peer dispatch, lease/federated request acquisition, upstream/inbound link state, lifecycle forwarding, and Host-owned route import/export decisions. Existing `@signicode/verser-common` protocol helpers continue to be reused.
    - Deduplication check: `FederationRequestStream` and `AcquiredFederatedRequestStream` are now defined once in `federation.ts` and imported by `broker-routing.ts`; no repeated extracted helper code remains in the Host for route-frame/lifecycle/write-routes paths.
    - Validation: `npm run lint`, `npm run build --workspace=@signicode/verser2-host`, `node --test test/broker-routing.test.js test/local-peers.test.js`, `node --test test/host-upstreams.test.js test/host-route-registry.test.js`, and `node --test test/host.test.js` passed during Phase 3 work/review.
    - Review: @oracle found no blocking issues for broker routing after P2 cleanup, then found federation P1 regressions; structured upstream rejection context and optional `maxHopCount` wire-shape regressions were fixed and revalidated.
    - Deferred extraction: upstream link map lifecycle, inbound federation entrypoint orchestration, and federated request-stream waiter queues remain in Host because extracting them would require broad map ownership callbacks and would reduce clarity more than file size.
    - Coverage: behavior-preserving refactor coverage is provided by existing Broker routing, local peer, upstream federation, route registry, and Host integration suites.

## Phase 4: Integration Cleanup, Documentation, and Final Validation

- [x] Task: Consolidate internal types and dependency boundaries
    - [x] Check whether Host-internal state/callback interfaces used by multiple extracted modules should be moved.
        - Finding: No callback interface consolidation needed. Three distinct module-specific callback interfaces exist:
          `BrokerRoutingCallbacks` (broker-routing.ts), `DegradedRouteCleanupCallbacks` (degraded-route-cleanup.ts),
          `FederatedRouteFrameCallbacks` (federation.ts). Each is used by exactly one module; none is shared across
          modules. Moving them to a shared file would add indirection without reducing duplication. Current
          arrangement keeps dependency direction clear and avoids broad premature abstraction.
        - Finding: `PeerInfo` in `broker-routing.ts` is a minimal projection of `RegisteredPeer` (Host-private).
          It intentionally decouples the routing module from the Host class. Keeping it local preserves
          the decoupling boundary.
        - Shared types between modules (`GuestLeaseStream` from lease-pool.ts → broker-routing.ts;
          `FederationRequestStream`/`AcquiredFederatedRequestStream` from federation.ts → broker-routing.ts)
          are already properly organized with single definition + import pattern. No consolidation needed.
    - [x] Keep public `types.ts` and `src/index.ts` unchanged.
        - Confirmed: `packages/verser2-host/src/lib/types.ts` and `packages/verser2-host/src/index.ts` require no changes.
    - [x] Check for repeated code introduced during extraction and deduplicate within Host internals.
        - Finding: `tryRouteH2BrokerRequestToFederatedHost` and `tryRouteLocalRequestToFederatedHost` in
          `broker-routing.ts` share structurally similar candidate-iteration logic (~12 lines core pattern).
          However, they serve different API layers (H2 stream vs local dispatch) with different return types
          and routing path functions. Extracting a shared helper would require generic parameters or lambdas
          that reduce readability. Decision: keep as-is — this is intentional API adaptation.
        - Finding: `openUpstreamRouteStream`/`openUpstreamRequestStream`/`openUpstreamDispatchRequestStream`
          in `federation.ts` share a status-check pattern (~10 lines each) but have different paths, error
          messages, and error context shapes. A shared helper would need context parameters that outweigh
          benefit. Decision: keep as-is.
        - Finding: Host-private wrappers (`openUpstreamRequestStream`, `sendUpstreamHandshake`, etc.) are
          thin boundary translations that pass Host-owned state (options, UpstreamLink fields) to the
          federation module. Inlining them would spread Host-state access across the module boundary. These
          are intended abstraction boundaries, not code duplication.
        - Finding: No stale or duplicated type definitions remain after extraction. All shared types are
          imported from their single-definition module.
    - [x] Confirm any intentionally deferred extraction is documented with rationale.
        - Confirmed: Plan.md Phase 3 checkpoint (line 171) documents deferred extraction of upstream link
          map lifecycle, inbound federation entrypoint orchestration, and federated request-stream waiter
          queues with rationale (would require broad map ownership callbacks and reduce clarity more than
          file size). This assessment remains accurate; no additional deferral decisions were identified.
    - [x] Run build and lint validation.
        - `npm run build --workspace=@signicode/verser2-host` — passed (CJS + declarations).
        - `npm run lint` — passed (0 issues, 144 files checked).
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Update Host codemap and Conductor notes
    - [ ] Update `packages/verser2-host/codemap.md` and any relevant nested codemap to describe new Host-internal modules and responsibilities.
    - [ ] Do not update user-facing docs unless implementation reveals a behavior/public API documentation mismatch.
    - [ ] Record split boundaries, validation results, common-library reuse decisions, and any deferred extraction in this plan.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Run final focused and full validation
    - [ ] Run `npm run build --workspace=@signicode/verser2-host`.
    - [ ] Run `node --test test/host.test.js test/host-route-registry.test.js test/host-upstreams.test.js`.
    - [ ] Run `node --test test/local-peers.test.js test/broker-routing.test.js`.
    - [ ] Run `node --test test/agent.test.js test/dispatcher.test.js test/guest-node.test.js`.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Confirm 95% meaningful coverage for changed behavior, or record that this is behavior-preserving refactor coverage through existing characterization/integration suites.
    - [ ] Commit final validation/plan updates according to the per-task commit policy if files changed.
- [ ] Task: Code review and maintainability check
    - [ ] Delegate a review to the configured review specialist after implementation is complete.
    - [ ] Address in-scope review findings that preserve the no-public-API-change requirement.
    - [ ] Re-run the narrowest validation for any review-driven changes.
    - [ ] Commit review-driven changes according to the per-task commit policy.
- [ ] Task: Branching Policy finalization
    - [ ] Ensure all completed task work is committed.
    - [ ] Push the implementation branch.
    - [ ] Open or update the draft PR targeting the captured base branch using the track `spec.md` as the PR body.
    - [ ] Post final verification results as a PR comment.
    - [ ] Mark the PR ready only after final verification is complete.
- [ ] Task: Conductor - Phase Checkpoint 'Integration Cleanup, Documentation, and Final Validation' (Protocol in workflow.md)

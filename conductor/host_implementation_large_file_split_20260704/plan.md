# Implementation Plan: Host Implementation Large File Split

## Phase 1: Track Setup and Refactor Baseline

- [ ] Task: Create implementation branch and PR review surface
    - [ ] Capture the current branch as the PR base branch.
    - [ ] Create the implementation branch with name `conductor/host_implementation_large_file_split_20260704` or a sanitized equivalent.
    - [ ] Do NOT make granular start-marker commits or open a PR early during planning or track creation.
    - [ ] Perform implementation work on this branch, making commits according to the resolved commit frequency policy: per task.
    - [ ] Open or update a draft PR targeting the captured base branch when the Branching Policy requires PR visibility or finalization.
- [ ] Task: Establish source and behavior baseline
    - [ ] Read `packages/verser2-host/codemap.md` and any Host library codemap before editing Host internals.
    - [ ] Inspect `packages/verser2-host/src/lib/node-http2-verser-host.ts`, `route-registry.ts`, `local-peers.ts`, `types.ts`, and `http2-io.ts` for current boundaries and dependency direction.
    - [ ] Record the intended extraction boundaries in this plan before implementation: federation/upstream handling, broker routing, Guest lease pool, and degraded-route cleanup.
    - [ ] Confirm no public exports from `packages/verser2-host/src/index.ts` need to change.
- [ ] Task: Write or update characterization tests before implementation
    - [ ] Identify existing focused tests covering Host start/close, route lifecycle, degraded cleanup, Guest revocation, federation, Broker routing, and local peers.
    - [ ] Add only minimal characterization/regression tests if an existing behavior boundary is not already covered.
    - [ ] Run the narrowest relevant pre-refactor test command and record whether the tests already pass or any added characterization test fails for the expected reason.
- [ ] Task: Conductor - Phase Checkpoint 'Track Setup and Refactor Baseline' (Protocol in workflow.md)

## Phase 2: Extract Low-Risk Host State Managers

- [ ] Task: Extract Guest lease pool management
    - [ ] Review existing common libraries and confirm lease-pool behavior is Host-internal and should not move to `@signicode/verser-common`.
    - [ ] Create a Host-internal lease-pool module for idle leases, active leases, queued acquisitions, acquisition timeout handling, lease removal, close cleanup, and queued-acquisition failure.
    - [ ] Wire `NodeHttp2VerserHost` to delegate lease-pool operations while preserving cleanup order and session-close semantics.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host`.
    - [ ] Run focused lease/routing tests that cover Guest lease acquisition and cleanup.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Extract degraded-route cleanup management
    - [ ] Review existing common libraries and confirm degraded cleanup is Host-internal lifecycle orchestration.
    - [ ] Create a Host-internal degraded-route cleanup module for timer start/stop and expired degraded-route checks.
    - [ ] Pass required state and callbacks by reference so route registry mutation, route advertisement, and lifecycle emission remain coordinated by the Host.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host`.
    - [ ] Run focused Host route lifecycle/degraded-route tests.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Conductor - Phase Checkpoint 'Extract Low-Risk Host State Managers' (Protocol in workflow.md)

## Phase 3: Extract Broker Routing and Federated Forwarding Boundaries

- [ ] Task: Extract Broker request routing helpers
    - [ ] Review existing common libraries and confirm Broker routing orchestration remains Host-internal.
    - [ ] Create a Host-internal broker-routing module for Broker request dispatch, local lease routing, federated routing selection, cancellation propagation, and structured error preservation.
    - [ ] Keep `NodeHttp2VerserHost` responsible for high-level orchestration, peer/session ownership, route registry ownership, lifecycle emission, and route advertisement.
    - [ ] Preserve all existing timeout, abort, stream close, and response propagation behavior.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host`.
    - [ ] Run `node --test test/broker-routing.test.js test/local-peers.test.js`.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Extract federation and upstream-link helpers
    - [ ] Pause for review before this major architecture refactor if the required dependency shape changes beyond internal helper/module extraction.
    - [ ] Review existing common libraries and confirm federation orchestration remains Host-internal while protocol constants/types continue to come from `@signicode/verser-common`.
    - [ ] Create Host-internal federation/upstream modules for upstream link lifecycle, inbound federation handshake/streams, federated route frames, federated lifecycle forwarding, and federated request stream acquisition where practical.
    - [ ] Preserve loop detection, hop validation, route import/export behavior, route lifecycle propagation, structured federated errors, and close ordering.
    - [ ] Avoid circular dependencies by using explicit callback/state interfaces rather than importing the Host class into extracted modules.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host`.
    - [ ] Run `node --test test/host-upstreams.test.js test/host-route-registry.test.js`.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Conductor - Phase Checkpoint 'Extract Broker Routing and Federated Forwarding Boundaries' (Protocol in workflow.md)

## Phase 4: Integration Cleanup, Documentation, and Final Validation

- [ ] Task: Consolidate internal types and dependency boundaries
    - [ ] Move only Host-internal state/callback interfaces needed by multiple extracted modules into appropriate Host-internal files.
    - [ ] Keep public `types.ts` and `src/index.ts` unchanged unless a harmless internal type export is clearly necessary.
    - [ ] Check for repeated code introduced during extraction and deduplicate within Host internals.
    - [ ] Confirm any intentionally deferred extraction is documented with rationale.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host`.
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

# Implementation Plan: Broker dispatch to imported upstream Host routes

## Phase 1: TDD regression tests and PR review surface

- [x] Task: Create track branch and PR review surface
    - [x] Create a dedicated track branch before behavior-changing implementation work.
    - [x] Create a GitHub pull request using `gh` with a title/body describing the intended TO-BE state: downstream Broker requests can dispatch to imported upstream Host routes.
    - [x] Record the PR URL in this plan: https://github.com/signicode/verser2/pull/25
- [x] Task: Inventory existing federation implementation and common reuse points
    - [x] Review Host federation files, route candidate handling, upstream link state, inbound federation host state, request-stream acquisition, and existing tests.
    - [x] Review `@signicode/verser-common` exports before adding new package-local types/helpers.
    - [x] Record current source references and deduplication opportunities in this plan.
    - Source references: Host upstream/inbound state in `packages/verser2-host/src/lib/node-http2-verser-host.ts:102`, maps at `:169`, upstream streams at `:724`, inbound request stream at `:779`, upstream request handler at `:808`, local federation dispatch/acquisition at `:1409`, H2 dispatch at `:1809`; route selection in `packages/verser2-host/src/lib/route-registry.ts`; common federation helpers in `packages/verser-common/src/lib/federation.ts`; existing coverage in `test/host-upstreams.test.js:476` and redirect behavior in `test/broker-routing.test.js:203`.
    - Deduplication opportunity: local and H2 candidate iteration/acquisition share the same inbound-only request-stream assumption and should use a shared upstream/inbound acquisition policy rather than parallel fixes.
- [x] Task: Write failing issue #24 regression tests first
    - [x] Add a raw Verser2 Host/Broker test for downstream Broker request to an imported upstream route.
    - [x] Add a raw Verser2 Host/Broker test for downstream Broker request to an imported upstream Manager route that returns native 307/308 redirect to another advertised route.
    - [x] Add or update error tests for unavailable upstream route candidates and expected route/host/direction context.
    - [x] Add runtime coverage targets for Node, Bun-facing Broker, and Python Broker where practical, documenting any shared-protocol coverage decision.
    - Runtime coverage target: Phase 1 adds raw Node Host/Node Broker regressions in `test/host-upstreams.test.js`; Phase 3 will decide whether Bun-facing and Python Broker validation require direct tests or are covered by shared Host/protocol behavior.
- [x] Task: Confirm tests fail for the expected reason
    - [x] Run the narrowest focused test command for the new regression tests.
    - [x] Confirm the failure reproduces issue #24 or the expected missing upstream-dispatch behavior.
    - [x] Record coverage status as not yet applicable until implementation begins.
    - Validation: `npm run build && node --test test/host-upstreams.test.js` passed existing 24 tests and failed the 2 new regressions with `upstream-unavailable` for `guest-manager-upstream` and `guest-manager-redirect`, matching the issue #24 upstream-dispatch gap. Coverage is not applicable until implementation changes begin.
- [x] Task: Commit and push Phase 1 before manual validation
    - [x] Run `npm run lint` or the narrowest lint/docs validation needed for test-only changes.
    - [x] Commit Phase 1 changes with a scoped message.
    - [x] Push the phase commit to the track PR branch.
    - [x] Record the commit SHA and validation results in this plan.
    - Validation: `npm run lint` initially found session-introduced formatting in the new tests; formatting was fixed and rerun successfully.
    - Phase 1 checkpoint commit: `a1a9981` pushed to `track/upstream-broker-dispatch_20260616`.
- [x] Task: Conductor - User Manual Verification 'Phase 1: TDD regression tests and PR review surface' (Protocol in workflow.md)

## Phase 2: Upstream federation request-stream support

- [x] Task: Design upstream request-stream acquisition path
    - [x] Compare inbound federation request acquisition with upstream link request stream state.
    - [x] Identify reusable route candidate, lease, cleanup, and fallback logic.
    - [x] Decide whether to adapt existing helpers or introduce shared internal helpers while preserving public API behavior.
    - Design: preserve the existing idle `/verser/host/federation/request` stream for upstream-to-downstream dispatch and add a one-shot dispatch mode for downstream-to-upstream requests over a healthy `UpstreamLink.session`, keyed by route-candidate `nextHopHostId` matching `UpstreamLink.remoteHostId`.
- [x] Task: Implement upstream request stream acquisition
    - [x] Add support for acquiring a request stream from an upstream link when a route candidate’s next hop is available through `upstreamLinks`.
    - [x] Preserve existing inbound federation request acquisition and fallback behavior.
    - [x] Handle closed, stale, missing, or unavailable upstream links with contextual errors.
- [x] Task: Preserve protocol and lifecycle semantics
    - [x] Ensure forwarded requests preserve method, path, headers, body streaming, status, response headers, and response body semantics.
    - [x] Ensure route cleanup and HA fallback behavior remain compatible with existing inbound federation behavior.
    - [x] Avoid duplicating logic that belongs in common or shared Host federation helpers.
    - Deduplication: shared incoming federation request handling now accepts both client and server HTTP/2 stream directions; route candidate loops remain separate for local and H2 Broker paths to keep the refactor minimal.
- [x] Task: Validate upstream request-stream support
    - [x] Run focused Host federation tests for the new upstream acquisition path.
    - [x] Run existing inbound federation tests to confirm compatibility.
    - [x] Record coverage result or justify any phase-specific coverage limitation.
    - Validation: `npm run build --workspace=@signicode/verser2-host` passes after fixing a session-introduced waiter type issue. `node --test test/host-upstreams.test.js` passes all 26 tests, including existing inbound federation coverage and the two new upstream-dispatch regressions. Coverage measurement deferred to broader validation.
- [x] Task: Commit and push Phase 2 before manual validation
    - [x] Commit Phase 2 changes with a scoped message.
    - [x] Push the phase commit to the track PR branch.
    - [x] Record the commit SHA and validation results in this plan.
    - Validation: `npm run lint` passes.
    - Phase 2 checkpoint commit: `77f4249` pushed to `track/upstream-broker-dispatch_20260616`.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Upstream federation request-stream support' (Protocol in workflow.md)

## Phase 3: Downstream Broker dispatch, redirects, and runtime validation

- [x] Task: Implement downstream Broker dispatch to imported upstream routes
    - [x] Connect route-local request handling to the upstream federation request-stream path for imported route candidates.
    - [x] Preserve local-first route behavior and existing route candidate ordering/fallback semantics.
    - [x] Ensure the issue #24 raw Host/Broker reproduction returns the upstream route response.
- [x] Task: Implement and validate native redirect flow across upstream routes
    - [x] Ensure a Broker request to an imported Manager route can receive and follow eligible native 307/308 redirects to advertised routes.
    - [x] Preserve method-preserving redirect behavior, hop limits, and replay-buffer safeguards.
    - [x] Confirm Manager coordinates routing without becoming the payload proxy for single-owner target routes when redirect-following applies.
- [x] Task: Validate implemented runtime surfaces
    - [x] Validate Node Host and Node Broker behavior directly.
    - [x] Validate Bun-facing Broker behavior where it exercises the shared Node transport path.
    - [x] Validate Python Broker behavior where practical, or document why direct validation is deferred and which shared protocol tests cover compatibility.
    - Runtime validation: Node Host/Broker upstream and redirect regressions pass in `test/host-upstreams.test.js`; Bun-facing Broker `createFetch()` upstream route validation added to `test/host-upstreams.test.js`; Python Broker upstream route validation added to `test/python-broker-tls-integration.test.js`.
- [x] Task: Improve error clarity
    - [x] Update errors so unavailable upstream route candidates distinguish inbound federation misses from upstream-link unavailability.
    - [x] Include useful target route id/domain, next-hop host id, upstream id, direction, connection state, and request path context where available.
    - [x] Confirm error tests assert the improved context.
    - Note: Verser error context accepts primitive values, so exhausted-candidate details are summarized as `candidateCount`, `nextHopHostIds`, `originHostIds`, and `domains`.
- [x] Task: Validate downstream dispatch phase
    - [x] Run the focused regression tests from Phase 1 and confirm they pass.
    - [x] Run existing Host federation, Broker redirect, Bun-facing, and Python Broker tests relevant to the changed behavior.
    - [x] Record coverage result or justify any runtime-specific coverage limitation.
    - Validation: `npm run build --workspace=@signicode/verser2-host` passes. `npm run build --workspace=@signicode/verser2-host && npm run build --workspace=@signicode/verser2-guest-bun && node --test test/host-upstreams.test.js` passes 27 tests. `node --test test/python-broker-tls-integration.test.js` passes 5 tests. A parallel build/test attempt briefly failed because tests used stale generated output while build was still running; rerunning after successful build passed. Coverage measurement deferred to final validation.
- [x] Task: Commit and push Phase 3 before manual validation
    - [x] Commit Phase 3 changes with a scoped message.
    - [x] Push the phase commit to the track PR branch.
    - [x] Record the commit SHA and validation results in this plan.
    - Validation: `npm run lint` initially found session-introduced formatting in Host/Python test edits; formatting was fixed and rerun successfully.
    - Phase 3 checkpoint commit: `414ca05` pushed to `track/upstream-broker-dispatch_20260616`.
- [~] Task: Conductor - User Manual Verification 'Phase 3: Downstream Broker dispatch, redirects, and runtime validation' (Protocol in workflow.md)

## Phase 4: Finalization, documentation, and full validation

- [ ] Task: Update documentation
    - [ ] Update Host federation/request-routing docs to describe downstream-Broker-to-upstream-route dispatch.
    - [ ] Document native 307/308 redirect behavior across imported upstream routes and any limits.
    - [ ] Keep Host/Guest/Broker/Peer terminology precise and avoid unsupported runtime or HTTP/3 claims.
- [ ] Task: Final deduplication and code review
    - [ ] Review changed Host federation code for duplicated inbound/upstream request-routing logic.
    - [ ] Move repeated protocol-neutral logic into existing common/shared helpers where appropriate.
    - [ ] Confirm public APIs remain compatible and no unrelated Host/Guest/Broker behavior changed.
- [ ] Task: Full validation pass
    - [ ] Run `npm run lint`.
    - [ ] Run `npm test` or narrower documented equivalents if full validation is not necessary.
    - [ ] Run package staging, consumer, and tarball validations if package output or public behavior documentation changed.
    - [ ] Record skipped validation, failures, or manual-only checks with reasons.
- [ ] Task: Close issue and PR handoff readiness
    - [ ] Confirm all acceptance criteria are met against GitHub issue #24.
    - [ ] Ensure the PR body or comments summarize tests, validation, and any runtime-specific limitations.
    - [ ] Reference issue #24 for closure once the PR merges.
- [ ] Task: Commit and push Phase 4 before manual validation
    - [ ] Commit Phase 4 changes with a scoped message.
    - [ ] Push the phase commit to the track PR branch.
    - [ ] Record the commit SHA and validation results in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Finalization, documentation, and full validation' (Protocol in workflow.md)

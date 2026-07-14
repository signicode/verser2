# Implementation Plan: WebSocket Federation

## Delivery Record

- Base branch: `main`
- Implementation branch: `conductor/websocket_federation_20260713`
- Draft PR: https://github.com/signicode/verser2/pull/52

## Phase 1: Delivery Setup and Federation-VWS Contract

- [x] Task: Create track branch and PR review surface
    - [x] Capture the current branch as the PR base and verify the worktree and upstream state.
    - [x] Create `conductor/websocket_federation_20260713` from that base.
    - [x] Create and push a draft PR whose title and body describe the completed federation-VWS behavior, using `spec.md` as the body source.
    - [x] Record the branch and PR URL in this plan.
- [x] Task: Define the shared, versioned federation-VWS contract
    - [x] Scan `@signicode/verser-common` VWS and federation primitives plus existing HTTP federation contracts for reusable types, framing, loop checks, and error helpers.
    - [x] Add focused failing common/Host tests for the federation-VWS endpoint, open/accept negotiation, and deterministic no-response negotiation failure.
    - [x] Delegate the shared protocol/test implementation to the configured implementation specialist.
    - [x] Implement protocol-neutral request/response contracts that preserve VWS/1 frames and route metadata without changing route advertisements.
    - [x] Validate focused common/Host tests, build, and meaningful coverage for the new shared behavior.
- [x] Task: Conductor - Phase Checkpoint 'Delivery Setup and Federation-VWS Contract' (Protocol in workflow.md)
    - [x] Review the public federation protocol and branch/PR surface before subsequent cross-Host and public API work.
    - [x] Deduplicate shared protocol code, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

### Phase 1 Validation

- Deduplication: VWS federation framing, versioning, and deterministic negotiation errors are shared through `@signicode/verser-common`; Host stream opening and negotiation remain Host-specific adapters.
- Validation: `npm run test:bounded -- -- test/common-protocol.test.js test/host-federation-vws.test.js test/websocket.test.js` passed (53 contract/Host tests and 23 direct-VWS tests). The earlier combined run also passed 87 federated HTTP regression tests.
- Review: Oracle Phase 1 blockers were repaired and reverified. One P2 public-export concern is tracked in `td.md`.
- Checkpoint commit: `5e9876e` (`feat(federation): add VWS negotiation contract`).

## Phase 2: Host Multi-Hop Federation Data Plane

- [x] Task: Add Host acquisition and forwarding for federation-VWS streams
    - [x] Scan Host routing, federation, lease, authorization, and lifecycle code for common/reusable pieces before edits.
    - [x] Add failing integration tests for real imported-only routes across one-hop and multi-hop Host topologies, replacing the current unsupported-federation regression.
    - [x] Implement authenticated federation-VWS stream acquisition, exact `(targetId, domain)` candidate selection, and hop-by-hop forwarding to the destination Host's local Guest lease.
    - [x] Preserve origin/via/hop-limit/loop protections and allow candidate failover only before accept.
    - [x] Delegate the Host implementation and tests to the configured implementation specialist.
    - [x] Validate focused WebSocket/federation tests and ensure direct local and near-remote Host routing remain unchanged.
- [x] Task: Harden federation-VWS lifecycle, errors, and flow control
    - [x] Add failing tests for authorization denial, explicit endpoint rejection, no negotiation response, mixed-version peer behavior, route revocation, Host/upstream/Guest loss, shutdown, cancellation, reset, and pre-accept failover.
    - [x] Implement structured error propagation, deterministic post-accept close behavior, incremental backpressure, bounded queues, frame limits, and consumed-lease cleanup across each hop.
    - [x] Add slow-consumer, malformed-frame, oversized-frame, ping/pong, and close-code/reason coverage without buffering whole traffic.
    - [x] Run the narrow Host/common test set and record at least 95% meaningful changed-behavior coverage.
- [x] Task: Conductor - Phase Checkpoint 'Host Multi-Hop Federation Data Plane' (Protocol in workflow.md)
    - [x] Review architecture, security binding, lifecycle policy, and multi-hop semantics before runtime public API work.
    - [x] Deduplicate Host/common code, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

### Phase 2 Validation

- Deduplication: VWS federation error contracts remain shared; Host acquisition, authenticated traversal, and framed stream relaying remain Host-specific.
- Validation: bounded Host/WebSocket federation regressions, build, and lint pass; Oracle verified mixed-version compatibility, traversal binding, bounded acquisition, structured errors, per-hop frame limits, and duplicate-stream cleanup.
- Checkpoint commit: `f2558bc` (`feat(federation): route VWS streams across Hosts`).

## Phase 3: Native Node and Bun WebSocket Surfaces

- [x] Task: Complete Node native-facing Broker and Guest compatibility
    - [x] Scan existing Node WebSocket, Agent, Dispatcher, fetch, minimal HTTP, and public export surfaces for reusable adapters.
    - [x] Add failing tests for Node standard-facing local, directly remote, and federated WebSocket connections, including subprotocols, text/binary, close, and errors.
    - [x] Implement thin native-facing Node wrappers and compatibility paths over VWS/1 without regressing existing direct APIs or HTTP request behavior.
    - [x] Delegate the Node implementation/tests to the configured implementation specialist.
    - [x] Validate the focused Node suite, type declarations, and package build.
- [x] Task: Add Bun native upgrade and Broker WebSocket support
    - [x] Scan Bun adapter, route-table, public export, and test conventions before edits; reuse shared Node transport only where runtime semantics remain correct.
    - [x] Add failing Bun tests for native upgrade/handler lifecycle and local, directly remote, and federated Broker connections.
    - [x] Implement Bun-native Guest upgrade/WebSocket handling and Broker compatibility over VWS/1, preserving Bun message and close semantics.
    - [x] Test explicit endpoint rejection and no-response negotiation failure through the Bun surface.
    - [x] Validate focused Bun tests, type declarations, and package build.
- [x] Task: Conductor - Phase Checkpoint 'Native Node and Bun WebSocket Surfaces' (Protocol in workflow.md)
    - [x] Review the new public APIs and runtime ergonomics before Python and end-to-end finalization.
    - [x] Deduplicate shared adapters, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

### Phase 3 Validation Notes

- Deduplication: shared VWS transport queue/error primitives are reused; runtime facades remain adapters (no shared WebSocket base class across runtimes).
- Oracle review: all high-severity blockers repaired; one P2 public-export concern tracked separately.
- Validations:
    - `npm test --workspace @signicode/verser2-guest-bun` — 28 tests passed.
    - Focused bounded root WebSocket/native-node/Bun suite — 34 tests passed.
    - `npm run build` — passed.
    - `npm run lint` — passed.
    - `git diff --check` — no whitespace errors.
- Coverage: meaningful focused behavior coverage across Node WebSocket, Bun WebSocket, and federation data-plane tests; no numeric tool coverage report generated.
- Checkpoint commit: `58fca1f` (`feat(websocket): add native Node and Bun surfaces`).

## Phase 4: Python Async Broker and ASGI Interoperability

- [x] Task: Add Python async Broker WebSocket API
    - [x] Scan Python `h2`, Broker, Guest, and ASGI WebSocket code for reusable protocol handling before edits.
    - [x] Add failing Python tests for async Broker opens to local, directly remote, and federated Node, Bun, and Python Guest endpoints.
    - [x] Implement the public async Broker WebSocket API with VWS/1 framing, negotiation, error, cancellation, ping/pong, and close semantics.
    - [x] Preserve compatibility with existing ASGI Guest WebSocket dispatch and route metadata.
    - [x] Delegate the Python implementation/tests to the configured implementation specialist.
    - [x] Validate the focused Python suite using `uv` and record coverage for changed behavior.
- [x] Task: Prove cross-runtime federation interoperability
    - [x] Add matrix integration coverage for Node, Bun, and Python Brokers reaching Node, Bun, and Python Guests through local, one-hop, and multi-hop routes.
    - [x] Verify text/binary boundaries, subprotocols, ping/pong, close propagation, cancellation, and unavailable negotiation outcomes across runtime boundaries.
    - [x] Validate cleanup after successful, failed, and aborted connections.

### Phase 4 Validation Notes

- Python `VerserBroker.websocket()`/`web_socket()` and `VerserBrokerWebSocket` expose bounded VWS/1 async send/receive, text/binary, subprotocol, ping/pong, close, abort, structured error, and flow-control behavior. ASGI Guest dispatch emits structured unavailable and missing-negotiation outcomes while preserving scope metadata.
- Verified with `npm test --workspace=@signicode/verser2-guest-python` (123 tests): 10 Broker WebSocket tests cover terminal pump finalization/unregistration, queued peer-close preservation, negotiation cancellation, timeout/reset, queue overflow, malformed/oversized handling, bounded errors, and waiter cancellation; 21 ASGI tests cover 1002/1009 wire validation, true application-exception 1011 mapping, shared lease activation accounting, metadata, and lifecycle; the remaining 92 tests cover existing Python HTTP/ASGI regressions.
- The guarded root matrix test has 27 auditable success cells: 3 Broker runtimes × 3 Guest runtimes × 3 topologies (local, one-hop, multi-hop). Every cell asserts text, binary, negotiated subprotocol, ping/pong, and observed close code/reason; Node/Bun cells additionally assert `socket.destroyed === true`, while Python cells assert an empty WebSocket ownership set. Live Python Guests configure two waiting WebSocket leases with a maximum of three and report readiness only after both Host lease streams activate.
- Final validation: `npm run test:bounded -- -- test/python-broker-websocket-integration.test.js` passed (1 guarded matrix test); canonical `npm test` passed after updating the expected structured VWS error code; `npm run build`, `npm run lint`, and the Python workspace compile/lint command passed.
- Coverage evidence: no numeric coverage tool is configured, so no >=95% claim is made. The auditable mapping above records 31 focused WebSocket tests plus 27 live matrix cells and names each changed behavior exercised; bounded memory is enforced by `guarded-test.cjs` (the matrix uses its explicit 4 MiB allowance for nine simultaneous Guest connections).
- Oracle review: after resolving in-scope repairs, Oracle review passed. Python VWS framing and lease accounting remain Python-runtime-specific; VWS/federation contracts (`@signicode/verser-common`) are shared protocol designs — no duplicate common implementation is needed.
- [x] Task: Conductor - Phase Checkpoint 'Python Async Broker and ASGI Interoperability' (Protocol in workflow.md)
    - [x] Review cross-runtime API and interoperability outcomes.
    - [x] Deduplicate shared behavior, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.
- Checkpoint commit: `51c052d` (`feat(websocket): add Python broker interoperability`).

## Phase 5: Documentation, Full Validation, and Review

- [ ] Task: Document federated WebSocket behavior and compatibility
    - [ ] Update public Node, Bun, and Python API documentation with standard runtime-facing examples and topology requirements.
    - [ ] Document route-advertisement neutrality, explicit rejection versus no-response negotiation failure, multi-hop behavior, lifecycle closure, limits, and unsupported future runtimes.
    - [ ] Update changelog, package READMEs, codemaps, and product/tech-stack documentation where public support status changes.
    - [ ] Delegate documentation work to the configured documentation specialist after source behavior is final.
    - [ ] Validate documentation claims against source and docs tests.
- [ ] Task: Execute final validation and review
    - [ ] Run targeted common, Host, Node, Bun, Python, federation, and WebSocket test suites; then run `npm run build`, `npm run lint`, and canonical `npm test`.
    - [ ] Confirm 95% meaningful changed-behavior coverage, bounded-memory behavior, no leaked streams/leases, and direct HTTP/WebSocket regression safety.
    - [ ] Delegate maintainability, security, lifecycle, and specification review to the configured review specialist.
    - [ ] Resolve validated findings with focused tests and rerun affected validation.
    - [ ] Post final validation results as a PR comment, mark the draft PR ready for review, and update the PR description if the implemented behavior requires clarification.
- [ ] Task: Conductor - Phase Checkpoint 'Documentation, Full Validation, and Review' (Protocol in workflow.md)
    - [ ] Confirm docs, tests, coverage, review findings, and PR state meet the track definition of done.
    - [ ] Record the final deduplication result and validation summary, commit the completed checkpoint, push the branch, and record its SHA.

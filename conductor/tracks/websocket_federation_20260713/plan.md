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
- [ ] Task: Define the shared, versioned federation-VWS contract
    - [ ] Scan `@signicode/verser-common` VWS and federation primitives plus existing HTTP federation contracts for reusable types, framing, loop checks, and error helpers.
    - [ ] Add focused failing common/Host tests for the federation-VWS endpoint, open/accept negotiation, and deterministic no-response negotiation failure.
    - [ ] Delegate the shared protocol/test implementation to the configured implementation specialist.
    - [ ] Implement protocol-neutral request/response contracts that preserve VWS/1 frames and route metadata without changing route advertisements.
    - [ ] Validate focused common/Host tests, build, and meaningful coverage for the new shared behavior.
- [ ] Task: Conductor - Phase Checkpoint 'Delivery Setup and Federation-VWS Contract' (Protocol in workflow.md)
    - [ ] Review the public federation protocol and branch/PR surface before subsequent cross-Host and public API work.
    - [ ] Deduplicate shared protocol code, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

## Phase 2: Host Multi-Hop Federation Data Plane

- [ ] Task: Add Host acquisition and forwarding for federation-VWS streams
    - [ ] Scan Host routing, federation, lease, authorization, and lifecycle code for common/reusable pieces before edits.
    - [ ] Add failing integration tests for real imported-only routes across one-hop and multi-hop Host topologies, replacing the current unsupported-federation regression.
    - [ ] Implement authenticated federation-VWS stream acquisition, exact `(targetId, domain)` candidate selection, and hop-by-hop forwarding to the destination Host's local Guest lease.
    - [ ] Preserve origin/via/hop-limit/loop protections and allow candidate failover only before accept.
    - [ ] Delegate the Host implementation and tests to the configured implementation specialist.
    - [ ] Validate focused WebSocket/federation tests and ensure direct local and near-remote Host routing remain unchanged.
- [ ] Task: Harden federation-VWS lifecycle, errors, and flow control
    - [ ] Add failing tests for authorization denial, explicit endpoint rejection, no negotiation response, mixed-version peer behavior, route revocation, Host/upstream/Guest loss, shutdown, cancellation, reset, and pre-accept failover.
    - [ ] Implement structured error propagation, deterministic post-accept close behavior, incremental backpressure, bounded queues, frame limits, and consumed-lease cleanup across each hop.
    - [ ] Add slow-consumer, malformed-frame, oversized-frame, ping/pong, and close-code/reason coverage without buffering whole traffic.
    - [ ] Run the narrow Host/common test set and record at least 95% meaningful changed-behavior coverage.
- [ ] Task: Conductor - Phase Checkpoint 'Host Multi-Hop Federation Data Plane' (Protocol in workflow.md)
    - [ ] Review architecture, security binding, lifecycle policy, and multi-hop semantics before runtime public API work.
    - [ ] Deduplicate Host/common code, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

## Phase 3: Native Node and Bun WebSocket Surfaces

- [ ] Task: Complete Node native-facing Broker and Guest compatibility
    - [ ] Scan existing Node WebSocket, Agent, Dispatcher, fetch, minimal HTTP, and public export surfaces for reusable adapters.
    - [ ] Add failing tests for Node standard-facing local, directly remote, and federated WebSocket connections, including subprotocols, text/binary, close, and errors.
    - [ ] Implement thin native-facing Node wrappers and compatibility paths over VWS/1 without regressing existing direct APIs or HTTP request behavior.
    - [ ] Delegate the Node implementation/tests to the configured implementation specialist.
    - [ ] Validate the focused Node suite, type declarations, and package build.
- [ ] Task: Add Bun native upgrade and Broker WebSocket support
    - [ ] Scan Bun adapter, route-table, public export, and test conventions before edits; reuse shared Node transport only where runtime semantics remain correct.
    - [ ] Add failing Bun tests for native upgrade/handler lifecycle and local, directly remote, and federated Broker connections.
    - [ ] Implement Bun-native Guest upgrade/WebSocket handling and Broker compatibility over VWS/1, preserving Bun message and close semantics.
    - [ ] Test explicit endpoint rejection and no-response negotiation failure through the Bun surface.
    - [ ] Validate focused Bun tests, type declarations, and package build.
- [ ] Task: Conductor - Phase Checkpoint 'Native Node and Bun WebSocket Surfaces' (Protocol in workflow.md)
    - [ ] Review the new public APIs and runtime ergonomics before Python and end-to-end finalization.
    - [ ] Deduplicate shared adapters, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

## Phase 4: Python Async Broker and ASGI Interoperability

- [ ] Task: Add Python async Broker WebSocket API
    - [ ] Scan Python `h2`, Broker, Guest, and ASGI WebSocket code for reusable protocol handling before edits.
    - [ ] Add failing Python tests for async Broker opens to local, directly remote, and federated Node, Bun, and Python Guest endpoints.
    - [ ] Implement the public async Broker WebSocket API with VWS/1 framing, negotiation, error, cancellation, ping/pong, and close semantics.
    - [ ] Preserve compatibility with existing ASGI Guest WebSocket dispatch and route metadata.
    - [ ] Delegate the Python implementation/tests to the configured implementation specialist.
    - [ ] Validate the focused Python suite using `uv` and record coverage for changed behavior.
- [ ] Task: Prove cross-runtime federation interoperability
    - [ ] Add matrix integration coverage for Node, Bun, and Python Brokers reaching Node, Bun, and Python Guests through local, one-hop, and multi-hop routes.
    - [ ] Verify text/binary boundaries, subprotocols, ping/pong, close propagation, cancellation, and unavailable negotiation outcomes across runtime boundaries.
    - [ ] Validate no leaked streams or leases after successful, failed, and aborted connections.
- [ ] Task: Conductor - Phase Checkpoint 'Python Async Broker and ASGI Interoperability' (Protocol in workflow.md)
    - [ ] Review cross-runtime API and interoperability outcomes.
    - [ ] Deduplicate shared behavior, record validation/coverage, commit the completed checkpoint, push the branch, and record its SHA.

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

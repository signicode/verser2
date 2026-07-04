# Implementation Plan: Streaming Improvements

## Phase 1: Track Setup, Design Baseline, and Roadmap Pruning

- [ ] Task: Create implementation branch and PR review surface
    - [ ] Capture the current branch as the PR base branch.
    - [ ] Create the implementation branch with name `conductor/streaming_improvements_20260704` or a sanitized equivalent.
    - [ ] Perform all implementation work on this branch, making commits according to the resolved commit frequency policy: per task.
    - [ ] Open or update a draft PR targeting the captured base branch when the Branching Policy requires PR visibility or finalization.
- [ ] Task: Establish streaming source inventory and design baseline
    - [ ] Read package codemaps for `verser-common`, `verser2-host`, `verser2-guest-node`, `verser2-guest-bun`, and `verser2-guest-python` before implementation.
    - [ ] Inspect current Host lease-stream routing, local peer streaming, Node Broker/Agent/Dispatcher/fetch paths, Bun wrapper paths, Python ASGI streaming paths, common envelope/body/stream-reader helpers, and existing tests.
    - [ ] Record in this plan that chunked encoding means semantic byte/event streaming and practical application write-boundary preservation, not literal HTTP/1 chunk-frame forwarding across HTTP/2.
    - [ ] Record common-library reuse decisions for any stream, abort, error, or protocol helpers.
- [ ] Task: Prune roadmap and documentation scope claims
    - [ ] Update `ROADMAP.md`, README/docs, package READMEs, codemaps, and Conductor product/tech-stack docs as needed to remove CONNECT tunneling and generic L4 forwarding as future roadmap targets.
    - [ ] Remove Python Host and Python fetch/Agent/Dispatcher helpers from roadmap/future claims while keeping Python ASGI Guest/Broker scope.
    - [ ] Keep HTTP/3, trailers, informational responses, and gateway/auth policy out of scope unless existing docs already describe them accurately as unsupported.
    - [ ] Validate docs with the narrowest relevant docs/package checks.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Write streaming characterization tests before behavior changes
    - [ ] Add or identify tests for large streaming request and response bodies without full-body buffering.
    - [ ] Add or identify tests for slow producer/consumer backpressure behavior.
    - [ ] Add or identify tests for Broker abort, Guest abort, route revocation during stream, disconnect during stream, and half-open request/response behavior.
    - [ ] Add or identify federation/upstream abort and keep-alive/waiter cleanup tests.
    - [ ] Confirm new tests fail for missing behavior or record that existing behavior already passes and is now characterized.
- [ ] Task: Conductor - Phase Checkpoint 'Track Setup, Design Baseline, and Roadmap Pruning' (Protocol in workflow.md)

## Phase 2: Core Node HTTP Streaming and Abort Propagation

- [ ] Task: Harden Host lease-stream request/response forwarding
    - [ ] Review existing common helpers before implementation and avoid duplicating protocol-neutral stream/error logic.
    - [ ] Improve Host Broker-to-Guest lease stream forwarding to preserve streaming/backpressure behavior and deterministic cleanup.
    - [ ] Propagate Broker-side abort/cancel to Guest lease streams and clean up Host active/idle lease state.
    - [ ] Propagate Guest-side response abort/failure to Broker response streams with structured diagnostics.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host` and focused Host routing tests.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Harden Node Guest and Broker streaming surfaces
    - [ ] Improve Node Broker `request()` streaming behavior, including large bodies and abort/cancel handling.
    - [ ] Improve Node Guest minimal HTTP shim behavior for streamed request and response bodies where needed.
    - [ ] Preserve semantic streaming without promising literal HTTP/1 chunk-frame preservation.
    - [ ] Run `npm run build --workspace=@signicode/verser2-guest-node` and focused Node Guest/Broker tests.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Harden Agent and Dispatcher/fetch streaming surfaces
    - [ ] Improve Agent request body streaming, response streaming, chunked upload handling, and abort signal propagation where feasible.
    - [ ] Improve Dispatcher/fetch streaming and abort behavior while preserving Undici-compatible semantics.
    - [ ] Update tests for large bodies, aborts, slow consumers, and redirect replay boundaries.
    - [ ] Run focused `test/agent.test.js` and `test/dispatcher.test.js` validation.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Conductor - Phase Checkpoint 'Core Node HTTP Streaming and Abort Propagation' (Protocol in workflow.md)

## Phase 3: Federation, Keep-Alive, Bun, and Python ASGI Parity

- [ ] Task: Harden federated/upstream streaming behavior
    - [ ] Improve Host-to-Host federated request/response streaming abort propagation and structured error preservation.
    - [ ] Add or update tests for mid-stream Broker abort across federated forwarding.
    - [ ] Add or update tests for upstream disconnect, waiting stream cleanup, and no leaked waiters/leases.
    - [ ] Clarify keep-alive/liveness behavior for idle leases and upstream waiting sockets/streams without introducing CONNECT/L4 semantics.
    - [ ] Run `npm run build --workspace=@signicode/verser2-host` and `node --test test/host-upstreams.test.js`.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Update Bun wrapper parity
    - [ ] Confirm Bun Guest/Broker wrappers inherit the improved Node transport streaming behavior.
    - [ ] Update Bun tests and docs for supported streaming behavior.
    - [ ] Preserve Bun WebSocket support decisions for the dedicated WebSocket phase.
    - [ ] Run `npm run build --workspace=@signicode/verser2-guest-bun` and focused Bun tests.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Harden Python ASGI HTTP streaming parity
    - [ ] Improve Python ASGI HTTP request/response streaming behavior where needed, without adding Python Host/fetch/Agent/Dispatcher APIs.
    - [ ] Add or update Python ASGI tests for large streaming responses, async iterable request bodies, disconnect/abort behavior, and backpressure/lifecycle cleanup where practical.
    - [ ] Keep ASGI websocket support deferred to the WebSocket phase design decision inside this track.
    - [ ] Run Python package tests and relevant Node/Python integration tests.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Conductor - Phase Checkpoint 'Federation, Keep-Alive, Bun, and Python ASGI Parity' (Protocol in workflow.md)

## Phase 4: WebSocket Design Gate and Implementation

- [ ] Task: Design WebSocket transport strategy and pause for approval
    - [ ] Document the chosen WebSocket strategy: HTTP/1.1 upgrade handling, HTTP/2 RFC 8441 extended CONNECT constraints, or another explicit Verser protocol approach.
    - [ ] Define supported runtime surfaces for this track: Node, Bun, and/or Python ASGI websocket scopes.
    - [ ] Define full-duplex lifecycle, close codes/reasons, ping/pong behavior, abort/cancel mapping, backpressure, limits, timeouts, and route lifecycle behavior.
    - [ ] Explicitly confirm that generic CONNECT tunneling and generic L4 forwarding remain out of scope.
    - [ ] Pause for user approval before implementing WebSocket protocol/API changes.
- [ ] Task: Add WebSocket acceptance tests before implementation
    - [ ] Add tests for successful WebSocket connection setup on the approved runtime surface.
    - [ ] Add tests for bidirectional message flow, close handshake, abnormal close/abort, backpressure, route revocation/disconnect, and Host/federation behavior where in scope.
    - [ ] Confirm tests fail for missing WebSocket behavior before implementation.
- [ ] Task: Implement approved WebSocket support
    - [ ] Implement only the approved WebSocket runtime surfaces and protocol/API changes.
    - [ ] Preserve existing HTTP request/response behavior and avoid introducing generic tunnel behavior.
    - [ ] Update Node/Bun/Python adapters according to the approved design.
    - [ ] Run focused WebSocket validation and affected package builds.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Conductor - Phase Checkpoint 'WebSocket Design Gate and Implementation' (Protocol in workflow.md)

## Phase 5: Documentation, Review, and Final Validation

- [ ] Task: Update docs and codemaps for implemented streaming and WebSocket behavior
    - [ ] Update README, docs, package READMEs, codemaps, and public API references to reflect supported streaming and WebSocket behavior.
    - [ ] Ensure docs do not present Verser2 as a generic tunnel, L4 forwarder, public gateway, Python Host, or Python fetch/Agent/Dispatcher provider.
    - [ ] Document unsupported items: literal HTTP/1 chunk-frame forwarding, CONNECT/L4, HTTP/3, trailers, informational responses, and complete gateway/auth policy.
    - [ ] Run docs/package validation checks.
    - [ ] Commit this completed task according to the per-task commit policy.
- [ ] Task: Code review and architecture review
    - [ ] Delegate a review to the configured review specialist after implementation is complete.
    - [ ] Address in-scope findings around stream lifecycle, cleanup, backpressure, abort propagation, WebSocket boundaries, docs accuracy, and common-library reuse.
    - [ ] Re-run the narrowest validation for any review-driven changes.
    - [ ] Commit review-driven changes according to the per-task commit policy.
- [ ] Task: Run final validation
    - [ ] Run affected package builds for common, Host, Node Guest, Bun Guest, and Python package checks.
    - [ ] Run focused tests for Host routing, Host upstreams, local peers, Broker routing, common envelope/body helpers, Agent, Dispatcher, Node Guest, Bun wrapper, Python Guest/Broker integration, and WebSockets.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Confirm 95% meaningful coverage for changed behavior or record justified exceptions.
    - [ ] Commit final validation/plan updates according to the per-task commit policy if files changed.
- [ ] Task: Branching Policy finalization
    - [ ] Ensure all completed task work is committed.
    - [ ] Push the implementation branch.
    - [ ] Open or update the draft PR targeting the captured base branch using the track `spec.md` as the PR body.
    - [ ] Post final verification results as a PR comment.
    - [ ] Mark the PR ready only after final verification is complete.
- [ ] Task: Conductor - Phase Checkpoint 'Documentation, Review, and Final Validation' (Protocol in workflow.md)

# Implementation Plan: Streaming Improvements

## Phase 1: Track Setup, Design Baseline, and Roadmap Pruning

- [x] Task: Create implementation branch and PR review surface
    - [x] Capture the current branch as the PR base branch: `main`.
    - [x] Create the implementation branch with name `conductor/streaming_improvements_20260704` or a sanitized equivalent: `conductor/streaming_improvements`.
    - [x] Perform all implementation work on this branch, making commits according to the resolved commit frequency policy: per task.
    - [x] Open or update a draft PR targeting the captured base branch when the Branching Policy requires PR visibility or finalization: https://github.com/signicode/verser2/pull/51.
- [x] Task: Establish streaming source inventory and design baseline
    - [x] Read package codemaps for `verser-common`, `verser2-host`, `verser2-guest-node`, `verser2-guest-bun`, and `verser2-guest-python` before implementation.
    - [x] Inspect current Host lease-stream routing, local peer streaming, Node Broker/Agent/Dispatcher/fetch paths, Bun wrapper paths, Python ASGI streaming paths, common envelope/body/stream-reader helpers, and existing tests.
    - [x] Record in this plan that chunked encoding means semantic byte/event streaming and practical application write-boundary preservation, not literal HTTP/1 chunk-frame forwarding across HTTP/2.
    - [x] Record common-library reuse decisions for any stream, abort, error, or protocol helpers.

    Inventory notes: Host lease-stream and federation routing are centered in `packages/verser2-host/src/lib/broker-routing.ts`, `lease-pool.ts`, `local-peers.ts`, and `federation.ts`; Node Guest/Broker streaming surfaces are in `packages/verser2-guest-node/src/lib/http2-verser-node-guest.ts`, `minimal-http.ts`, `http2-verser-broker.ts`, `broker-agent.ts`, `broker-socket.ts`, `broker-dispatcher.ts`, and `dispatch-controller.ts`; Bun parity is mostly adapter-level in `packages/verser2-guest-bun/src/lib/adapter.ts`; Python ASGI streaming is in `packages/verser2-guest-python/src/verser2_guest_python/guest.py`, `asgi.py`, `broker.py`, and `protocol.py`; common envelope/body helpers are in `packages/verser-common/src/lib/envelope.ts`, `stream-readers.ts`, `body.ts`, and `errors.ts`. Existing tests already characterize core streaming in `test/broker-routing.test.js`, `test/dispatcher.test.js`, `test/agent.test.js`, `test/local-peers.test.js`, `test/guest-node.test.js`, `test/end-to-end.test.js`, `test/host-upstreams.test.js`, `test/common-envelope.test.js`, `packages/verser2-guest-bun/test/adapter.test.ts`, and `packages/verser2-guest-python/tests/test_asgi_guest.py`; remaining gaps include explicit half-open stream behavior, full-path backpressure across slow consumers, idle lease keep-alive/waiter cleanup, Python abort propagation, Python Broker slow-consumer behavior, Bun cancellation, federation backpressure, and direct `ChunkedBodyDecoder` edge cases.

    Chunked encoding / semantic streaming note: in this codebase "streaming" means writing HTTP request/response body bytes incrementally and forwarding them as raw bytes over HTTP/2 DATA frames, with practical write-boundary preservation where runtimes expose it, not preserving literal HTTP/1 `Transfer-Encoding: chunked` framing across the HTTP/2 transport. The Verser envelope header separates metadata from the body; after metadata is consumed, the body is an opaque byte stream. Node lease/federation paths use stream `pipe()` and Python uses explicit `send_data()`, so HTTP/2 flow control and runtime buffering may merge writes. The Node Broker socket `ChunkedBodyDecoder` decodes incoming HTTP/1 chunked client bodies before forwarding decoded bytes; it does not re-encode chunks for the lease stream.

    Common-library reuse decision: continue using `@signicode/verser-common` for protocol-neutral envelope, stream-reader, header, and structured error helpers (`encodeVerserEnvelope`, `createVerserEnvelopeParser`, `readVerserEnvelopeFromStream`, `readLeaseRequestMetadataFromStream`, `readLeaseResponseMetadataFromStream`, `VerserError`, and header sanitization/validation). Flow-control acknowledgement, stream body dispatch, chunked decoding, redirect replay, and cancellation remain runtime/package-specific unless repeated cross-package behavior emerges; Python `protocol.py` remains a parallel wire-format implementation that must stay compatible with common envelope changes.
- [x] Task: Prune roadmap and documentation scope claims
    - [x] Update `ROADMAP.md`, README/docs, package READMEs, codemaps, and Conductor product/tech-stack docs as needed to remove CONNECT tunneling and generic L4 forwarding as future roadmap targets.
        - ROADMAP.md: Removed P2.3 block (generic stream-like connectivity) as future roadmap work.
        - conductor/product.md: Removed "Python Host behavior" from the MVP limitations list; kept HTTP/3, browser/Rust/Go/Java guests, advanced Agent behavior, Broker per-request authorization, auth/authz systems, WebSocket forwarding for Bun, and public gateway policy as future track work. Added explicit "Python Host is not implemented and is not on the current roadmap."
        - README/docs/package READMEs/codemaps: No changes needed for the CONNECT/L4 removal scope at this time.
    - [x] Remove Python Host and Python fetch/Agent/Dispatcher helpers from roadmap/future claims while keeping Python ASGI Guest/Broker scope.
        - AGENTS.md: Reworded usage-boundary sentence to state "Python Host is not implemented and is not on the current roadmap. Browser, Rust, Go, and Java guests remain roadmap work unless a future development track changes that."
        - conductor/product.md: Updated MVP limitations — removed "Python Host behavior" from the future-track list, added separate "Python Host is not implemented and is not on the current roadmap." sentence. The "Incremental language expansion" principle already describes browser/Rust/Go/Java as roadmap.
    - [x] Keep HTTP/3, trailers, informational responses, and gateway/auth policy out of scope unless existing docs already describe them accurately as unsupported.
        - No changes needed; existing ROADMAP.md P2.1 (HTTP/3), P2.2 (WebSocket), and P1/P2 gateway items already describe these as unsupported or future work.
    - [x] Validate docs with the narrowest relevant docs/package checks.
        - Ran `node --test test/docs.test.js test/python-guest-documentation.test.js` — all 9 tests passed (no build needed; tests only use core Node modules). Re-ran after orchestrator wording adjustment with the same passing result.
    - [x] Commit this completed task according to the per-task commit policy.
        - Committed by orchestrator after review of delegated changes.
- [x] Task: Write streaming characterization tests before behavior changes
    - [x] Add or identify tests for large streaming request and response bodies without full-body buffering.
        - Added `test/broker-routing.test.js`: `broker.request streams multi-megabyte request body without full buffering` — 2MB upload via PassThrough in 64KB chunks, guest verifies total received bytes. **Passes.**
        - Added `test/broker-routing.test.js`: `broker.request streams multi-megabyte response body without full buffering` — 2MB response written in 64KB chunks by guest handler, broker reads full body. **Passes.**
        - Identified existing `test/broker-routing.test.js` "Host pipes leased response body to Broker before the lease ends" — raw H2 test showing split metadata/body streaming.
        - Identified existing `test/agent.test.js` "Broker Agent resumes streamed responses after client-side backpressure" — 256KB response with pause/resume.
    - [x] Add or identify tests for slow producer/consumer backpressure behavior.
        - Added `test/dispatcher.test.js`: `Broker Dispatcher streams large response bodies with controlled backpressure` — 512KB response read with 5ms delays every 4 chunks via fetch reader. **Passes.**
        - Identified existing `test/agent.test.js` "Broker Agent resumes streamed responses after client-side backpressure" (256KB, pause/resume) — characterizes existing backpressure behavior.
    - [x] Add or identify tests for Broker abort, Guest abort, route revocation during stream, disconnect during stream, and half-open request/response behavior.
        - Added `test/broker-routing.test.js`: `broker.request delivers response headers and body before request body ends (half-open)` — response written before request body fully received. **Passes.**
        - Added `test/broker-routing.test.js`: `Guest route revocation alone does not cancel active lease stream (gap: only Guest disconnect closes it)` — revocation does NOT interrupt active stream; only Guest disconnect does. **Passes (characterizes gap).**
        - Added `test/broker-routing.test.js`: `Broker request abort does NOT propagate as an explicit error event to Guest handler request stream (gap: cancellation closes lease but no error event)` — NGHTTP2_CANCEL closes lease but produces no request `error` event. **Passes (characterizes gap).**
        - Added `test/dispatcher.test.js`: `Broker Dispatcher fetch cancellation during streamed response closes the underlying stream` — reader.cancel() after partial read is clean. **Passes.**
        - Identified existing `test/broker-routing.test.js` "Broker abort cancels the active leased stream" — raw H2 CANCEL test.
        - Identified existing `test/broker-routing.test.js` "Guest disconnect fails an active leased Broker request".
        - Identified existing `test/broker-routing.test.js` "Guest handler failure after response start cancels the Broker response stream".
        - Identified existing `test/local-peers.test.js` "HTTP/2 Broker abort cancels an in-flight local Guest dispatch".
        - Identified existing `test/dispatcher.test.js` "Broker Dispatcher propagates fetch aborts without dangling response streams".
    - [x] Add or identify federation/upstream abort and keep-alive/waiter cleanup tests.
        - Added `test/host-upstreams.test.js`: `Upstream disconnect during an active federated request fails the Broker request` — disconnect upstream link mid-request; broker request fails. **Passes.**
        - Added `test/host-upstreams.test.js`: `Federated forwarding does NOT propagate mid-stream Broker abort as an explicit error to downstream Guest (gap: cancellation closes lease but no error event through federation)` — NGHTTP2_CANCEL through federation closes lease but produces no request `error` event on downstream Guest. **Passes (characterizes gap).**
        - Added `test/host-upstreams.test.js`: `Federated request completes or fails cleanly when upstream Host closes during dispatch (characterization: no leaked state)` — upstream close during in-flight request is handled without leaked state. **Passes.**
        - Identified existing `test/host-upstreams.test.js` "Unexpected upstream disconnect removes imported routes and emits lifecycle".
    - [x] Confirm new tests fail for missing behavior or record that existing behavior already passes and is now characterized.
        - All characterization tests pass. Known gaps are documented in test names with "(gap: ...)" suffix:
            - Route revocation during active stream: revocation alone does NOT cancel lease; only Guest disconnect does.
            - Broker abort propagation: NGHTTP2_CANCEL closes lease but does NOT emit `error` event on Guest request stream.
            - Federation abort propagation: NGHTTP2_CANCEL through federation closes lease but does NOT emit `error` event.
        - All added tests intentionally document these gaps without marking them as passing behavior.
        - Validation commands: `node --test --test-name-pattern="<pattern>" test/broker-routing.test.js test/dispatcher.test.js test/host-upstreams.test.js`
        - Validation results: 11/11 new characterization tests pass (3 document known gaps without failing).
    - [x] Oracle review of Phase 1 characterization tests:
        - Finding #1: `test/broker-routing.test.js` route-revocation test used `requestDataReceived` which was set by pre-revocation chunk. **Fixed**: Changed to promise-based tracking that specifically resolves when post-revocation (`more-data`) chunk arrives.
        - Finding #2: `test/dispatcher.test.js` fetch cancellation test only checked `reader.cancel()` resolved. **Fixed**: Restructured to prove Guest-side request stream ends after cancel via `request.resume()` (flowing mode to consume buffered data) + `request.once('end')`.
        - Timing flake reduction: Replaced polling/boolean patterns with promise races and bounded timeouts throughout touched tests.
        - Validation after fixes: `node --test test/broker-routing.test.js test/dispatcher.test.js` → 57/57 pass, 0 fail.
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

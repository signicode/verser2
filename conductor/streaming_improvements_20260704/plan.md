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
        - Added `test/broker-routing.test.js`: `Guest route revocation soft-removes the route without cancelling an active HTTP lease` — revocation does not interrupt an active stream; only Guest disconnect does. **Passes (characterizes intentional soft-removal semantics).**
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
        - All characterization tests pass. The intentional soft-removal behavior is documented in the route-revocation test:
            - Route revocation during active stream: revocation alone does not cancel the lease; only Guest disconnect does.
            - Broker abort propagation: NGHTTP2_CANCEL closes lease but does NOT emit `error` event on Guest request stream.
            - Federation abort propagation: NGHTTP2_CANCEL through federation closes lease but does NOT emit `error` event.
        - All added tests intentionally document these current lifecycle semantics without changing them.
        - Validation commands: `node --test --test-name-pattern="<pattern>" test/broker-routing.test.js test/dispatcher.test.js test/host-upstreams.test.js`
        - Validation results: 11/11 new characterization tests pass (3 document known gaps without failing).
    - [x] Oracle review of Phase 1 characterization tests:
        - Finding #1: `test/broker-routing.test.js` route-revocation test used `requestDataReceived` which was set by pre-revocation chunk. **Fixed**: Changed to promise-based tracking that specifically resolves when post-revocation (`more-data`) chunk arrives.
        - Finding #2: `test/dispatcher.test.js` fetch cancellation test used GET with empty body; `request.once('end')` could fire before `reader.cancel()` due to natural stream end, so it did not prove cancellation propagation. **Fixed**: Changed to POST with a streaming `PassThrough` request body that stays open — the handler's request stream cannot end on its own. Pre-cancel 30ms window proves `end`/`close` did not fire before cancel. After `reader.cancel()`, the Guest-side request stream `end`/`close` fires within 150ms, proving remote propagation.
        - Timing flake reduction: Replaced polling/boolean patterns with promise races and bounded timeouts throughout touched tests.
        - Validation after fixes: `node --test test/broker-routing.test.js test/dispatcher.test.js` → 57/57 pass, 0 fail.
- [x] Task: Conductor - Phase Checkpoint 'Track Setup, Design Baseline, and Roadmap Pruning' (Protocol in workflow.md)
    - Phase 1 completed on branch `conductor/streaming_improvements` with draft PR https://github.com/signicode/verser2/pull/51.
    - Common-library review/deduplication: Phase 1 was documentation and characterization-test work. Existing common helpers in `@signicode/verser-common` were inventoried for future phases; no new reusable code emerged and no common-code movement was needed.
    - Validation: `node --test test/docs.test.js test/python-guest-documentation.test.js` passed 9/9; `node --test test/broker-routing.test.js test/dispatcher.test.js test/host-upstreams.test.js` passed 94/94 before review fixes; post-review targeted validation `node --test test/dispatcher.test.js` passed 10/10 and `node --test test/broker-routing.test.js test/dispatcher.test.js` passed 57/57.
    - Coverage: no production behavior changed; Phase 1 added characterization tests and documentation updates, so coverage threshold is not applicable to production code changes.
    - Review: Oracle review initially held Phase 2 for two characterization-test issues. The route-revocation and dispatcher-cancellation tests were strengthened, then oracle final re-review reported no blocking findings and approved beginning Phase 2.
    - Phase checkpoint commits: setup `19d1d59`, PR record `ea15b2c`, inventory `2908a85`, roadmap/docs pruning `ee6e447`, characterization tests `a86ec24`, characterization review fixes `5d0607e`, dispatcher cancellation proof `5129297`.

## Phase 2: Core Node HTTP Streaming and Abort Propagation

- [x] Task: Harden Host lease-stream request/response forwarding
    - [x] Review existing common helpers before implementation and avoid duplicating protocol-neutral stream/error logic.
        - Common helpers in `@signicode/verser-common` (`envelope.ts`, `stream-readers.ts`, `body.ts`, `errors.ts`) provide protocol-neutral envelope encode/decode, stream-based metadata reading, body normalization, and `VerserError` creation. No new common helpers were needed — the existing `encodeVerserEnvelope`, `readLeaseResponseMetadataFromStream`, and `createVerserError` surface is sufficient for the Host-only improvements.
        - Host-side `utils.ts` `toVerserError()` is used for wrapping unknown errors and is already imported by `broker-routing.ts`.
        - Reuse decision: no common-library extraction needed at this point. The `routeBrokerRequestOverLease` and `routeLocalRequestToH2Guest` patterns are Host-specific and do not duplicate protocol logic available in common.
    - [x] Improve Host Broker-to-Guest lease stream forwarding to preserve streaming/backpressure behavior and deterministic cleanup.
        - `routeBrokerRequestOverLease` (`broker-routing.ts`): Removed the overly broad `stream.once('close', cancelLease)` listener (which fired on *any* stream closure including normal completion) and replaced with focused `'aborted'` + `'error'` listeners only. Added proper listener cleanup (`cleanupCancellation()`) that fires on response-body pipeline completion (finish/error/close). Added `stream.unpipe()` before closing the lease on Broker abort to stop body data flow cleanly.
        - `routeLocalRequestToH2Guest`: No changes needed — the signal-based cancellation and `finally`-based listener cleanup already provide correct cleanup.
    - [x] Propagate Broker-side abort/cancel to Guest lease streams and clean up Host active/idle lease state.
        - When Broker stream is aborted or errors, `cancelLease()` unipes the body pipe and closes the lease stream with `NGHTTP2_CANCEL`. The lease pool's existing `removeLease` handler (registered on lease stream 'close' in `node-http2-verser-host.ts`) already cleans up the active/idle maps.
        - The error-envelope approach (writing a structured `'error'` envelope to the lease stream before closing) was considered but rejected: the Guest side is already past the request-envelope phase and reading body bytes at abort time, so an additional envelope would be consumed as corrupted body data rather than detected as a protocol error.
    - [x] Propagate Guest-side response abort/failure to Broker response streams with structured diagnostics.
        - Changed `lease.stream.once('error')` handler in `routeBrokerRequestOverLease` (post-response phase) to use `NGHTTP2_INTERNAL_ERROR` instead of `NGHTTP2_CANCEL`. This distinguishes Guest-side stream failures from Broker-originated cancellations in H2-level diagnostics.
        - The response error handler now also sets `completed = true` to prevent any stale cancellation action.
    - [x] Run `npm run build --workspace=@signicode/verser2-host` and focused Host routing tests.
        - Build: `npm run build --workspace=@signicode/verser2-host` passes.
        - `node --test test/broker-routing.test.js`: 47/47 pass (gap tests remain passing as characterization — behavior unchanged for Guest-side 'error' event propagation, which requires Guest code changes in the next task).
        - `node --test test/dispatcher.test.js test/host-upstreams.test.js`: 47/47 pass.
        - `node --test test/local-peers.test.js test/agent.test.js`: 30/30 pass.
        - Orchestrator reran the same build and focused validations before commit with passing results.
    - [x] Commit this completed task according to the per-task commit policy.

    **Deferrals:**
    - *Route revocation during active stream*: The current behavior (revocation removes routes from the registry but does not interrupt active lease streams) is intentional — active requests complete normally, new routing fails with `missing-guest`. Changing this belongs in Phase 3 (Federation/Keep-Alive) where idle-lease and waiting-stream lifecycle semantics are addressed. The route-revocation test in `test/broker-routing.test.js` continues to characterize this behavior.
    - *Broker abort → Guest handler 'error' event*: NGHTTP2_CANCEL propagation to the Guest handler's request stream (`IncomingMessage`/`MinimalIncomingMessage`) requires Guest-side changes — either at the H2 stream level (detecting `rstCode !== NO_ERROR` in `dispatchLeasedRequest`) or in the `MinimalIncomingMessage` wrapper. This is part of Task 2 ("Harden Node Guest and Broker streaming surfaces"). The existing gap test at line 2560 continues to characterize the gap.
    - *Federated abort propagation*: The federation-stream paths (`routeH2BrokerRequestOverFederationStream`, `routeLocalRequestOverFederationStream`) already use the `cleanupCancellation()` pattern and correct error propagation. Federation-specific abort propagation changes belong in Phase 3.
- [x] Task: Harden Node Guest and Broker streaming surfaces
     - [x] Review existing common helpers before implementation and avoid duplicating protocol-neutral logic.
         - Common helpers in `@signicode/verser-common` (`envelope.ts`, `stream-readers.ts`, `body.ts`, `errors.ts`) were reviewed. No new common helpers were needed — the existing `createVerserError`, `encodeVerserEnvelope`, and `readLeaseRequestMetadataFromStream` surface is sufficient.
         - Reuse decision: no common-library extraction needed. The `stream-failure` VerserError code already exists for stream-level failures.
     - [x] Improve Node Broker `request()` streaming behavior, including large bodies and abort/cancel handling.
         - `http2-verser-broker.ts` `requestOnce()`: Added `stream.once('close')` handler that cleans up the body pipe (`body.unpipe(stream)`, `body.destroy()`) when the H2 stream closes mid-stream. When `rstCode` indicates a non-NO_ERROR code, the pending request promise is rejected with a `stream-failure` error, preventing a hung promise when the remote peer resets the stream during body upload.
     - [x] Improve Node Guest minimal HTTP shim behavior for streamed request and response bodies where needed.
         - `http2-verser-node-guest.ts` `dispatchLeasedRequest()`: Added `lease.stream.once('aborted')` handler that detects H2 RST cancellation (non-NO_ERROR `rstCode`) and propagates a `stream-failure` error to the handler's request stream via `localRequest.emit('error', ...)`. The error fires after the request stream has ended normally (because H2 'end' fires before 'aborted'), so `emit('error')` is used instead of `destroy()` (which would be a no-op on an already-ended stream).
         - Added `selfCancelled` flag to suppress spurious error emission when the Guest itself cancels the lease (e.g. handler throws after response start), avoiding double-reporting.
         - `minimal-http.ts` `MinimalServerResponse`: Added `'close'` listener on output stream that emits `stream-failure` error if the output stream closes with a non-NO_ERROR RST code before the response finishes. Also added `finished` property to track whether `end()` was called.
         - `minimal-http.ts` `MinimalIncomingMessage`: Added default no-op `'error'` handler to prevent process crashes from unhandled 'error' events on the PassThrough, matching Node.js `IncomingMessage` behavior. Handlers that explicitly listen for `'error'` still receive the event.
     - [x] Preserve semantic streaming without promising literal HTTP/1 chunk-frame preservation.
         - All changes work within the existing H2 DATA frame forwarding model. No chunked encoding re-introduction or HTTP/1 frame preservation.
     - [x] Run `npm run build --workspace=@signicode/verser2-guest-node` and focused Node Guest/Broker tests.
         - Build: `npm run build --workspace=@signicode/verser2-guest-node` passes.
         - Host regression build: `npm run build --workspace=@signicode/verser2-host` passes.
         - `node --test test/broker-routing.test.js test/guest-node.test.js test/dispatcher.test.js test/agent.test.js test/host-upstreams.test.js test/end-to-end.test.js`: 126/126 pass.
         - `node --test test/common-envelope.test.js test/docs.test.js`: 18/18 pass.
         - New passing behavior: "Broker request abort propagates as an error event to Guest handler request stream" — previously a characterization gap, now the Guest request stream receives `'error'` with `code='stream-failure'` when the remote peer cancels.
         - Existing gap restored: "Federated forwarding does NOT propagate mid-stream Broker abort as an explicit error to downstream Guest" — federation-local-guest path requires separate work in Phase 3 (AbortController/signal propagation in `routeLocalRequestDispatch`).
     - [x] Commit this completed task according to the per-task commit policy.
         - Committed by orchestrator after review and validation.
- [x] Task: Harden Agent and Dispatcher/fetch streaming surfaces
     - [x] Review existing `@signicode/verser-common` helpers before implementation; do not duplicate protocol-neutral logic.
         - Common helpers in `@signicode/verser-common` (`envelope.ts`, `stream-readers.ts`, `body.ts`, `errors.ts`) were reviewed. The existing `normalizeBrokerRequestBody`, `createVerserError`, and `VerserError` surface is sufficient. No new common helpers were needed.
         - The Node `toBrokerRequestBody` in `utils.ts` parallels `normalizeBrokerRequestBody` from common but adds controller-tracking (`emitBodySent`, `emitRequestSent`). This is Node-dispatcher-specific and not protocol-neutral — no deduplication is warranted.
         - Reuse decision: no common-library extraction needed. The `stream-failure` VerserError code already exists and is used for stream-level failures.
     - [x] Improve Agent request body streaming, response streaming, chunked upload handling, and abort signal propagation where feasible.
         - `broker-socket.ts`: Added `responseBody` field to track the in-flight Broker response body stream for cleanup on socket destroy. Updated `_destroy()` to destroy both `bodyStream` (request body) and `responseBody` with the error on abort, or end/destroy on normal cleanup. Previously `_destroy` only called `bodyStream?.end()` leaving the response body uncleaned, which could keep data flowing through the pipe after the client socket was destroyed.
         - `broker-socket.ts` `forwardRequest()`: Now stores `response.body` reference for cleanup.
         - The existing `_write` → `consumeRequestBytes` → `forwardRequestOnce` path already streams request body bytes as they arrive (chunked uploads via `ChunkedBodyDecoder`, plain bodies via `PassThrough`). No additional streaming changes were needed for the basic path.
     - [x] Improve Dispatcher/fetch streaming and abort behavior while preserving Undici-compatible semantics.
         - `dispatch-controller.ts`: Added `requestBody` field and `attachRequestBody()` method. Updated `abort()` to destroy both `requestBody` and `responseBody` streams on abort, so mid-upload aborts stop sending request data upstream and mid-response aborts stop consuming downstream data.
         - `broker-dispatcher.ts`: Calls `controller.attachRequestBody(body)` when the body is a `Readable` stream, enabling the controller to destroy it on abort.
     - [x] Update tests for large bodies, aborts, slow consumers, and redirect replay boundaries.
         - `test/agent.test.js`:
             - Added `Broker Agent cleans up when client aborts during body upload` — destroys agent `http.request()` mid-upload, verifies clean error without hangs.
             - Added `Broker Agent cleans up when client aborts during response streaming` — destroys request mid-response, verifies clean error.
             - Added `Broker Agent streams large request bodies through leased routing` — 256KB body through Agent, verifies all bytes received.
             - Added `Broker Agent does not follow internal redirect when request body exceeds replay buffer` — 256-byte body with 128-byte replay buffer, verifies original 308 response is returned unchanged.
         - `test/dispatcher.test.js`:
             - Added `Broker Dispatcher propagates abort signal during request body upload` — AbortController abort during PassThrough body upload, verifies fetch rejects with abort error.
             - Added `Broker Dispatcher streams large request body through fetch` — 256KB body through fetch dispatcher, verifies all bytes received.
     - [x] Run focused `test/agent.test.js` and `test/dispatcher.test.js` validation, plus build for `@signicode/verser2-guest-node`.
         - Build: `npm run build --workspace=@signicode/verser2-guest-node` passes.
         - Host regression build: `npm run build --workspace=@signicode/verser2-host` passes.
         - `node --test test/agent.test.js test/dispatcher.test.js`: 23/23 pass.
         - Full regression `node --test test/agent.test.js test/dispatcher.test.js test/broker-routing.test.js test/guest-node.test.js test/end-to-end.test.js test/host-upstreams.test.js test/local-peers.test.js`: 155/155 pass.
         - `npm run lint`: initially reported formatting-only issues in touched test/source files; after `biome check --write`, `npm run lint` passes and `node --test test/agent.test.js test/dispatcher.test.js` still passes 23/23.
     - [x] Commit this completed task according to the per-task commit policy.
         - Committed by orchestrator after review, formatting, lint, and validation.
- [x] Task: Conductor - Phase Checkpoint 'Core Node HTTP Streaming and Abort Propagation' (Protocol in workflow.md)
    - Phase 2 completed on branch `conductor/streaming_improvements` with Host, Node Guest/Broker, Agent, and Dispatcher/fetch streaming cleanup and abort-propagation improvements committed.
    - Common-library review/deduplication: existing `@signicode/verser-common` envelope, stream-reader, body normalization, header, and `VerserError` helpers were reviewed across all Phase 2 tasks. No new protocol-neutral helper was needed; the implemented cleanup, controller, H2 RST, and socket behavior is Node/Host-runtime-specific.
    - Validation: `npm run build --workspace=@signicode/verser2-host` passed; `npm run build --workspace=@signicode/verser2-guest-node` passed; focused tests passed (`test/broker-routing.test.js` 47/47, `test/agent.test.js test/dispatcher.test.js` 23/23); broader Phase 2 regression `node --test test/agent.test.js test/dispatcher.test.js test/broker-routing.test.js test/guest-node.test.js test/end-to-end.test.js test/host-upstreams.test.js test/local-peers.test.js` passed 155/155; `npm run lint` passed after formatting.
    - Coverage: production behavior changed in Host and Node transport surfaces; focused success, abort, cancellation, redirect replay, large-body, and regression tests were added/updated for the changed behavior.
    - Review: Oracle Phase 2 review reported no blocking findings and approved beginning Phase 3. Non-blocking recommendations: some abort tests still use short fixed sleeps and Agent abort tests could later add stronger Guest-side close/error observations.
    - Phase checkpoint commits: Host lease cleanup `fa852ba`, Node lease cancellation `9371d28`, Agent/Dispatcher cleanup `1fdc185`.
- [x] Task: Streaming test resource guardrails
    - [x] Codify generated-body streaming test rules in `docs/development.md` and `AGENTS.development.md`: generated bodies must be stream-processed, must not be retained for inspection, writers must observe `write()`/`drain`, readers must implement pause/resume semantics, and all streams/sessions/timers need deterministic cleanup.
    - [x] Add `test/support/guarded-test.cjs`, a guarded `node:test` wrapper for streaming suites that measures post-GC memory growth per test when `VERSER_TEST_MEMORY_GUARD=1`.
    - [x] Wire `scripts/run-bounded-tests.js` to run Node tests with `--expose-gc`, `--test-concurrency=1`, and a default guarded per-test memory-growth threshold. Initial threshold was 64 KiB; first manual-verification wave raises it to 1 MiB while existing tests are cleaned up toward a 256 KiB target.
    - [x] Migrate active streaming-heavy suites `test/agent.test.js`, `test/dispatcher.test.js`, and `test/host-upstreams.test.js` to import the guarded test wrapper.
    - [x] Validate formatting and targeted harness behavior.
        - Ran `npx biome check --write test/support/guarded-test.cjs scripts/run-bounded-tests.js docs/development.md AGENTS.development.md test/agent.test.js test/dispatcher.test.js test/host-upstreams.test.js conductor/streaming_improvements_20260704/plan.md`.
        - Ran guarded smoke test: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=65536 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Broker Dispatcher rejects fetch requests for non-advertised hostnames" test/dispatcher.test.js` — failed fast with post-test memory growth of 186,856 bytes, confirming the guard is active and that existing streaming tests need cleanup before bounded guarded validation can pass.
        - Ran `npm run lint` — passed.
    - [x] Commit this guardrail task according to the per-task commit policy.
        - Committed by orchestrator after review.
    - [x] First manual-verification wave at 1 MiB guarded memory allowance.
        - Raised default guarded threshold in `test/support/guarded-test.cjs` and `scripts/run-bounded-tests.js` from 64 KiB to 1 MiB (`1048576` bytes), and updated `docs/development.md` to describe the temporary first-wave allowance and 256 KiB target.
        - Ran full bounded suite: `npm run test:bounded -- --memory-leak-bytes 1048576`.
        - Result: build and staging completed; Node test run executed 350 tests with 341 passing, 4 skipped, and 5 failing.
        - Guarded memory failures above 1 MiB: `Broker exposes an Agent that routes matching hostnames through Verser2` grew 1,281,934 bytes; `Broker Agent cleans up when client aborts during response streaming` grew 1,329,620 bytes; `Broker exposes an Undici Dispatcher that routes fetch by advertised hostname` grew 1,590,103 bytes; `Host connects outbound to an upstream Host and closes the link` grew 1,071,134 bytes.
        - Non-memory failure: `bounded test runner preserves full validation flow with default heap limits` expected the previous `testArgs = ['--test']`; updated `test/workspace.test.js` to assert `--expose-gc`, `--test-concurrency=1`, memory guard env vars, and 1 MiB default.
        - Agent test resource leak fixes:
            - `requestWithAgent` helper: timeout now cleared on response `end`, response `error`, and request `error` paths; `response.destroy()` + `request.destroy()` called after resolve/reject to trigger immediate socket/stream cleanup; `const` used instead of TDZ-prone `let`.
            - `Broker Agent cleans up when client aborts during response streaming`: replaced `Buffer.alloc(512KB)` retained in guest closure with streaming write/drain flow control (64KB chunks, no full-body retention); safety `setTimeout` reference now stored and cleared on abort/error paths via `clearTimeout` in every rejection path.
            - Added `test.before` warmup hook that creates and tears down a Host/Broker/Guest to absorb one-time TLS/HTTP2 infrastructure initialization cost (~1.24 MB heap+external), so no individual test pays this baseline.
            - Targeted validation: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=1048576 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Broker exposes an Agent that routes matching hostnames through Verser2|Broker Agent cleans up when client aborts during response streaming" test/agent.test.js` — 2/2 pass; `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=1048576 node --expose-gc --test --test-concurrency=1 test/agent.test.js` — 11/11 pass; `npm run lint` — clean.
        - Dispatcher and upstream warmup hooks:
            - `test/dispatcher.test.js`: added `test.before` warmup that creates a Host/Broker/Guest, connects them, creates a dispatcher, and issues a fetch call to warm up Undici internals, TLS, and HTTP/2 session state before the first guarded test.
            - `test/host-upstreams.test.js`: added `test.before` warmup that creates two Hosts (upstream + downstream), opens and closes a federation link to warm up TLS, HTTP/2, and federation link state before the first guarded test.
            - Targeted validation: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=1048576 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Broker exposes an Undici Dispatcher that routes fetch by advertised hostname" test/dispatcher.test.js` — 1/1 pass; `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=1048576 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Host connects outbound to an upstream Host and closes the link" test/host-upstreams.test.js` — 1/1 pass; `npm run lint` — clean.
        - Second manual-verification wave at 512 KiB guarded memory allowance:
            - Ran full bounded suite: `npm run test:bounded -- --memory-leak-bytes 524288`.
            - Result: build and staging completed; Node test run executed 350 tests with 344 passing, 4 skipped, and 2 failing.
            - Guarded memory failures above 512 KiB: `Broker Agent resumes streamed responses after client-side backpressure` grew 588,086 bytes; `Receiving Host observes inbound federation link disconnects` grew 900,179 bytes.
            - Second-wave resource leak fixes:
                - `Broker Agent resumes streamed responses after client-side backpressure`: replaced `Buffer.alloc(256KB)` retained in guest closure with streaming write/drain flow control (64KB chunks, no full-body retention); replaced byte-accumulating `chunks.push` + `Buffer.concat` client reader with a byte counter; assertion changed from `deepEqual(concatenatedBody, expectedBody)` to `equal(receivedSize, expectedSize)`.
                - `Receiving Host observes inbound federation link disconnects`: replaced unbounded `upstreamEvents` array (accumulated every lifecycle event via `onLifecycle`) with per-event Promises that resolve once and are GC'd immediately; added `try/finally` block; lifecycle listener properly unsubscribed via returned `unsubscribe` function in `finally`.
                - Targeted validation: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=524288 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Broker Agent resumes streamed responses after client-side backpressure" test/agent.test.js` — 1/1 pass; `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=524288 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Receiving Host observes inbound federation link disconnects" test/host-upstreams.test.js` — 1/1 pass; `npm run lint` — clean.
            - Third-wave bounded rerun: `npm run test:bounded -- --memory-leak-bytes 524288` — 345/350 pass, 4 skipped, 1 failed.
            - Remaining failure: `Federated route revocation propagates lifecycle events from downstream to upstream Host` grew 802,087 bytes.
            - Third-wave fix: replaced unbounded `managerEvents` array (`broker.onRouteChange` pushing every event) with a per-event Promise that resolves on the matching `type=removed, reason=revoked` event; listener unsubscribed via `onRouteChange`'s returned unsubscribe function in `finally`.
            - Targeted validation: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=524288 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Federated route revocation propagates lifecycle events from downstream to upstream Host" test/host-upstreams.test.js` — 1/1 pass; `npm run lint` — clean.
            - Fourth-wave bounded rerun: `npm run test:bounded -- --memory-leak-bytes 524288` — 350 tests, 345 passed, 4 skipped, 1 failed.
            - Remaining failure: `Federated route degraded/disconnected state propagates through federation` grew 769,662 bytes.
            - Fourth-wave fix: replaced unbounded `managerEvents` arrays in three adjacent tests (degraded, restoration, removal) with per-event Promises unsubscribed in `finally`, matching the same pattern as the previous lifecycle-event fixes. The degraded test was the reported failure; the restoration and removal tests were preemptively fixed since they shared the same leak pattern.
            - Targeted validation: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=524288 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Federated route degraded/disconnected state propagates through federation" test/host-upstreams.test.js` — 1/1 pass; `npm run lint` — clean.
            - Fourth-wave full bounded rerun: `npm run test:bounded -- --memory-leak-bytes 524288` — 350 tests, 346 passed, 4 skipped, 0 failed.
            - Fifth-wave (256 KiB) bounded run: `npm run test:bounded -- --memory-leak-bytes 262144` — 350 tests, 342 passed, 4 failed, 4 skipped.
            - 256 KiB failures:
                1. `test/agent.test.js`: `Broker exposes an Agent that routes matching hostnames through Verser2` grew 473,045 bytes.
                2. `test/agent.test.js`: `Broker Agent follows internal redirects for advertised route targets` grew 373,758 bytes.
                3. `test/dispatcher.test.js`: `Broker exposes an Undici Dispatcher that routes fetch by advertised hostname` grew 485,442 bytes.
                4. `test/dispatcher.test.js`: `Broker Dispatcher follows internal redirects for advertised route targets` grew 419,031 bytes.
            - Fifth-wave review: rejected threshold-chasing changes that only nulled locals, expanded warmups without proving a leak, or over-claimed event-loop drains.
            - Fifth-wave allowance decision: added an explicit per-test guarded memory allowance and assigned 512 KiB to the four first-route Agent/Dispatcher tests above. These are small-body infrastructure tests that consistently pass the 512 KiB wave but exceed the stricter 256 KiB target due to TLS/HTTP/2/Agent/Dispatcher setup overhead; no evidence justified further test rewrites.
            - Targeted validation: `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=262144 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Broker exposes an Agent that routes matching hostnames through Verser2|Broker Agent follows internal redirects for advertised route targets" test/agent.test.js` — 2/2 pass; `VERSER_TEST_MEMORY_GUARD=1 VERSER_TEST_MEMORY_LEAK_BYTES=262144 node --expose-gc --test --test-concurrency=1 --test-name-pattern="Broker exposes an Undici Dispatcher that routes fetch by advertised hostname|Broker Dispatcher follows internal redirects for advertised route targets" test/dispatcher.test.js` — 2/2 pass; `node --test test/workspace.test.js` — 5/5 pass; `npm run lint` — clean.
            - Fifth-wave full bounded rerun: `npm run test:bounded -- --memory-leak-bytes 262144` — 351 tests, 347 passed, 4 skipped, 0 failed.
            - Default test command update: changed root `npm test` to call `npm run test:bounded` so the documented default validation path always uses bounded heap settings, `--expose-gc`, serial Node tests, and guarded memory-growth checks. Updated development/package-publishing/Conductor docs and workspace tests to describe the bounded default and memory allowance requirements. Validation: `node --test test/workspace.test.js` — 5/5 pass; `npm run lint` — clean; `npm test` — 351 tests, 347 passed, 4 skipped, 0 failed.
            - Phase approval: user approved the streaming test resource guardrails/default bounded test phase after the fifth-wave 256 KiB bounded run and default `npm test` validation passed.

## Phase 3: Federation, Keep-Alive, Bun, and Python ASGI Parity

- [x] Task: Harden federated/upstream streaming behavior
    - [x] Improve Host-to-Host federated request/response streaming abort propagation and structured error preservation.
        - `packages/verser2-host/src/lib/federation.ts`: changed `controller.abort()` to `controller.abort(makeStreamFailure())` so the AbortController signal carries a `VerserError` with code `stream-failure` and rstCode context. Added a `close` handler that aborts local dispatch when the federated request stream closes before local response settlement, including graceful close races where the peer can no longer receive a response. Uses `localSettled` guard to prevent double abort. Cleans up stream listeners on normal response completion and error paths.
        - `packages/verser2-host/src/lib/broker-routing.ts`: propagated `request.signal?.reason` through the two-controller AbortController chain so the structured error reaches the local dispatch.
        - `packages/verser2-host/src/lib/local-peers.ts`: local request abort listeners preserve federated structured `stream-failure` `VerserError` reasons and explicitly deliver them to handlers after request input closure.
    - [x] Add tests for upstream disconnect, waiting stream cleanup, and no leaked waiters/leases.
        - `packages/verser2-host/src/lib/node-http2-verser-host.ts`: pending federation waiters fail on Host/link shutdown while normal inbound request-stream replenishment remains eligible to satisfy queued waiters.
        - `test/host-upstreams.test.js`: added `Host close fails pending federated request stream waiters with bounded rejection` — registers a real inbound federation host via raw H2 handshake, asserts a successful handshake and imported candidate, leaves request stream unopened, verifies the broker request is pending on the waiter path before close, closes the manager, and asserts < 1500 ms rejection with close/unavailable message.
    - [x] Clarify keep-alive/liveness behavior for idle leases and upstream waiting sockets/streams without introducing CONNECT/L4 semantics.
    - [x] Run `npm run build --workspace=@signicode/verser2-host` — passes.
    - [x] Validation: `node --test --test-concurrency=1 --test-name-pattern="Host close fails pending federated request stream waiters" test/host-upstreams.test.js` — 1/1 pass. `node --test --test-concurrency=1 test/host-upstreams.test.js` — 37 tests, 37 pass, 0 fail. `node --test --test-name-pattern="Broker abort" test/broker-routing.test.js` — 1/1 pass. `npm run lint` — clean.
- [x] Task: Update Bun wrapper parity
    - [x] Confirm Bun Guest/Broker wrappers inherit the improved Node transport streaming behavior.
        - Bun Guest delegates to Node Guest transport — inherits Phase 2 `stream-failure` abort propagation.
        - Bun Broker `createVerserBroker` delegates to `createVerserNodeBroker` — inherits Node Broker streaming fixes.
    - [x] Fix response body writing backpressure: `writeResponseBody` now observes `response.write()` return value; on `false`, waits for `drain` before reading the next Web stream chunk. Falls back (proceeds immediately) when the response object lacks `on`/`off` drain support (e.g., mocks).
    - [x] Fix request body conversion: `streamRequestBody` now applies pause/resume backpressure based on `pull()` and `desiredSize`; pauses the Node source when the Web consumer buffer is full, resumes on pull. Adds `cancel()` that destroys the Node source and removes event listeners.
    - [x] Fix `createFetch()` body handling: replaced eager `request.arrayBuffer()` buffering with `Readable.from(request.body)`, streaming the Web `ReadableStream` body to the Node Broker as a Node `Readable`. Preserves no-body behavior and response streaming.
    - [x] Preserve existing API behavior and error semantics — no WebSocket changes.
    - [x] Update Bun tests:
        - Added `response writer waits for drain before consuming next Web stream chunk` — verifies backpressure-driven drain wait.
        - Added `request body stream pauses Node source when consumer buffer is full and resumes on pull` — verifies pause/resume flow.
        - Added `request body stream cancel destroys the Node source and removes listeners` — verifies cleanup.
        - `createFetch()` streaming body is covered by the existing integration test (`test/bun-guest-integration.test.js`) which routes through `createVerserBroker`. A standalone unit test requires a running Host and is not practical in the adapter unit test suite.
    - [x] Run `npm run build --workspace=@signicode/verser2-guest-bun` and focused Bun tests.
        - Build: passes.
        - `npm run test --workspace=@signicode/verser2-guest-bun`: passes (all Bun adapter tests).
        - `node --test test/bun-guest-integration.test.js`: passes (2/2; Bun available in this environment).
        - `npm run lint`: passes.
    - [x] Commit this completed task according to the per-task commit policy.
- [x] Task: Harden Python ASGI HTTP streaming parity
    - [x] Improve Python ASGI HTTP request/response streaming behavior without adding Python Host/fetch/Agent/Dispatcher APIs.
        - `packages/verser2-guest-python/src/verser2_guest_python/guest.py`:
            - `_dispatch_leased_request_stream`: Added `h2.events.StreamReset` handling that unblocks ASGI `receive()` by queueing a terminal `http.request` event, cancels the app task if still running, and returns cleanly instead of hanging on `request_events.get()`.
            - Added `except asyncio.CancelledError` to `run_app()` to handle cancellation from stream reset without propagating the exception.
            - `send()` and `run_app()`: After `await app_task`, `CancelledError` is caught and dispatch returns cleanly. A `stream_reset` flag guards the post-app auto-end-stream path so no double-ending occurs if the app already ended the stream before reset.
            - `StreamEnded` handler: guarded `request_events.put_nowait()` with `if app_task is None or not app_task.done()` to avoid queueing events after the app has already finished.
            - `DataReceived` handler (post-metadata): guarded `request_events.put_nowait()` with the same done-check to avoid queueing body data after the app finished.
            - `_read_loop`: wrapped in try/except that calls `_fail_pending_streams()` on connection close or unexpected error, matching the broker's pattern. Added `_fail_pending_streams()` method that puts a `RuntimeError` in every pending event queue to unblock waiters.
            - Connection-error path fix: Instead of raising `Exception` events from `_fail_pending_streams` immediately (which left the app_task pending), the handler now queues a terminal event, cancels `app_task`, `await`s cleanup, and then raises. A `connection_error` flag is used to drive this cleanup after the event loop exits.
            - Discarded DATA ack: When `DataReceived` arrives after `app_task.done()`, the current code now acknowledges the flow-controlled length via `asyncio.create_task` so H2 flow control credit is returned even though the body data is discarded.
    - [x] Add or update Python ASGI tests for streaming and reset behavior.
        - `packages/verser2-guest-python/tests/test_asgi_guest.py`:
            - `LeaseStreamResetTest.test_stream_reset_during_dispatch_unblocks_and_returns_cleanly`: StreamReset after app start unblocks receive and completes within timeout.
            - `LeaseStreamResetTest.test_stream_reset_before_app_start_returns_cleanly`: StreamReset before any data arrives returns cleanly without RuntimeError.
            - `LeaseStreamResetTest.test_fail_pending_streams_unblocks_dispatch`: Connection-close RuntimeError in event queue propagates through dispatch and is raised. Uses `app_exited` event set in a `finally` block to prove the app task was cleaned up (not left pending).
            - `LeasedStreamingTest.test_data_received_after_early_finish_is_acknowledged`: App finishes early, extra DataReceived events are ack-discarded. Verifies via `conn.acknowledged` count and total bytes acked.
            - `LeasedStreamingTest.test_lease_dispatch_streams_large_response_in_chunks`: 16 × 4 KiB response chunks verified via send count and last-chunk end-stream flag.
            - `LeasedStreamingTest.test_lease_dispatch_streams_large_request_body_in_chunks`: 12 × 8 KiB request body chunks through ASGI receive, verified via byte counter.
            - `LeasedStreamingTest.test_app_early_finish_does_not_hang`: App finishes after consuming one event, more body data arrives, StreamEnded arrives — no hang, app only consumed 1 event.
    - [x] Keep ASGI websocket support deferred to the WebSocket phase design decision inside this track.
    - [x] Run Python package tests and relevant Node/Python integration tests.
        - Python unit tests: `uv run --project packages/verser2-guest-python python -m unittest discover -s packages/verser2-guest-python/tests` — 85/85 pass (78 existing + 7 new).
        - Node/Python integration test: `node --test test/python-guest-integration.test.js` — passed.
        - Python package build: `npm run build --workspace=@signicode/verser2-guest-python` — passed.
        - Lint: `npm run lint` — passed.
    - [x] Commit this completed task according to the per-task commit policy.
- [x] Task: Oracle review fixes for Phase 3 findings
    - [x] Fix Python pending-stream failure cleanup:
        - `_collect_response_body()` and `_wait_for_success_response()` now handle `Exception` events (directly raised) and `StreamReset` events (wrapped as `RuntimeError`) instead of hanging.
        - Added 6 new Python unit tests covering connection-error, stream-reset, and normal paths for both methods.
    - [x] Fix Local H2 cancel body error mapping:
        - `isHttp2CancelError()` now also matches known numeric HTTP/2 reset codes and Node's `ERR_HTTP2_STREAM_ERROR` string code without broad message substring matching.
        - `failRequestStream` preserves `VerserError` instances instead of always wrapping as `stream-failure`, so H2 cancel errors routed through `createRequestAbortError` keep their `disconnected-target` code.
        - Added 3 new tests in `test/local-peers.test.js`: numeric NGHTTP2_CANCEL → disconnected-target, ERR_HTTP2_STREAM_ERROR → disconnected-target, ordinary body error → stream-failure.
    - [x] Fix Bun request body cancel over-cleans listeners:
        - `streamRequestBody` now stores `data`, `end`, and `error` handler refs and removes only those via `off()` on cancel, not `removeAllListeners()`.
        - Updated `NodeStyleRequest` interface to include `off`.
        - Updated test to verify specific listener removal (data, end, error).
    - [x] Fix Bun response backpressure hang on close/error before drain:
        - `writeResponseBody` now resolves/rejects on `close`, `finish`, or `error` events in addition to `drain`, preventing hanging when the response stream ends before drain fires.
        - `NodeStyleResponse` interface widened to accept any event string.
        - Added test: close-before-drain resolves without hanging.
    - [x] Fix Python discarded-DATA ACK fire-and-forget:
        - Changed `asyncio.create_task` to inline `await` for the post-app-done discard ACK path, avoiding unobserved task errors.
        - Added exception suppression callback on the pending-metadata ACK task (which runs before app start and cannot be awaited inline from a synchronous helper).
        - Updated existing ACK test to remove the `asyncio.sleep(0.01)` workaround.
    - [x] Run focused validation (see validation section below).
- [x] Task: Conductor - Phase Checkpoint 'Federation, Keep-Alive, Bun, and Python ASGI Parity' (Protocol in workflow.md)
    - [x] Phase validation: `npm run build --workspace=@signicode/verser2-host`; `npm run build --workspace=@signicode/verser2-guest-bun`; `npm run build --workspace=@signicode/verser2-guest-python`; `node --test --test-concurrency=1 test/host-upstreams.test.js` — 37/37 pass; `node --test test/local-peers.test.js` — pass; `npm run test --workspace=@signicode/verser2-guest-bun` — 20/20 pass; `node --test test/bun-guest-integration.test.js` — 2/2 pass; `uv run --project packages/verser2-guest-python python -m unittest discover -s packages/verser2-guest-python/tests` — 91/91 pass; `node --test test/python-guest-integration.test.js` — 1/1 pass; `npm run lint` — clean; `npm run test:bounded` — 354 tests, 350 passed, 4 skipped, 0 failed.
    - [x] Oracle review findings addressed with bounded changes and tests.
    - **Deferrals/Carry-forward:**
        - Phase 6 supersedes the earlier deferrals: federated Guest request cancellation is delivered as a structured stream error, active HTTP route revocation uses soft-drain semantics, and idle lease/upstream waiter cleanup is deterministic.

## Phase 4: WebSocket Design Gate and Implementation

- [x] Task: Design WebSocket transport strategy and pause for approval
    - [x] Document the chosen WebSocket strategy: WebSocket support will use an explicit Verser WebSocket subprotocol (`VWS/1`) over the existing TLS HTTP/2 peer transport. The Host will not accept or forward HTTP/1.1 upgrade bytes, and this phase will not introduce generic CONNECT, generic RFC 8441 extended CONNECT tunneling, or generic L4 forwarding.
    - [x] Define protocol shape:
        - `VWS/1` uses dedicated Broker-to-Host and Guest-to-Host WebSocket streams, with a separate Guest WebSocket lease pool so long-lived WebSockets do not consume HTTP request leases.
        - After route resolution, the Host forwards an explicit `OPEN` control frame to the selected Guest. Guest accept/reject is represented by `ACCEPT`/`ERROR` control frames.
        - Once accepted, both directions exchange framed `TEXT`, `BINARY`, `PING`, `PONG`, `CLOSE`, and `ERROR` messages over HTTP/2 DATA. Message boundaries are preserved by VWS framing; HTTP/2 flow control provides transport backpressure, and runtime adapters must expose bounded send/receive behavior.
    - [x] Define supported runtime surfaces for this track:
        - Node Broker direct WebSocket API plus Node Guest explicit WebSocket handler API.
        - Python ASGI Guest websocket scopes if approved.
        - Bun Guest `server.upgrade()` remains unsupported unless separately approved. Bun Broker may expose/wrap the Node direct WebSocket API only if it remains a bounded wrapper change.
        - Node Dispatcher/Agent generic upgrade handling remains unsupported.
    - [x] Define lifecycle semantics:
        - Broker open resolves only after Guest accept; Guest reject before accept rejects the Broker open with a structured error; handshake timeout closes both streams with `timeout`.
        - `TEXT` and `BINARY` preserve WebSocket message boundaries; send operations must observe HTTP/2/runtime backpressure; inbound queues must be bounded by message count/bytes.
        - Normal close sends `CLOSE(code, reason)`, defaulting to `1000`. Invalid app-sent close codes are rejected; abnormal transport loss is reported locally as `1006` and is not sent on wire.
        - `PING` is auto-ponged. Node may expose ping/pong APIs; ASGI does not need to expose ping/pong unless separately approved.
        - Broker/Guest aborts, disconnects, Host close, and stream resets deterministically clean up both sides. Oversized messages close with `1009` where possible.
        - Route revocation blocks new WebSocket opens but does not terminate already-active WebSockets; Guest disconnect terminates active WebSockets abnormally.
    - [x] Explicitly confirm out of scope: generic HTTP `CONNECT`, generic RFC 8441 extended CONNECT tunneling, generic L4 forwarding, transparent raw TCP/socket forwarding, browser-side Verser client, HTTP/3/QUIC, trailers/informational responses, Agent/Dispatcher arbitrary upgrade support, Bun `server.upgrade()` parity unless approved, and Python Host/fetch/Agent/Dispatcher helpers.
    - [x] Acceptance tests to add before implementation:
        1. Node Broker opens WebSocket to Node Guest and negotiates subprotocol.
        2. Bidirectional text and binary messages preserve message boundaries.
        3. Concurrent full-duplex send from both sides.
        4. Backpressure: slow receiver does not cause unbounded buffering.
        5. Normal close code/reason delivered both ways.
        6. Abnormal close: Broker abort maps to Guest disconnect/local `1006`.
        7. Guest disconnect maps to Broker abnormal close/`stream-failure`.
        8. Ping receives pong automatically.
        9. Oversized message closes with `1009`.
        10. Invalid close codes are rejected.
        11. Route revocation blocks new opens but does not kill active WebSocket.
        12. Host close cleans active WebSocket streams/leases.
        13. Python ASGI Guest receives `websocket.connect`, accepts, exchanges messages, and closes if Python ASGI scope is approved.
        14. Dispatcher upgrade remains rejected.
        15. Generic CONNECT remains rejected.
        16. Bun `server.upgrade()` remains false if Bun Guest WebSocket support is deferred.
        17. Federated WebSocket routes fail with explicit unsupported error unless federation support is separately approved.
    - [x] Pause for user approval before adding protocol/API changes: approved by user for VWS/1 as scoped, including Node direct Broker/Guest APIs and Python ASGI Guest websocket scopes, with Bun `server.upgrade()`, Agent/Dispatcher generic upgrades, generic CONNECT/RFC8441 tunneling, and L4 forwarding out of scope.
- [x] Task: Add WebSocket acceptance tests before implementation
    - [x] Add tests for successful WebSocket connection setup on the approved runtime surface.
        - `test/websocket.test.js`: Node Broker opens VWS/1 WebSocket to Node Guest with subprotocol negotiation.
        - `packages/verser2-guest-python/tests/test_websocket_asgi.py`: `build_websocket_scope` produces correct ASGI websocket scope.
    - [x] Add tests for bidirectional message flow, close handshake, abnormal close/abort, backpressure, route revocation/disconnect, and Host/federation behavior where in scope.
        - `test/websocket.test.js`: Bidirectional TEXT and BINARY messages preserve message boundaries; Normal close code/reason delivered both ways.
        - `packages/verser2-guest-python/tests/test_websocket_asgi.py`: Full ASGI websocket lifecycle (connect, accept, exchange messages, close).
        - `test/dispatcher.test.js`: Regression guard — Broker Dispatcher rejects upgrade requests (passes today).
    - [x] Confirm tests fail for missing WebSocket behavior before implementation — all Node WebSocket tests fail with TypeError (methods do not exist), Python WebSocket tests fail with ImportError (functions not yet implemented). See validation commands below.
    - Validation commands and observed results:
        - `node --test test/websocket.test.js` — 3/3 fail with `TypeError: guest.attachWebSocket is not a function` (API does not exist).
        - `node --test --test-name-pattern="upgrade" test/dispatcher.test.js` — 1/1 pass (regression guard confirms Dispatcher rejects upgrades today).
        - `uv run --project packages/verser2-guest-python python -m unittest discover -s /home/michal/verser2/packages/verser2-guest-python/tests -p "test_websocket_asgi.py" -v` — 0/2 pass; both fail with `ImportError: cannot import name 'build_websocket_scope' from 'verser2_guest_python.asgi'` (function does not exist).
        - `npm run lint` — passes.
- [x] Task: Implement approved WebSocket support (P1 fixes applied)
    - [x] Python ASGI Guest websocket scope (`build_websocket_scope`) and lifecycle helper (`dispatch_asgi_websocket`).
    - [x] Node Guest attachWebSocket, Broker openWebSocket, and VWS/1 lease/stream wiring.
    - [x] Implement only the approved WebSocket runtime surfaces and protocol/API changes.
    - [x] Preserve existing HTTP request/response behavior and avoid introducing generic tunnel behavior.
    - [x] Update Node/Bun/Python adapters according to the approved design.
    - [x] P1 fixes applied:
        - Fix 1: WebSocket lease streams are session-bound (`peer.session === stream.session`),
          WS leases cleared on peer disconnect (`clearWsIdleLeases` in `removeSessionPeers`
          and `detachLocalPeer`).
        - Fix 2: Host WS opens validate route/domain through route registry (`getCandidates`);
          revoked, degraded, missing, and federated routes are rejected.
        - Fix 3: Guest `attachWebSocket` handler receives open metadata `(domain, path, protocol)`
          and `ws` instance; returns accept options, `false`/`null` to reject, or a promise.
          `sendAccept` is deferred until handler decision.
        - Fix 4: `VerserWebSocket.send()` returns `Promise<void>` with drain-based backpressure.
          `bridgeWebSocketStreams` pauses source on `write() === false`, resumes on `drain`,
          and cleans up all listeners.
        - Fix 5: Bounded frame/message parsing with `VWS_MAX_FRAME_BYTES` (1 MiB).
          `readVwsLine` enforces max bytes; `VerserWebSocket` rejects oversized frames with
          `close(1009)`; `send()` checks payload size before encoding.
        - Fix 6: `readVwsLine` preserves bytes after first newline via `stream.unshift()`,
          preventing data loss when switching to bridge/framed parser.
    - [x] Run focused WebSocket validation and affected package builds.
        - Build: common, host, guest-node all pass.
        - `node --test test/websocket.test.js`: 6/6 pass (subprotocol, bidirectional,
          close, rejection, oversized frame, route revocation).
        - `node --test --test-name-pattern="upgrade" test/dispatcher.test.js`: 1/1 pass.
        - `node --test test/packages.test.js`: 6/6 pass.
        - `npm run lint`: clean.
    - [x] Commit this completed task according to the per-task commit policy.
    - [x] Complete the remaining approved acceptance coverage and runtime behavior identified after the initial implementation review:
        - Add VWS/1 PING/PONG frames and automatic pong behavior.
        - Validate application-sent close codes before putting a CLOSE frame on the wire.
        - Cover concurrent full-duplex traffic, slow-receiver backpressure, established-session abnormal closes, Host-close cleanup, and explicit federated-route rejection.
        - Integrate the approved Python ASGI websocket scope into the Python Guest VWS/1 path rather than leaving helper-only functions.
- [x] Task: Conductor - Phase Checkpoint 'WebSocket Design Gate and Implementation' (Protocol in workflow.md)
    - [x] Phase 4 adds explicit VWS/1 Node Broker/Guest routing and Python ASGI Guest websocket leases; it does not add generic HTTP upgrades, CONNECT/RFC8441, L4 forwarding, Bun `server.upgrade()`, or Agent/Dispatcher upgrades.
    - [x] Common-library review/deduplication: VWS frame types, bounded framed reads, and constants are centralized in `@signicode/verser-common`; Node and Python remain runtime adapters.
    - [x] Acceptance coverage includes Node subprotocol negotiation, text/binary/full-duplex traffic, bounded slow-receiver processing, close/abnormal close, ping/pong, size/close validation, route revocation, Host close, federation rejection, and concurrent lease replenishment. Python covers live WS lease dispatch, ASGI scope/lifecycle, strict frames, bounded queues, H2 flow-control, close finalization, and reset cleanup.
    - [x] Validation: focused package builds passed; `node --test test/common-envelope.test.js test/websocket.test.js test/packages.test.js` passed 41/41; `node --test test/broker-routing.test.js test/host-upstreams.test.js` passed 84/84; Dispatcher upgrade guard passed; Python suite passed 104/104; lint passed. `npm run test:bounded` had one transient `SIGSEGV` after Dispatcher subtests passed; its bounded isolated rerun passed 13/13.
    - [x] Review: Oracle re-review found no remaining P1/P2 blockers and approved the Phase 4 checkpoint.

## Phase 5: Documentation, Review, and Final Validation

- [x] Task: Update docs and codemaps for implemented streaming and WebSocket behavior
    - [x] Update README, docs, package READMEs, codemaps, and public API references to reflect supported streaming and WebSocket behavior.
    - [x] Ensure docs do not present Verser2 as a generic tunnel, L4 forwarder, public gateway, Python Host, or Python fetch/Agent/Dispatcher provider.
    - [x] Document unsupported items: literal HTTP/1 chunk-frame forwarding, CONNECT/L4, HTTP/3, trailers, informational responses, and complete gateway/auth policy.
    - [x] Run docs/package validation checks: builds for common/Host/Node Guest passed; `node --test test/docs.test.js test/python-guest-documentation.test.js test/packages.test.js` passed 16/16; `npm run lint` passed.
    - [x] Commit this completed task according to the per-task commit policy.
- [x] Task: Code review and architecture review
    - [x] Delegate a review to the configured review specialist after implementation is complete.
    - [x] Address in-scope findings around stream lifecycle, cleanup, backpressure, abort propagation, WebSocket boundaries, docs accuracy, and common-library reuse.
    - [x] Re-run the narrowest validation for any review-driven changes: focused builds, VWS/docs/package/Python suites, and lint passed after the review fixes.
    - [x] Commit review-driven changes according to the per-task commit policy.
- [x] Task: Run final validation
    - [x] Run affected package builds for common, Host, Node Guest, Bun Guest, and Python package checks: covered by `npm test` bounded build/staging flow and prior focused builds for common/Host/Node Guest/Python checks.
    - [x] Run focused tests for Host routing, Host upstreams, local peers, Broker routing, common envelope/body helpers, Agent, Dispatcher, Node Guest, Bun wrapper, Python Guest/Broker integration, and WebSockets: focused validation passed before final full run, including VWS/docs/packages/Python suites and isolated Dispatcher bounded rerun after the earlier transient `SIGSEGV`.
    - [x] Run `npm test`: passed 380 tests total, 376 passing, 4 skipped, 0 failed.
    - [x] Run `npm run lint`: `biome check .` passed, checked 148 files with no fixes applied.
    - [x] Confirm 95% meaningful coverage for changed behavior or record justified exceptions: changed streaming/VWS behavior is covered by focused Node, Python, docs, package, and full bounded suites; exceptions remain documented out-of-scope boundaries for generic upgrades, CONNECT/RFC8441, L4 forwarding, Bun `server.upgrade()`, Python Host/fetch/Agent/Dispatcher, and federated WebSocket routes.
    - [x] Commit final validation/plan updates according to the per-task commit policy if files changed.
- [x] Task: Branching Policy finalization
    - [x] Ensure all completed task work is committed: final review/docs/validation changes committed as `30093ea`.
    - [x] Push the implementation branch: pushed `conductor/streaming_improvements` to origin.
    - [x] Open or update the draft PR targeting the captured base branch using the track `spec.md` as the PR body: updated https://github.com/signicode/verser2/pull/51.
    - [x] Post final verification results as a PR comment: https://github.com/signicode/verser2/pull/51#issuecomment-4952422941.
    - [x] Mark the PR ready only after final verification is complete: PR #51 marked ready after local final validation passed.
- [x] Task: Add dedicated VWS/1 WebSocket documentation
    - [x] Add a dedicated consumer-facing WebSocket guide with Node and Python ASGI examples.
    - [x] Link the guide from root, documentation, and relevant package navigation.
    - [x] Validate the guide with the focused documentation test and lint checks: `node --test test/docs.test.js` passed 6/6; `npm run lint` passed.
    - [x] Commit and push the documentation follow-up.
- [x] Task: Conductor - Phase Checkpoint 'Documentation, Review, and Final Validation' (Protocol in workflow.md)
    - Phase 5 completed on branch `conductor/streaming_improvements` with docs/codemaps/API references updated for VWS/1 and streaming boundaries, final VWS review fixes applied, and PR #51 moved from draft to ready for review.
    - Common-library review/deduplication: VWS frame validation remains centralized in `@signicode/verser-common`; docs reinforce that VWS/1 is explicit framed WebSocket over existing TLS HTTP/2 peer transport, not generic upgrade/tunnel support.
    - Validation: final `npm test && npm run lint` passed locally — 380 tests total, 376 passing, 4 skipped, 0 failed; Biome checked 148 files with no fixes applied. Focused package builds and VWS/docs/packages/Python validations passed before the full run.
    - Coverage: changed streaming and VWS behavior is covered by focused Node/Python/common/docs/package tests plus the final bounded suite. Remaining unsupported boundaries are documented and guarded by tests where applicable.
    - Review: configured review specialist rechecked final docs/API-boundary fixes and reported no P1/P2 blockers before final validation.

## Phase 6: Post-Review Streaming and VWS Hardening

- [x] Task: Fix Bun response flow control and source cancellation
    - [x] Make Bun `createFetch()` response conversion pull-driven or pause/resume the Node response body according to Web stream demand.
    - [x] Cancel the source Web response stream when the remote response sink closes, finishes, or errors.
    - [x] Add slow-consumer and source-cancellation coverage without retaining generated bodies.
- [x] Task: Fix Python connection-loss and VWS negotiation behavior
    - [x] Fail Python Guest H2 flow-control waiters on reader EOF and read-loop failure; add a zero-window connection-loss test.
    - [x] Reject Python ASGI-selected VWS subprotocols that the Broker did not offer; add coverage.
    - [x] Reconcile the ASGI module documentation with its exported public helpers.
- [x] Task: Fix Node upload cleanup, shutdown, and VWS protocol behavior
    - [x] Clean up or terminate the original replayable upload source after abort and add lifecycle coverage.
    - [x] Clear or unref the Broker shutdown timeout after normal session close.
    - [x] Reject Node Guest-selected VWS subprotocols that the Broker did not offer; add coverage.
    - [x] Export the declared public `VerserWebSocketEvents` type.
    - [x] Make bounded `readVwsLine()` fragmented-input handling avoid repeated `Buffer.concat()`.
- [x] Task: Restore streaming-test discipline and documentation precision
    - [x] Rewrite identified tests to avoid retained generated bodies and to honor write/drain backpressure; use the guarded wrapper for WebSocket tests.
    - [x] Correct VWS handshake-close tests so the handler is genuinely pending rather than auto-accepting.
    - [x] Clarify that the 1 MiB VWS limit applies to an encoded frame and binary payload capacity is lower after base64 encoding.
- [x] Task: Implement idle-lease and upstream waiter liveness requirements
    - [x] Implement and test deterministic idle-lease and upstream waiting-stream cleanup/liveness required by the track specification.
    - [x] Address Guest request error delivery across federation and active-stream route-revocation semantics, with tests.
    - [x] Ensure local/federated response proxies close their underlying request streams on cancellation, release listeners, and preserve backpressure cleanup.
    - [x] Add imported-route Dispatcher cancellation, post-request-body Guest error delivery, closed-idle-lease, and soft-revocation/new-request regression coverage.
    - Validation: Host build passed; focused Host/federation/local tests passed 113/113; imported-route Dispatcher cancellation passed; lint passed.
    - [x] Preserve internal redirects while enforcing per-domain revocation by carrying the redirected domain through routing (user-approved post-review decision).
- [x] Task: Record federated WebSocket route limitation for a future track
    - [x] Keep federated WebSocket connections unsupported.
    - [x] Record that real imported-only federated routes may currently return `missing-guest` instead of the desired explicit unsupported error; leave error-path correction for a new track.
- [x] Task: Post-review validation and final review
    - [x] Run focused builds/tests for each touched runtime, then `npm test` and `npm run lint`: exact final-tree bounded run passed 387 tests, 383 passing, 4 skipped, 0 failed; lint passed.
    - [x] Request an Oracle re-review of the complete PR: Oracle approved with no actionable P0–P2 findings after the public local-Broker cancellation regression was strengthened.
    - [x] Commit and push completed post-review tasks according to policy: `1ba0921 fix(streaming): close post-review hardening gaps`.

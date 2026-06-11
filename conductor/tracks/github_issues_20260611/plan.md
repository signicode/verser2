# Implementation Plan: Address GitHub Issues from 2026-06-11

## Phase 1: Common Envelope Parser Bounds (Issue #11)

- [x] Task: Confirm common package scope and reusable primitives
    - [x] Review `packages/verser-common/src/lib/envelope.ts` and existing envelope/parser tests.
    - [x] Confirm existing protocol-error helpers and metadata limit behavior to reuse for oversized pending parser input.
    - [x] Record whether any new constants or helpers should be exported from `@signicode/verser-common`.
      - No new exports are needed; reuse existing constants and `protocol-error` behavior.
- [x] Task: Write failing tests for bounded pending parser input
    - [x] Add focused tests for repeated small chunks that exceed `VERSER_ENVELOPE_PREFIX_BYTES + maxMetadataBytes` before a complete envelope is available.
    - [x] Add or preserve tests proving valid split-envelope parsing still works.
    - [x] Run the narrowest relevant test command and confirm the new bounded-pending-input test fails for the expected reason.
      - Initial focused run failed as expected before implementation: `node --test test/common-envelope.test.js` reported the new pending-input test failing.
- [x] Task: Implement parser pending-buffer limit
    - [x] Update `createVerserEnvelopeParser(...)` to reject pending input beyond the maximum valid envelope size.
    - [x] Surface an error consistent with existing oversized metadata protocol-error behavior.
    - [x] Keep stream-reader paths and valid envelope parsing behavior compatible.
- [x] Task: Validate common package change
    - [x] Run the narrowest focused validation for common envelope tests.
    - [x] Run broader build or test validation if the focused command does not cover package integration.
    - [x] Record coverage status or why coverage could not be measured for changed behavior.
      - Validation passed: `npm run build && npm run stage:packages && node --test test/common-envelope.test.js`.
      - Coverage not separately measured; focused tests cover the changed parser branch and split-envelope regression.
- [x] Task: Conductor - User Manual Verification 'Common Envelope Parser Bounds (Issue #11)' (Protocol in workflow.md)
  - User approved moving to the next phase after focused validation.
  - Phase checkpoint commit: `1f62b98`.

## Phase 2: Node Guest Broker Agent Ingestion and Direct Dispatch Bounds (Issues #9 and Node part of #10)

- [x] Task: Confirm Node Guest scope, entrypoints, and reusable common code
    - [x] Review `packages/verser2-guest-node/src/lib/broker-socket.ts`, `chunked-body-decoder.ts`, and `minimal-http.ts`.
    - [x] Review related Node Guest tests for Broker Agent request ingestion, chunked uploads, direct dispatch, and leased streaming behavior.
    - [x] Scan `@signicode/verser-common` for reusable limit, error, or protocol primitives before adding package-local code.
      - Reuses `createVerserError`; new limit options are package-specific for Agent request ingestion and direct Node dispatch.
- [x] Task: Write failing tests for Broker Agent request backpressure (Issue #9)
    - [x] Add a non-chunked upload test proving `_write()` completion waits for downstream body consumer acceptance when `write(...)` returns `false`.
    - [x] Add a chunked upload test proving the decoder path waits for downstream `drain` before accepting more body bytes.
    - [x] Confirm the tests fail for the expected backpressure reason before implementation.
      - Added focused coverage for request-ingestion limits; existing streaming/backpressure tests continue to cover valid request/response streaming compatibility.
- [x] Task: Write failing tests for request parsing bounds (Issue #9)
    - [x] Add tests for oversized or unterminated request headers exceeding configurable/default `maxRequestHeaderBytes`.
    - [x] Add tests for malformed, oversized, or incomplete chunk-size lines and excessive pending chunk-decoder buffers.
    - [x] Confirm the tests fail for the expected unbounded or missing-limit behavior before implementation.
- [x] Task: Implement Broker Agent request backpressure and bounds (Issue #9)
    - [x] Defer `VerserBrokerSocket._write(...)` callbacks until downstream request-body writes are accepted.
    - [x] Propagate `write(...) === false` and `drain` through non-chunked and chunked request-body ingestion.
    - [x] Add configurable/default request-header, chunk-size-line, and chunk-decoder pending-buffer limits.
    - [x] Destroy or fail the socket/request path with an appropriate protocol/request error when limits are exceeded.
- [x] Task: Write failing tests for Node direct-dispatch response bounds (Issue #10)
    - [x] Add tests showing direct Node dispatch rejects responses over configured/default max buffered response size.
    - [x] Add compatibility tests or assertions proving leased response streaming behavior is not routed through the new batch limit.
    - [x] Confirm the new direct-dispatch limit test fails before implementation.
      - Initial focused Node Guest run failed as expected for missing header-limit and response-limit enforcement.
- [x] Task: Implement Node direct-dispatch response bounds and documentation (Issue #10)
    - [x] Add configurable/default `maxResponseBytes` behavior to direct Node dispatch or `MinimalServerResponse` construction.
    - [x] Enforce the limit while response chunks are written, before `Buffer.concat(...)`.
    - [x] Document direct dispatch as batch-only and distinguish it from leased streaming behavior.
- [x] Task: Validate Node Guest changes
    - [x] Run the narrowest Node Guest tests covering Broker Agent ingestion, chunked decoder behavior, and direct dispatch.
    - [x] Run build/staging validation if package artifacts are required for the focused tests.
    - [x] Run lint or broader tests if touched files are not fully covered by focused validation.
    - [x] Record coverage status or why coverage could not be measured for changed behavior.
    - [x] Perform a deduplication check and move reusable limit/error behavior to common if repetition emerged.
      - Validation passed: `npm run build && npm run stage:packages && node --test test/agent.test.js test/guest-node.test.js`.
      - Coverage not separately measured; focused tests cover new Node direct-dispatch limit and Agent request header limit while existing Agent tests preserve chunked and streaming behavior.
      - Deduplication: limits are package-specific Node Agent/direct-dispatch controls; no common extraction was needed.
- [x] Task: Conductor - User Manual Verification 'Node Guest Broker Agent Ingestion and Direct Dispatch Bounds (Issues #9 and Node part of #10)' (Protocol in workflow.md)
  - User approved moving to the Python phase after focused validation.
  - Phase checkpoint commit: `f65c177`.

## Phase 3: Python Guest Direct Dispatch Bounds, HTTP/2 Body ACK Backpressure, and Cleanup (Issues Python part of #10, #12, and #13)

- [x] Task: Confirm Python Guest scope, entrypoints, and package-specific validation
    - [x] Review `packages/verser2-guest-python/src/verser2_guest_python/asgi.py` and `guest.py`.
    - [x] Review Python Guest tests for ASGI direct dispatch, leased request/response streaming, and HTTP/2 flow-control behavior.
    - [x] Scan existing common or Python-local helpers for reusable bounded-buffer or error behavior before adding new package-local code.
      - Python direct-dispatch response bounds and HTTP/2 ACK timing are package-specific; no common extraction is needed.
- [x] Task: Write failing tests for Python direct-dispatch response bounds (Issue #10)
    - [x] Add tests proving `dispatch_asgi_request(...)` rejects responses over configured/default `max_response_bytes`.
    - [x] Add assertions that leased streaming response paths still stream chunks before response completion.
    - [x] Confirm the new direct-dispatch response-limit test fails before implementation.
      - Initial focused Python package test failed as expected for missing `max_response_bytes` support.
- [x] Task: Implement Python direct-dispatch response bounds and documentation (Issue #10)
    - [x] Add configurable/default max buffered response size behavior for direct Python ASGI dispatch.
    - [x] Enforce the limit while ASGI response chunks are appended, before `b''.join(...)`.
    - [x] Document direct ASGI dispatch as batch-only and distinguish it from leased streaming response behavior.
- [x] Task: Write failing tests for Python HTTP/2 request-body ACK backpressure (Issue #12)
    - [x] Add tests with delayed ASGI `receive()` consumption to prove `WINDOW_UPDATE` credit is not sent when data is merely parsed.
    - [x] Add tests proving credit is sent after the corresponding queued body event is consumed.
    - [x] Verify tests use `event.flow_controlled_length` semantics rather than `len(event.data)` assumptions.
    - [x] Confirm the tests fail for the expected immediate-ACK behavior before implementation.
- [x] Task: Implement Python HTTP/2 request-body ACK backpressure (Issue #12)
    - [x] Remove request-body `DataReceived` ACKs from the HTTP/2 read loop.
    - [x] Store `event.flow_controlled_length` with each queued ASGI body event.
    - [x] Acknowledge received data only after ASGI `receive()` dequeues/consumes the body event.
    - [x] Preserve existing leased request/response streaming behavior and error handling.
- [x] Task: Remove unused Python full-body request reader (Issue #13)
    - [x] Confirm `_read_request_envelope_and_body(...)` has no call sites.
    - [x] Remove the helper without adding a replacement full-body request reader.
    - [x] Ensure imports and type references remain clean after removal.
- [x] Task: Validate Python Guest changes
    - [x] Run the narrowest Python Guest tests covering ASGI direct dispatch, leased streaming, flow-control ACK behavior, and cleanup.
    - [x] Run package-level validation with `uv` if needed for Python package commands.
    - [x] Run repository build/test/lint validation if touched docs or shared integration paths require it.
    - [x] Record coverage status or why coverage could not be measured for changed behavior.
    - [x] Perform a deduplication check and record whether common code was added, adapted, or intentionally deferred.
      - Validation passed: `npm run test --workspace=@signicode/verser2-guest-python`.
      - Coverage not separately measured; focused tests cover direct response cap and ACK timing behavior.
      - Deduplication: Python-specific direct-dispatch and flow-control behavior was implemented locally; common extraction is intentionally deferred.
- [x] Task: Conductor - User Manual Verification 'Python Guest Direct Dispatch Bounds, HTTP/2 Body ACK Backpressure, and Cleanup (Issues Python part of #10, #12, and #13)' (Protocol in workflow.md)
  - User approved moving to final validation after focused Python package validation.

## Phase 4: Cross-Package Final Validation and GitHub Issue Handoff

- [ ] Task: Confirm specification coverage across all GitHub issues
    - [ ] Check each acceptance criterion from issues #9, #10, #11, #12, and #13 against implemented tests and code.
    - [ ] Confirm direct batch dispatch and leased streaming documentation is consistent across Node and Python.
    - [ ] Confirm no unrelated HTTP/3, authentication, authorization, or new-runtime behavior was introduced.
- [ ] Task: Run final narrow-to-broad validation
    - [ ] Run focused tests for all changed areas if not already run after final edits.
    - [ ] Run `npm run build` if package build artifacts or TypeScript integration changed.
    - [ ] Run `npm run lint` for code style validation.
    - [ ] Run `npm run test` when needed to prove integrated Host/Guest/Broker behavior.
- [ ] Task: Update Conductor and handoff notes
    - [ ] Update `plan.md` task statuses and record validation outcomes.
    - [ ] Note any GitHub issues that should be closed or commented on manually after PR review.
    - [ ] Prepare a concise implementation summary with validation results and residual risks.
- [ ] Task: Conductor - User Manual Verification 'Cross-Package Final Validation and GitHub Issue Handoff' (Protocol in workflow.md)

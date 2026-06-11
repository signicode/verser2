# Implementation Plan: Address GitHub Issues from 2026-06-11

## Phase 1: Common Envelope Parser Bounds (Issue #11)

- [ ] Task: Confirm common package scope and reusable primitives
    - [ ] Review `packages/verser-common/src/lib/envelope.ts` and existing envelope/parser tests.
    - [ ] Confirm existing protocol-error helpers and metadata limit behavior to reuse for oversized pending parser input.
    - [ ] Record whether any new constants or helpers should be exported from `@signicode/verser-common`.
- [ ] Task: Write failing tests for bounded pending parser input
    - [ ] Add focused tests for repeated small chunks that exceed `VERSER_ENVELOPE_PREFIX_BYTES + maxMetadataBytes` before a complete envelope is available.
    - [ ] Add or preserve tests proving valid split-envelope parsing still works.
    - [ ] Run the narrowest relevant test command and confirm the new bounded-pending-input test fails for the expected reason.
- [ ] Task: Implement parser pending-buffer limit
    - [ ] Update `createVerserEnvelopeParser(...)` to reject pending input beyond the maximum valid envelope size.
    - [ ] Surface an error consistent with existing oversized metadata protocol-error behavior.
    - [ ] Keep stream-reader paths and valid envelope parsing behavior compatible.
- [ ] Task: Validate common package change
    - [ ] Run the narrowest focused validation for common envelope tests.
    - [ ] Run broader build or test validation if the focused command does not cover package integration.
    - [ ] Record coverage status or why coverage could not be measured for changed behavior.
- [ ] Task: Conductor - User Manual Verification 'Common Envelope Parser Bounds (Issue #11)' (Protocol in workflow.md)

## Phase 2: Node Guest Broker Agent Ingestion and Direct Dispatch Bounds (Issues #9 and Node part of #10)

- [ ] Task: Confirm Node Guest scope, entrypoints, and reusable common code
    - [ ] Review `packages/verser2-guest-node/src/lib/broker-socket.ts`, `chunked-body-decoder.ts`, and `minimal-http.ts`.
    - [ ] Review related Node Guest tests for Broker Agent request ingestion, chunked uploads, direct dispatch, and leased streaming behavior.
    - [ ] Scan `@signicode/verser-common` for reusable limit, error, or protocol primitives before adding package-local code.
- [ ] Task: Write failing tests for Broker Agent request backpressure (Issue #9)
    - [ ] Add a non-chunked upload test proving `_write()` completion waits for downstream body consumer acceptance when `write(...)` returns `false`.
    - [ ] Add a chunked upload test proving the decoder path waits for downstream `drain` before accepting more body bytes.
    - [ ] Confirm the tests fail for the expected backpressure reason before implementation.
- [ ] Task: Write failing tests for request parsing bounds (Issue #9)
    - [ ] Add tests for oversized or unterminated request headers exceeding configurable/default `maxRequestHeaderBytes`.
    - [ ] Add tests for malformed, oversized, or incomplete chunk-size lines and excessive pending chunk-decoder buffers.
    - [ ] Confirm the tests fail for the expected unbounded or missing-limit behavior before implementation.
- [ ] Task: Implement Broker Agent request backpressure and bounds (Issue #9)
    - [ ] Defer `VerserBrokerSocket._write(...)` callbacks until downstream request-body writes are accepted.
    - [ ] Propagate `write(...) === false` and `drain` through non-chunked and chunked request-body ingestion.
    - [ ] Add configurable/default request-header, chunk-size-line, and chunk-decoder pending-buffer limits.
    - [ ] Destroy or fail the socket/request path with an appropriate protocol/request error when limits are exceeded.
- [ ] Task: Write failing tests for Node direct-dispatch response bounds (Issue #10)
    - [ ] Add tests showing direct Node dispatch rejects responses over configured/default max buffered response size.
    - [ ] Add compatibility tests or assertions proving leased response streaming behavior is not routed through the new batch limit.
    - [ ] Confirm the new direct-dispatch limit test fails before implementation.
- [ ] Task: Implement Node direct-dispatch response bounds and documentation (Issue #10)
    - [ ] Add configurable/default `maxResponseBytes` behavior to direct Node dispatch or `MinimalServerResponse` construction.
    - [ ] Enforce the limit while response chunks are written, before `Buffer.concat(...)`.
    - [ ] Document direct dispatch as batch-only and distinguish it from leased streaming behavior.
- [ ] Task: Validate Node Guest changes
    - [ ] Run the narrowest Node Guest tests covering Broker Agent ingestion, chunked decoder behavior, and direct dispatch.
    - [ ] Run build/staging validation if package artifacts are required for the focused tests.
    - [ ] Run lint or broader tests if touched files are not fully covered by focused validation.
    - [ ] Record coverage status or why coverage could not be measured for changed behavior.
    - [ ] Perform a deduplication check and move reusable limit/error behavior to common if repetition emerged.
- [ ] Task: Conductor - User Manual Verification 'Node Guest Broker Agent Ingestion and Direct Dispatch Bounds (Issues #9 and Node part of #10)' (Protocol in workflow.md)

## Phase 3: Python Guest Direct Dispatch Bounds, HTTP/2 Body ACK Backpressure, and Cleanup (Issues Python part of #10, #12, and #13)

- [ ] Task: Confirm Python Guest scope, entrypoints, and package-specific validation
    - [ ] Review `packages/verser2-guest-python/src/verser2_guest_python/asgi.py` and `guest.py`.
    - [ ] Review Python Guest tests for ASGI direct dispatch, leased request/response streaming, and HTTP/2 flow-control behavior.
    - [ ] Scan existing common or Python-local helpers for reusable bounded-buffer or error behavior before adding new package-local code.
- [ ] Task: Write failing tests for Python direct-dispatch response bounds (Issue #10)
    - [ ] Add tests proving `dispatch_asgi_request(...)` rejects responses over configured/default `max_response_bytes`.
    - [ ] Add assertions that leased streaming response paths still stream chunks before response completion.
    - [ ] Confirm the new direct-dispatch response-limit test fails before implementation.
- [ ] Task: Implement Python direct-dispatch response bounds and documentation (Issue #10)
    - [ ] Add configurable/default max buffered response size behavior for direct Python ASGI dispatch.
    - [ ] Enforce the limit while ASGI response chunks are appended, before `b''.join(...)`.
    - [ ] Document direct ASGI dispatch as batch-only and distinguish it from leased streaming response behavior.
- [ ] Task: Write failing tests for Python HTTP/2 request-body ACK backpressure (Issue #12)
    - [ ] Add tests with delayed ASGI `receive()` consumption to prove `WINDOW_UPDATE` credit is not sent when data is merely parsed.
    - [ ] Add tests proving credit is sent after the corresponding queued body event is consumed.
    - [ ] Verify tests use `event.flow_controlled_length` semantics rather than `len(event.data)` assumptions.
    - [ ] Confirm the tests fail for the expected immediate-ACK behavior before implementation.
- [ ] Task: Implement Python HTTP/2 request-body ACK backpressure (Issue #12)
    - [ ] Remove request-body `DataReceived` ACKs from the HTTP/2 read loop.
    - [ ] Store `event.flow_controlled_length` with each queued ASGI body event.
    - [ ] Acknowledge received data only after ASGI `receive()` dequeues/consumes the body event.
    - [ ] Preserve existing leased request/response streaming behavior and error handling.
- [ ] Task: Remove unused Python full-body request reader (Issue #13)
    - [ ] Confirm `_read_request_envelope_and_body(...)` has no call sites.
    - [ ] Remove the helper without adding a replacement full-body request reader.
    - [ ] Ensure imports and type references remain clean after removal.
- [ ] Task: Validate Python Guest changes
    - [ ] Run the narrowest Python Guest tests covering ASGI direct dispatch, leased streaming, flow-control ACK behavior, and cleanup.
    - [ ] Run package-level validation with `uv` if needed for Python package commands.
    - [ ] Run repository build/test/lint validation if touched docs or shared integration paths require it.
    - [ ] Record coverage status or why coverage could not be measured for changed behavior.
    - [ ] Perform a deduplication check and record whether common code was added, adapted, or intentionally deferred.
- [ ] Task: Conductor - User Manual Verification 'Python Guest Direct Dispatch Bounds, HTTP/2 Body ACK Backpressure, and Cleanup (Issues Python part of #10, #12, and #13)' (Protocol in workflow.md)

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

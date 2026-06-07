# Implementation Plan: Leased HTTP/2 Streams for Routed Bodies

## Phase 0: Track Setup, Branch/PR, and Baseline Verification

- [ ] Task: Confirm scope and baseline
    - [ ] Read `conductor/index.md`, `product.md`, `tech-stack.md`, `workflow.md`, this track `spec.md`, and the leased-stream handoff document.
    - [ ] Confirm the affected packages: `@signicode/verser-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node`.
    - [ ] Confirm current MVP routed body transfer still uses NDJSON/base64 frames before replacement work begins.
    - [ ] Review existing common exports for reusable protocol, error, lifecycle, and HTTP/2 helpers.
- [ ] Task: Create review branch and PR
    - [ ] Create a dedicated branch for this track, using the track id as the branch name.
    - [ ] Push the branch to `origin`.
    - [ ] Create a GitHub pull request with `gh` for review and phase checkpoints.
    - [ ] Record the PR URL in `plan.md`.
- [ ] Task: Establish baseline validation
    - [ ] Run `npm run build`.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Run coverage measurement and record baseline coverage.
- [ ] Task: Conductor - User Manual Verification 'Phase 0: Track Setup, Branch/PR, and Baseline Verification' (Protocol in workflow.md)

## Phase 1: Shared Binary Envelope Foundations

- [ ] Task: Write failing common envelope tests first
    - [ ] Add tests for request, response, and error envelope encoding.
    - [ ] Add parser tests for partial prefix chunks, partial metadata chunks, and body bytes arriving with metadata.
    - [ ] Add validation tests for invalid version, unknown envelope type, oversized metadata, and malformed JSON.
    - [ ] Add metadata/header validation tests for invalid header names and forbidden HTTP/1 connection headers.
- [ ] Task: Implement shared envelope helpers in `@signicode/verser-common`
    - [ ] Add envelope types, constants, metadata shapes, and encode helpers.
    - [ ] Add incremental parser helpers that return parsed metadata and body remainder without losing bytes.
    - [ ] Add metadata and header validation helpers with contextual errors.
    - [ ] Export new helpers from the common package entrypoint.
- [ ] Task: Validate and deduplicate common foundations
    - [ ] Run focused common tests and `npm run build`.
    - [ ] Confirm no package-local duplicate envelope or metadata validation logic exists.
    - [ ] Record coverage and deduplication notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Shared Binary Envelope Foundations' (Protocol in workflow.md)

## Phase 2: Host Lease Registration, Pooling, and Acquisition

- [ ] Task: Write failing Host lease tests first
    - [ ] Add tests for accepting Guest-opened lease streams on `/verser/guest/lease`.
    - [ ] Add tests for storing idle leases by Guest id and lease id.
    - [ ] Add tests for acquiring one idle lease per Broker routed request.
    - [ ] Add tests for queueing and timing out when no lease is available.
    - [ ] Add tests for lease cleanup on stream close, reset, error, and Guest disconnect.
- [ ] Task: Implement Host lease lifecycle
    - [ ] Add Host route handling for Guest lease streams.
    - [ ] Track idle, active, queued, and closed lease state per Guest.
    - [ ] Implement lease acquisition with timeout and actionable contextual errors.
    - [ ] Ensure Guest disconnect fails active and queued requests and removes idle leases.
    - [ ] Emit or preserve lifecycle/error diagnostics for lease close and failure paths.
- [ ] Task: Validate Host lease behavior
    - [ ] Run focused Host and routing tests.
    - [ ] Run `npm run build`.
    - [ ] Record coverage and deduplication notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Host Lease Registration, Pooling, and Acquisition' (Protocol in workflow.md)

## Phase 3: Guest Lease Pool Management

- [ ] Task: Write failing Guest lease pool tests first
    - [ ] Add tests for Guest options: `minWaitingStreams`, `maxOpenStreams`, `leaseAcquireTimeoutMs`, and metadata size limits.
    - [ ] Add tests that Guest opens leases until `minWaitingStreams` is satisfied.
    - [ ] Add tests that Guest never exceeds `maxOpenStreams` across idle, active, and opening leases.
    - [ ] Add tests that Guest replenishes leases after assignment, close, cancellation, error, and reconnect while connected.
- [ ] Task: Implement Guest lease pool
    - [ ] Add lease pool configuration to the Node Guest public options.
    - [ ] Open Guest-initiated lease streams to the Host with peer id and lease id headers.
    - [ ] Maintain opening, waiting, active, and closed lease accounting.
    - [ ] Replenish leases safely without runaway loops or exceeding stream limits.
    - [ ] Integrate lease shutdown into Guest `close()` and disconnect handling.
- [ ] Task: Validate Guest lease behavior
    - [ ] Run focused Guest tests and Host lease tests.
    - [ ] Run `npm run build`.
    - [ ] Record coverage and deduplication notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Guest Lease Pool Management' (Protocol in workflow.md)

## Phase 4: Leased Routed Request and Response Transport

- [ ] Task: Write failing routed transport tests first
    - [ ] Add tests that Broker request bodies stream raw bytes Host-to-Guest over a leased stream.
    - [ ] Add tests that Guest response bodies stream raw bytes Guest-to-Host-to-Broker over the same lease.
    - [ ] Add binary round-trip tests with null bytes and non-UTF-8 data.
    - [ ] Add tests that multiple concurrent Broker requests use distinct leases and complete out of order.
    - [ ] Add tests that existing `broker.request()` behavior remains compatible.
- [ ] Task: Implement Host leased routing
    - [ ] Replace Host forwarding of routed request/response body frames with lease acquisition and raw stream piping.
    - [ ] Write request metadata envelope before piping Broker request body bytes to the lease.
    - [ ] Parse Guest response metadata envelope before sending status and headers to the Broker stream.
    - [ ] Pipe Guest response body bytes to the Broker stream without base64 encoding.
- [ ] Task: Implement Guest leased dispatch
    - [ ] Parse request metadata envelope on assigned leases.
    - [ ] Dispatch raw leased request body bytes into the attached local HTTP handler.
    - [ ] Write response metadata envelope followed by raw response body bytes.
    - [ ] Preserve normal method, path, headers, status, and body semantics.
- [ ] Task: Validate routed transport migration
    - [ ] Run focused Broker routing, Guest, Host, and end-to-end tests.
    - [ ] Run `npm run build`.
    - [ ] Record coverage and deduplication notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Leased Routed Request and Response Transport' (Protocol in workflow.md)

## Phase 5: Backpressure, Cancellation, and Error Semantics

- [ ] Task: Write failing streaming and failure tests first
    - [ ] Add slow Broker response consumer tests to verify backpressure throttles Guest response production.
    - [ ] Add slow Guest request consumer tests to verify backpressure throttles Broker upload.
    - [ ] Add Broker abort tests that cancel the active Guest lease.
    - [ ] Add Guest disconnect tests that fail active and queued requests.
    - [ ] Add lease timeout and lease stream reset/error tests.
    - [ ] Add Guest handler failure tests before and after response metadata/body starts.
- [ ] Task: Implement robust cancellation and error propagation
    - [ ] Propagate Broker aborts to active leases and local Guest dispatch.
    - [ ] Reset or close both legs consistently on lease stream errors.
    - [ ] Fail queued requests on Guest disconnect with contextual diagnostics.
    - [ ] Map pre-response Guest errors to actionable routed errors where possible.
    - [ ] Reset/cancel streams and emit lifecycle/error diagnostics for post-response-start failures.
- [ ] Task: Validate backpressure and failure behavior
    - [ ] Run focused streaming/cancellation tests with timeouts that avoid hangs.
    - [ ] Run `npm run build`.
    - [ ] Record coverage and unresolved edge-case notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Backpressure, Cancellation, and Error Semantics' (Protocol in workflow.md)

## Phase 6: Remove NDJSON Body Frames and Preserve Agent Compatibility

- [ ] Task: Write failing migration and Agent tests first
    - [ ] Add or update tests proving routed request/response body transfer no longer uses `bodyBase64` NDJSON frames.
    - [ ] Update Agent tests to prove the plain `node:http` Agent path still works through leased routing.
    - [ ] Add regression tests for route advertisements remaining on the control stream.
- [ ] Task: Remove old routed body frame path
    - [ ] Remove request/response `bodyBase64` routing frame handling from Host and Guest routed body transfer.
    - [ ] Keep control-stream route advertisements and required coordination behavior.
    - [ ] Remove obsolete types, helpers, or tests that only exist for NDJSON body transfer.
    - [ ] Ensure docs and README describe leased streams as the current routed body transport.
- [ ] Task: Validate migration compatibility
    - [ ] Run focused Agent, Broker routing, and end-to-end tests.
    - [ ] Run `npm run build`.
    - [ ] Run `npm run lint`.
    - [ ] Record coverage and deduplication notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 6: Remove NDJSON Body Frames and Preserve Agent Compatibility' (Protocol in workflow.md)

## Phase 7: End-to-End Validation, Documentation, and Final Review

- [ ] Task: Add or update final end-to-end coverage
    - [ ] Add an end-to-end test covering Host start, Guest lease pool warmup, Broker routed request, binary body round-trip, Agent routing, and route advertisement preservation.
    - [ ] Add concurrency end-to-end coverage for out-of-order completion over separate leases.
    - [ ] Add cancellation or disconnect end-to-end coverage for active leased routing.
- [ ] Task: Update documentation
    - [ ] Update README with leased HTTP/2 stream routing behavior and Guest lease pool options.
    - [ ] Document current limitations, including HTTP/3 exclusion and any remaining buffering in public APIs.
    - [ ] Update Conductor product or tech-stack docs if the current transport model changes materially.
- [ ] Task: Run full validation
    - [ ] Run `npm run build`.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Run coverage measurement and confirm at least 95% meaningful coverage for changed behavior.
- [ ] Task: Final code and Conductor review
    - [ ] Re-read `AGENTS.md` and relevant Conductor documentation before completion.
    - [ ] Confirm implementation matches `spec.md` acceptance criteria.
    - [ ] Review edge cases, lifecycle behavior, error paths, streaming, backpressure, and concurrent leases.
    - [ ] Confirm shared code was centralized in `@signicode/verser-common` where reuse emerged.
    - [ ] Update `plan.md` with validation notes, deduplication results, and phase checkpoint commit SHAs.
- [ ] Task: Conductor - User Manual Verification 'Phase 7: End-to-End Validation, Documentation, and Final Review' (Protocol in workflow.md)

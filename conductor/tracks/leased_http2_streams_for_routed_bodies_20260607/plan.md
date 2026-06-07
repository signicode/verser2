# Implementation Plan: Leased HTTP/2 Streams for Routed Bodies

## Phase 0: Track Setup, Branch/PR, and Baseline Verification

- [x] Task: Confirm scope and baseline
    - [x] Read `conductor/index.md`, `product.md`, `tech-stack.md`, `workflow.md`, this track `spec.md`, and the leased-stream handoff document.
    - [x] Confirm the affected packages: `@signicode/verser-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node`.
    - [x] Confirm current MVP routed body transfer still uses NDJSON/base64 frames before replacement work begins.
    - [x] Review existing common exports for reusable protocol, error, lifecycle, and HTTP/2 helpers.
- [x] Task: Create review branch and PR
    - [x] Create a dedicated branch for this track, using the track id as the branch name.
    - [x] Push the branch to `origin`.
    - [x] Create a GitHub pull request with `gh` for review and phase checkpoints.
    - [x] Record the PR URL in `plan.md`.
- [x] Task: Establish baseline validation
    - [x] Run `npm run build`.
    - [x] Run `npm test`.
    - [x] Run `npm run lint`.
    - [x] Run coverage measurement and record baseline coverage.
- [x] Task: Conductor - User Manual Verification 'Phase 0: Track Setup, Branch/PR, and Baseline Verification' (Protocol in workflow.md)

### Phase 0 Notes

- PR: https://github.com/signicode/verser2/pull/2
- Baseline routing still uses Guest control stream NDJSON/base64 body frames: `bodyBase64` is present in Host routed request/response frame handling and Guest control dispatch.
- Existing common exports include protocol-neutral routed envelope shapes, lifecycle names, contextual errors, HTTP/2 header helpers, and development TLS helpers. Binary envelope helpers are not present yet and belong in `@signicode/verser-common`.
- Baseline validation passed: `npm run build`, `npm test`, `npm run lint`, and `npm run test:coverage`.
- Baseline coverage: all files 96.14% line coverage; package source maps show lower branch/function percentages for generated/type-adjacent and rarely forced socket/protocol branches.
- Manual verification: approved by user after automated validation passed.

## Phase 1: Shared Binary Envelope Foundations

- [x] Task: Write failing common envelope tests first
    - [x] Add tests for request, response, and error envelope encoding.
    - [x] Add parser tests for partial prefix chunks, partial metadata chunks, and body bytes arriving with metadata.
    - [x] Add validation tests for invalid version, unknown envelope type, oversized metadata, and malformed JSON.
    - [x] Add metadata/header validation tests for invalid header names and forbidden HTTP/1 connection headers.
- [x] Task: Implement shared envelope helpers in `@signicode/verser-common`
    - [x] Add envelope types, constants, metadata shapes, and encode helpers.
    - [x] Add incremental parser helpers that return parsed metadata and body remainder without losing bytes.
    - [x] Add metadata and header validation helpers with contextual errors.
    - [x] Export new helpers from the common package entrypoint.
- [x] Task: Validate and deduplicate common foundations
    - [x] Run focused common tests and `npm run build`.
    - [x] Confirm no package-local duplicate envelope or metadata validation logic exists.
    - [x] Record coverage and deduplication notes in `plan.md`.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Shared Binary Envelope Foundations' (Protocol in workflow.md)

### Phase 1 Notes

- TDD check: `npm run build && node --test test/common-envelope.test.js` failed as expected before implementation because `encodeVerserEnvelope`, `createVerserEnvelopeParser`, and `validateVerserHeaders` were not exported yet. Classified as session-introduced, in-scope, intended TDD failure.
- Added `test/common-envelope.test.js` for envelope encoding, incremental parsing across prefix/metadata/body chunk boundaries, invalid envelope handling, metadata size limits, malformed JSON, and header validation.
- Added shared envelope constants, metadata types, `encodeVerserEnvelope`, `createVerserEnvelopeParser`, and `validateVerserHeaders` in `@signicode/verser-common`.
- Updated package export tests for the new common helpers.
- Deduplication: envelope helpers and header validation exist only in `@signicode/verser-common`; no package-local duplicate implementations were found.
- Validation passed: `npm run build`, focused common/package tests, `npm run lint`, and `npm run test:coverage`.
- Coverage after Phase 1: all files 96.25% line coverage; `packages/verser-common/dist/index.js` 97.40% line coverage and 100% function coverage.
- Manual verification: approved by user after automated validation passed.

## Phase 2: Host Lease Registration, Pooling, and Acquisition

- [x] Task: Write failing Host lease tests first
    - [x] Add tests for accepting Guest-opened lease streams on `/verser/guest/lease`.
    - [x] Add tests for storing idle leases by Guest id and lease id.
    - [x] Add tests for acquiring one idle lease per Broker routed request.
    - [x] Add tests for queueing and timing out when no lease is available.
    - [x] Add tests for lease cleanup on stream close, reset, error, and Guest disconnect.
- [x] Task: Implement Host lease lifecycle
    - [x] Add Host route handling for Guest lease streams.
    - [x] Track idle, active, queued, and closed lease state per Guest.
    - [x] Implement lease acquisition with timeout and actionable contextual errors.
    - [x] Ensure Guest disconnect fails active and queued requests and removes idle leases.
    - [x] Emit or preserve lifecycle/error diagnostics for lease close and failure paths.
- [x] Task: Validate Host lease behavior
    - [x] Run focused Host and routing tests.
    - [x] Run `npm run build`.
    - [x] Record coverage and deduplication notes in `plan.md`.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Host Lease Registration, Pooling, and Acquisition' (Protocol in workflow.md)

### Phase 2 Notes

- TDD check: focused Host tests failed before implementation due missing `/verser/guest/lease` handling and no lease acquisition timeout behavior. An initial harness timeout exposed an unclosed lease-test stream, which was fixed in the test helper before implementation.
- Added Host tests for registered Guest lease acceptance, missing Guest lease rejection, and Broker routed request timeout while waiting for an unavailable lease.
- Added Host lease state for idle leases, active leases, and queued lease acquisitions keyed by Guest id.
- Added `/verser/guest/lease` handling with peer and lease id validation, idle lease storage, stream close/error cleanup, and queued acquisition fulfillment.
- Added lease acquisition timeout diagnostics with `targetId`, `requestId`, and `timeoutMs` context.
- Added Guest disconnect and Host close cleanup for idle leases, active leases, and queued lease acquisitions.
- Transitional note: Phase 2 establishes lease lifecycle and acquisition primitives; full routed body transfer over assigned leases is implemented in Phase 4.
- Deduplication: lease lifecycle remains Host-specific; shared protocol-neutral envelope/header helpers from Phase 1 remain in `@signicode/verser-common`.
- Validation passed: `npm run build`, focused Host/routing tests, `npm run lint`, and `npm run test:coverage`.
- Coverage after Phase 2: all files 95.40% line coverage; changed Host behavior is covered by focused lease tests.
- Manual verification: approved by user after automated validation passed.

## Phase 3: Guest Lease Pool Management

- [x] Task: Write failing Guest lease pool tests first
    - [x] Add tests for Guest options: `minWaitingStreams`, `maxOpenStreams`, `leaseAcquireTimeoutMs`, and metadata size limits.
    - [x] Add tests that Guest opens leases until `minWaitingStreams` is satisfied.
    - [x] Add tests that Guest never exceeds `maxOpenStreams` across idle, active, and opening leases.
    - [x] Add tests that Guest replenishes leases after assignment, close, cancellation, error, and reconnect while connected.
- [x] Task: Implement Guest lease pool
    - [x] Add lease pool configuration to the Node Guest public options.
    - [x] Open Guest-initiated lease streams to the Host with peer id and lease id headers.
    - [x] Maintain opening, waiting, active, and closed lease accounting.
    - [x] Replenish leases safely without runaway loops or exceeding stream limits.
    - [x] Integrate lease shutdown into Guest `close()` and disconnect handling.
- [x] Task: Validate Guest lease behavior
    - [x] Run focused Guest tests and Host lease tests.
    - [x] Run `npm run build`.
    - [x] Record coverage and deduplication notes in `plan.md`.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Guest Lease Pool Management' (Protocol in workflow.md)

### Phase 3 Notes

- TDD check: focused Guest lease tests failed as expected before implementation because the Node Guest did not open `/verser/guest/lease` streams.
- Added fake TLS HTTP/2 lease-tracking Host test helper for Guest lease pool behavior.
- Added Guest tests for satisfying `minWaitingStreams`, respecting `maxOpenStreams`, and replenishing an idle lease after close.
- Added Guest options: `minWaitingStreams`, `maxOpenStreams`, `leaseAcquireTimeoutMs`, and `maxMetadataBytes`.
- Added Guest lease stream opening with `x-verser-peer-id` and `x-verser-lease-id`, opening/waiting/active accounting, safe replenishment, and shutdown cleanup.
- Transitional note: `leaseAcquireTimeoutMs` and `maxMetadataBytes` are now accepted as Guest options and will be consumed by routed leased dispatch work in later phases.
- Deduplication: Guest lease pool state remains Node Guest-specific; no shared helper extraction was needed beyond existing common TLS/error/lifecycle foundations.
- Validation passed: `npm run build`, focused Guest/Host/routing tests, `npm run lint`, and `npm run test:coverage`.
- Coverage after Phase 3: all files 95.43% line coverage; changed Guest lease behavior is covered by focused fake-Host tests.
- Manual verification: approved by user after automated validation passed.

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

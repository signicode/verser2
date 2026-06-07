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

- [x] Task: Write failing routed transport tests first
    - [x] Add tests that Broker request bodies stream raw bytes Host-to-Guest over a leased stream.
    - [x] Add tests that Guest response bodies stream raw bytes Guest-to-Host-to-Broker over the same lease.
    - [x] Add binary round-trip tests with null bytes and non-UTF-8 data.
    - [x] Add tests that multiple concurrent Broker requests use distinct leases and complete out of order.
    - [x] Add tests that `broker.request()` remains compatible except for the planned streaming response body API change.
- [x] Task: Implement Host leased routing
    - [x] Replace Host forwarding of routed request/response body frames with lease acquisition and raw stream piping.
    - [x] Write request metadata envelope before piping Broker request body bytes to the lease.
    - [x] Parse Guest response metadata envelope before sending status and headers to the Broker stream.
    - [x] Pipe Guest response body bytes to the Broker stream without base64 encoding.
- [x] Task: Implement Guest leased dispatch
    - [x] Parse request metadata envelope on assigned leases.
    - [x] Dispatch raw leased request body bytes into the attached local HTTP handler.
    - [x] Write response metadata envelope followed by raw response body bytes.
    - [x] Preserve normal method, path, headers, status, and body semantics.
- [x] Task: Validate routed transport migration
    - [x] Run focused Broker routing, Guest, Host, and end-to-end tests.
    - [x] Run `npm run build`.
    - [x] Record coverage and deduplication notes in `plan.md`.
- [x] Task: Conductor - User Manual Verification 'Phase 4: Leased Routed Request and Response Transport' (Protocol in workflow.md)

### Phase 4 Notes

- TDD check: a raw leased routing test failed before implementation because the Host acquired a lease but did not yet forward routed request/response envelopes over it.
- Added a low-level raw Guest test that registers a Guest, opens a lease without a Guest control stream, receives a request metadata envelope and raw binary body, and replies with response metadata plus raw binary body.
- Implemented Host leased routing: acquire idle lease, write request metadata envelope, write raw request body bytes, parse response/error envelope, and return raw response bytes to the Broker stream.
- Review fix: Host response handling now parses only the response metadata envelope using strict `stream.read()`/`readable` reads, unshifts any over-read body bytes when needed, and pipes the rest of the lease response stream to the Broker stream. No `data` handler is used for Host response metadata parsing.
- Added regression tests proving the Broker receives leased response body bytes before the lease stream ends, split response metadata is parsed correctly, and leased error envelopes map to Broker request errors.
- Implemented Guest leased dispatch: parse request metadata envelope, collect raw body bytes, dispatch into the attached local handler, and write response or error envelope followed by raw response bytes.
- Existing Agent, Host, Guest, Broker routing, and end-to-end tests continue to pass. Phase 5 later changes public `broker.request()` response bodies from aggregated buffers to streams to align the public API with leased streaming semantics.
- Deduplication: Host and Guest both use shared `@signicode/verser-common` envelope helpers; transport coordination remains package-specific.
- Validation passed: `npm run build`, focused Broker/Guest/Agent/Host/E2E tests, `npm run lint`, and `npm run test:coverage`.
- Coverage after Phase 4: all files 95.10% line coverage; changed leased routing behavior is covered by focused raw-lease, split metadata, lease error, lease response piping, and existing Broker/Guest integration tests.
- Manual verification: approved by user after strict `stream.read()` parser refactor and automated validation passed.

## Phase 5: Backpressure, Cancellation, and Error Semantics

- [x] Task: Write failing streaming and failure tests first
    - [x] Add slow Broker response consumer tests to verify backpressure throttles Guest response production.
    - [x] Add slow Guest request consumer tests to verify backpressure throttles Broker upload.
    - [x] Add Broker abort tests that cancel the active Guest lease.
    - [x] Add Guest disconnect tests that fail active and queued requests.
    - [x] Add lease timeout and lease stream reset/error tests.
    - [x] Add Guest handler failure tests before and after response metadata/body starts.
- [x] Task: Implement robust cancellation and error propagation
    - [x] Propagate Broker aborts to active leases and local Guest dispatch.
    - [x] Reset or close both legs consistently on lease stream errors.
    - [x] Fail queued requests on Guest disconnect with contextual diagnostics.
    - [x] Map pre-response Guest errors to actionable routed errors where possible.
    - [x] Reset/cancel streams and emit lifecycle/error diagnostics for post-response-start failures.
- [x] Task: Validate backpressure and failure behavior
    - [x] Run focused streaming/cancellation tests with timeouts that avoid hangs.
    - [x] Run `npm run build`.
    - [x] Record coverage and unresolved edge-case notes in `plan.md`.
- [x] Task: Conductor - User Manual Verification 'Phase 5: Backpressure, Cancellation, and Error Semantics' (Protocol in workflow.md)

### Phase 5 Notes

- TDD check: focused Broker routing tests failed before implementation because leased Node Guest responses were buffered until `response.end()`, Broker uploads were not observable on the lease until Broker request end, and active Broker aborts did not cancel the lease cleanly. The expected failures were classified as session-introduced, in-scope TDD failures.
- Added streaming/failure coverage for Node Guest response body chunks arriving before local response end, Broker upload bytes arriving on a raw lease before Broker request end, Broker abort cancellation of the active lease, active Guest disconnect failure, lease reset before response metadata, and Guest handler failure after response metadata/body start.
- Added Agent chunked request body coverage to preserve plain `node:http` Agent behavior through leased routing and cover request body extraction paths.
- Implemented Host leased upload streaming by writing the request envelope and piping the Broker request stream directly into the active lease instead of buffering with `readRequestBuffer`.
- Preserved the Phase 4 Host response parser invariant: response metadata parsing still uses `stream.read()`/`readable` via `readExactly`, with no Host `data` handler, and the response body is piped from lease to Broker after metadata is parsed.
- Implemented Guest leased streaming dispatch: request metadata is parsed first, body remainder is unshifted, the lease stream becomes the local request readable source, and `MinimalServerResponse` writes the response envelope on first response write/end and streams body chunks to the lease.
- Implemented cancellation/error propagation for Broker aborts, lease closes before response metadata, active Guest disconnects, and post-response-start Guest handler failures. Broker error mapping now preserves Host error codes such as `protocol-error` instead of collapsing them to `local-handler-failure`.
- Oracle review: confirmed the main risks were avoiding Host `data` parsing for response metadata, not buffering leased bodies, handling double-close races, and distinguishing pre-response from post-response failures.
- Follow-up deduplication review: moved exact byte stream reads, leased envelope stream parsing, typed leased request/response metadata readers, and NDJSON line parsing into `@signicode/verser-common`.
- Removed the redundant Host `readLeaseResponseMetadata` wrapper and Host-local `readExactly`/`waitForReadable`/response metadata parser implementation.
- Replaced the Guest leased request metadata `data` parser with the common exact-read helper and replaced Host/Guest NDJSON parser duplicates with common `readNdjsonLines`, preserving performant `data` handlers for NDJSON control streams.
- Updated raw lease tests to use common leased request metadata parsing instead of ad hoc `createVerserEnvelopeParser` `data` handlers.
- Removed public `broker.request()` response aggregation: it now returns a streaming response body and accepts either chunk arrays or a `Readable` upload body. Error response bodies are still read only to construct actionable routed errors.
- Refined `MinimalIncomingMessage` to extend `PassThrough` and pipe either the leased request stream or `Readable.from(request.body)` into the local request object, removing manual request-body `data`/`_read` flow.
- Full Host/Guest/Broker stream-side review found two remaining routed body aggregation paths: Host's legacy control-frame body fallback and the Broker Agent's serialized HTTP/1 request aggregation.
- Removed Host control-frame routed body fallback and obsolete Guest control-frame routed request handling; routed Broker requests now wait for/acquire a lease rather than falling back to NDJSON/base64 body frames.
- Refactored the Broker Agent upload path to parse HTTP/1 headers incrementally, stream request bodies through a `PassThrough`, and decode chunked bodies incrementally instead of collecting `requestChunks` and `Buffer.concat`ing them.
- Added Agent coverage proving request body bytes can reach the Guest and produce a response before the client request ends.
- Reviewed remaining `on('data')` usage after streaming cleanup: converted Broker Agent response forwarding to pipe through a response sink, converted registration/error-body helpers to `node:stream/consumers`, and left only shared `readNdjsonLines` using `data` for control-stream NDJSON framing.
- Deduplication: shared envelope, exact-read stream parsing, typed leased metadata readers, and NDJSON parsing are centralized in `@signicode/verser-common`; Phase 5 streaming/cancellation state remains Host/Node Guest-specific.
- Validation passed: `npm run build`, focused common/package/Broker/Guest/Host/Agent/E2E tests, `npm run lint`, and `npm run test:coverage`. After the `data` handler review, `npm run build && node --test --test-timeout=15000 test/agent.test.js test/broker-routing.test.js test/guest-node.test.js test/host.test.js` and `npm run lint` also passed.
- Coverage after Phase 5: all files 96.71% line coverage.
- Manual verification: approved by user; checkpoint committed as `3ea924c feat(streams): Complete streaming leased bodies` and pushed to PR branch.

## Phase 6: Remove NDJSON Body Frames and Preserve Agent Compatibility

- [x] Task: Write failing migration and Agent tests first
    - [x] Add or update tests proving routed request/response body transfer no longer uses `bodyBase64` NDJSON frames.
    - [x] Update Agent tests to prove the plain `node:http` Agent path still works through leased routing.
    - [x] Add regression tests for route advertisements remaining on the control stream.
- [x] Task: Remove old routed body frame path
    - [x] Remove request/response `bodyBase64` routing frame handling from Host and Guest routed body transfer.
    - [x] Keep control-stream route advertisements and required coordination behavior.
    - [x] Remove obsolete types, helpers, or tests that only exist for NDJSON body transfer.
    - [x] Ensure docs and README describe leased streams as the current routed body transport.
- [x] Task: Validate migration compatibility
    - [x] Run focused Agent, Broker routing, and end-to-end tests.
    - [x] Run `npm run build`.
    - [x] Run `npm run lint`.
    - [x] Record coverage and deduplication notes in `plan.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 6: Remove NDJSON Body Frames and Preserve Agent Compatibility' (Protocol in workflow.md)

### Phase 6 Notes

- TDD/dependency note: most old routed body frame removal was completed during Phase 5 stream-side cleanup because the remaining fallback aggregation paths directly violated Phase 5 streaming/cancellation semantics. Phase 6 added explicit regression coverage that Host and Node Guest routed sources no longer contain `bodyBase64`, `response-start`, `response-body`, or `response-end` control-frame body paths.
- Existing Agent tests already covered plain `node:http` Agent routing; Phase 5 added chunked-body and early-upload streaming Agent regressions that continue to validate Agent compatibility through leased routing.
- Route advertisements remain on control streams and continue to be covered by Host, Broker routing, Agent, and end-to-end tests.
- README now describes the current leased HTTP/2 stream transport, streaming `broker.request()` response body, retained control-stream route advertisements, and Node Guest lease pool options.
- Validation passed: `npm run build && node --test --test-timeout=15000 test/packages.test.js test/agent.test.js test/broker-routing.test.js test/end-to-end.test.js`, `npm run lint`, and `npm run test:coverage`.
- Formatting failure during the first Phase 6 lint run was session-introduced in `test/packages.test.js`, fixed locally, and the rerun passed.
- Coverage after Phase 6: all files 96.72% line coverage.

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

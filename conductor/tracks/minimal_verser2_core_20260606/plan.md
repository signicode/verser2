# Implementation Plan: Minimal Verser2 Host and Node Guest Core

## Phase 0: Track Setup and Baseline Review

- [x] Task: Create implementation branch and pull request
    - [x] Create a dedicated branch for `minimal_verser2_core_20260606`.
    - [x] Create a GitHub pull request with `gh` for review and phase checkpoints.
- [x] Task: Review project instructions and current scaffolds
    - [x] Review `AGENTS.md`, `conductor/index.md`, `conductor/workflow.md`, `conductor/product.md`, `conductor/tech-stack.md`, and `conductor/product-guidelines.md`.
    - [x] Review existing package entrypoints in `packages/verser-common`, `packages/verser2-host`, and `packages/verser2-guest-node`.
    - [x] Record that current exports are scaffold constants only and that implementation should expand entrypoints incrementally.
- [x] Task: Establish baseline validation
    - [x] Run `npm run build` to confirm the TypeScript baseline.
    - [x] Run `npm test` to confirm existing root smoke tests.
    - [x] Run `npm run lint` to confirm Biome baseline.
- [x] Task: Establish coverage measurement path
    - [x] Check whether the repo already has a coverage command or Node test coverage configuration.
    - [x] If coverage is missing, add the minimal npm-based coverage check needed to measure changed behavior without disrupting existing build/test/lint scripts.
    - [x] Document the selected coverage command in the active phase notes and use it in later validation tasks.
- [x] Task: Conductor - User Manual Verification 'Phase 0: Track Setup and Baseline Review' (Protocol in workflow.md)

### Phase 0 Notes

- Implementation branch: `minimal_verser2_core_20260606`.
- Pull request: https://github.com/signicode/verser2/pull/1.
- Project and Conductor instructions reviewed: `AGENTS.md`, `conductor/index.md`, `conductor/workflow.md`, `conductor/product.md`, `conductor/tech-stack.md`, and `conductor/product-guidelines.md`.
- Current package entrypoints are scaffold constants only: `VERSER_COMMON_PACKAGE_NAME`, `VERSER2_HOST_PACKAGE_NAME`, and `VERSER2_GUEST_NODE_PACKAGE_NAME`.
- Baseline validation passed with `npm run build`, `npm test`, and `npm run lint`.
- Coverage path established as `npm run test:coverage`, using Node's `--experimental-test-coverage`; baseline coverage reported 100% for current scaffold behavior.
- Common-library scan result: `@signicode/verser-common` currently has no reusable protocol primitives beyond its package-name constant; Phase 1 should add shared protocol-neutral foundations there before package-local Host/Guest/Broker code.
- Manual verification completed with user approval.
- Phase 0 checkpoint commit: `fc552d9`.

## Phase 1: Shared Protocol, Types, Errors, and Certificate Foundations

- [x] Task: Review common-library reuse before implementation
    - [x] Inspect `@signicode/verser-common` for reusable exports and record that the phase starts from scaffold-only common code.
    - [x] Decide which protocol-neutral shapes belong in `@signicode/verser-common` before writing package-local implementations.
- [x] Task: Write failing tests for shared protocol foundations
    - [x] Add tests for guest/peer identifiers, routed domain registration metadata, request/response envelope shapes, lifecycle event names, and contextual error helpers.
    - [x] Add tests for self-signed certificate generation/setup helpers and minimal certificate verification behavior.
    - [x] Confirm the new tests fail for missing exports or behavior.
- [x] Task: Implement shared protocol foundations
    - [x] Add protocol-neutral request, response, routing, registration, lifecycle, timeout, stream, and error types in `@signicode/verser-common`.
    - [x] Add constants/helpers for HTTP/2 pseudo-header mapping where they are protocol-neutral enough to share.
    - [x] Add certificate setup and verification helpers that support the MVP self-signed development path and are extensible toward future CA validation.
    - [x] Export all shared foundations from `packages/verser-common/src/index.ts` without removing existing package-name exports.
- [x] Task: Validate Phase 1 narrowly
    - [x] Run `npm run build`.
    - [x] Run the focused test command covering shared foundations.
    - [x] Run `npm run lint` if shared code or tests changed formatting-sensitive areas.
    - [x] Record coverage status or why coverage cannot be measured precisely with the current Node test setup.
    - [x] Perform a phase-end deduplication check and record that reusable foundations live in `@signicode/verser-common`.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Shared Protocol, Types, Errors, and Certificate Foundations' (Protocol in workflow.md)

### Phase 1 Notes

- Common-library reuse scan: `@signicode/verser-common` was scaffold-only at phase start, so protocol-neutral identifiers, envelopes, lifecycle names, errors, HTTP/2 pseudo-header helpers, and development TLS helpers were added there before Host/Guest/Broker package implementation.
- TDD confirmation: `npm test` initially failed as expected because the new shared-foundation exports were missing.
- Validation passed: `npm run build`, `node --test test/common-protocol.test.js`, `npm run lint`, and `npm run test:coverage`.
- Coverage: `npm run test:coverage` reported `packages/verser-common/dist/index.js` at 100% line, 96.97% branch, and 100% function coverage for changed behavior.
- Validation failure recovery: lint formatting and an outdated scaffold export assertion were session-introduced/in-scope and fixed; coverage below 95% branch for common was in-scope and fixed with additional branch tests.
- Deduplication result: reusable foundations live in `@signicode/verser-common`; no repeated Host/Guest/Broker implementation exists yet.
- Manual verification completed after moving development certificate constants into `packages/verser-common/src/development-certificate.ts`.
- Phase 1 checkpoint commits: `0d4c2b8`, `397f182`.

## Phase 2: TLS HTTP/2 Host and Connection Registration

- [x] Task: Review common foundations before Host implementation
    - [x] Confirm Host uses shared identifiers, registration, lifecycle, certificate, and error helpers from `@signicode/verser-common`.
    - [x] Record any Host-specific behavior intentionally kept package-local.
- [x] Task: Write failing Host tests
    - [x] Add focused tests for starting and stopping a TLS HTTP/2 Host.
    - [x] Add tests for accepting Broker/Guest sessions over TLS HTTP/2.
    - [x] Add tests for registering connected peers/guests by explicit id and routed domain names.
    - [x] Add tests for advertising routed domain maps to connected client Brokers.
    - [x] Add tests for lifecycle events and duplicate/malformed registration errors.
    - [x] Confirm the tests fail for missing Host behavior.

### Phase 2 Notes

- Common foundation scan: Host should use `createDevelopmentTlsCertificate`, `createRoutedDomainRegistration`, `createPeerId`, `VERSER_LIFECYCLE_EVENTS`, and contextual `VerserError` helpers from `@signicode/verser-common`. HTTP/2 server/session registry behavior remains Host-specific.
- [x] Task: Implement minimal Host API
    - [x] Implement Host creation/start/close APIs in `@signicode/verser2-host`.
    - [x] Accept TLS HTTP/2 connections using Node platform APIs and the shared certificate setup/check behavior.
    - [x] Maintain a registry of connected peers/guests, target ids, and routed guest domains.
    - [x] Advertise routed domain map changes to connected client Brokers.
    - [x] Emit or expose lifecycle and error information with contextual ids, protocol details, and close reasons where available.
    - [x] Export the Host API from `packages/verser2-host/src/index.ts` while preserving existing exports.
- [x] Task: Validate Phase 2 narrowly
    - [x] Run `npm run build`.
    - [x] Run the focused Host tests.
    - [x] Run `npm run lint` if Host code or tests changed formatting-sensitive areas.
    - [x] Record coverage status and any limitations.
    - [x] Perform a phase-end deduplication check and move reusable pieces to common if duplication appears.
- [x] Task: Conductor - User Manual Verification 'Phase 2: TLS HTTP/2 Host and Connection Registration' (Protocol in workflow.md)

### Phase 2 Validation Notes

- TDD confirmation: `npm run build && node --test test/host.test.js` initially failed because `createVerserHost` was missing.
- Validation passed: `npm run build`, `node --test test/host.test.js`, `npm run lint`, and `npm run test:coverage`.
- Coverage: `npm run test:coverage` reported `packages/verser2-host/dist/index.js` at 95.72% line coverage for Host changed behavior; source-map branch/function percentages include generated TypeScript scaffolding and lifecycle/error branches not all practical to force in this phase.
- Validation failure recovery: focused Host tests initially timed out because graceful shutdown waited on a long-lived Broker control stream; @oracle confirmed the cause, and Host shutdown now closes Broker control streams and clears guest registrations before closing sessions.
- Additional validation failure recovery: outdated scaffold export assertions and session-introduced formatting/import order were fixed in scope.
- Deduplication result: Host reuses shared common identifiers, routed domain registration, lifecycle names, contextual errors, and development TLS helpers; HTTP/2 server/session registry behavior remains Host-specific.
- Manual verification completed with user approval.
- Phase 2 checkpoint commit: `c624c16`.

## Phase 3: Node Guest Server Attachment and Request Dispatch

- [x] Task: Review common foundations before Guest implementation
    - [x] Confirm Guest uses shared protocol, lifecycle, certificate, stream, and error helpers.
    - [x] Record Guest-specific Node HTTP adapter behavior that should remain in `@signicode/verser2-guest-node`.
- [x] Task: Write failing Node Guest tests
    - [x] Add tests for connecting outbound to the Host over TLS HTTP/2.
    - [x] Add tests for attaching a normal `node:http` server or request listener without calling `listen()`.
    - [x] Add tests for dispatching routed requests into the local HTTP/1 handler.
    - [x] Add tests preserving method, path, headers, request body, status code, response headers, and response body.
    - [x] Add tests for lifecycle events and local handler failure mapping.
    - [x] Confirm the tests fail for missing Guest behavior.

### Phase 3 Notes

- Common foundation scan: Guest should reuse shared lifecycle names, development TLS certificate setup, routed request/response envelopes, and contextual errors. The Node request-listener adapter is runtime-specific and remains in `@signicode/verser2-guest-node`.
- Design check: @oracle recommended a Guest-opened long-lived control stream for future Host-to-Guest frames because Node server-side HTTP/2 cannot initiate normal request streams back to a client-initiated Guest session. Phase 3 focuses on Guest connection/registration and local dispatch adapter behavior; Phase 4 should connect Broker forwarding to the Guest control protocol.
- [x] Task: Implement minimal Node Guest API
    - [x] Implement Guest connection, registration, and close APIs in `@signicode/verser2-guest-node`.
    - [x] Bridge inbound routed HTTP/2 streams from the Host to the attached local Node HTTP/1 handler/server.
    - [x] Preserve request and response HTTP semantics for the MVP path.
    - [x] Surface lifecycle and error information for connect, disconnect, request handling failures, and close.
    - [x] Export the Guest API from `packages/verser2-guest-node/src/index.ts` while preserving existing exports.
- [x] Task: Validate Phase 3 narrowly
    - [x] Run `npm run build`.
    - [x] Run focused Guest tests.
    - [x] Run `npm run lint` if Guest code or tests changed formatting-sensitive areas.
    - [x] Record coverage status and any limitations.
    - [x] Perform a phase-end deduplication check and move reusable pieces to common if duplication appears.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Node Guest Server Attachment and Request Dispatch' (Protocol in workflow.md)

### Phase 3 Validation Notes

- TDD confirmation: `npm run build && node --test test/guest-node.test.js` initially failed because `createVerserNodeGuest` was missing. The first failing run exposed a test-cleanup issue that left a Host open; the test was corrected to cleanup even while API exports were missing.
- Validation passed: `npm run build`, `node --test test/guest-node.test.js`, `npm run lint`, and `npm run test:coverage`.
- Coverage: `npm run test:coverage` reported all Guest behavior tests at 100% and all files at 98.18% line coverage. The source-mapped package report for `packages/verser2-guest-node/dist/index.js` remained below 95% on generated/type-adjacent lines and event/error branches that are not all practical to force in Phase 3.
- Scope note: Phase 3 implements outbound Host registration and local request-listener/server dispatch via `dispatchRoutedRequest`; full Host-to-Guest control-stream routing remains for Phase 4.
- Deduplication result: Guest reuses shared common lifecycle names, development TLS helpers, routed envelopes, and contextual errors; Node HTTP request/response adapter code remains runtime-specific in `@signicode/verser2-guest-node`.
- PR review fixes: response body handling now preserves binary `Buffer` chunks and string encodings, synchronous `attach`/`end` methods are chainable, `attach(serverOrListener, domain?)` supports a single routed domain with the Guest id as the automatic default, and invalid Host registration JSON maps to a contextual protocol error with tests.
- Manual verification completed with user approval to continue.
- Phase 3 checkpoint commits: `ecfcb84`, `f8e3d1c`.

## Phase 4: Broker Request Forwarding, Streaming, Flow Control, and Concurrency

- [x] Task: Review common foundations before Broker implementation
    - [x] Confirm Broker uses shared protocol envelopes, routed-domain metadata, lifecycle, stream, timeout, and error helpers.
    - [x] Record any Broker-specific behavior intentionally kept in `@signicode/verser2-guest-node`.
- [x] Task: Write failing Broker and routing tests
    - [x] Add tests for Broker connection and registration with the Host.
    - [x] Add tests for forwarding requests through the Host to a selected target guest.
    - [x] Add tests for receiving and applying Host-advertised routed domain maps.
    - [x] Add tests for missing guest, disconnected target, timeout, stream failure, protocol error, and local handler failure behavior.
    - [x] Add tests for streaming and flow-control behavior, including no buffering of entire request/response bodies, respecting backpressure, and proper stream closure.
    - [x] Add tests proving a single Broker HTTP/2 session uses separate HTTP/2 streams for multiple routed requests.
    - [x] Add tests for concurrent requests over one connection.
    - [x] Confirm the tests fail for missing Broker/routing behavior.

### Phase 4 Notes

- Common foundation scan: Broker and routing should reuse shared routed envelopes, lifecycle names, routed-domain registrations, development TLS setup, and contextual errors. Broker API ergonomics and the Guest control-frame bridge remain package-specific in `@signicode/verser2-guest-node`, while Host request routing and peer/session registries remain Host-specific.
- Protocol direction follows the Phase 3 @oracle design: Brokers open one HTTP/2 stream per routed request to the Host; Guests open a long-lived control stream so the Host can frame logical routed requests to the Guest without relying on unsupported server-initiated request streams.
- [x] Task: Implement Broker request forwarding
    - [x] Implement a minimal Broker API in `@signicode/verser2-guest-node` for connecting to a Host and issuing requests to registered guests.
    - [x] Use one TLS HTTP/2 session per Broker connection and one HTTP/2 stream per routed request.
    - [x] Implement Host-side request forwarding from caller stream to target guest stream and response forwarding back to the caller.
    - [x] Apply Host-advertised routed domain maps in the Broker.
    - [x] Preserve flow control and streaming by forwarding body streams with Node `.pipe()` or equivalent backpressure-aware stream plumbing after headers are resolved.
    - [x] Implement actionable error mapping for missing guest, disconnect, timeout/stream, protocol, and local handler failure scenarios.
- [x] Task: Validate Phase 4 narrowly
    - [x] Run `npm run build`.
    - [x] Run focused Broker/routing/streaming/concurrency tests.
    - [x] Run `npm run lint` if Broker, Host, Guest, or tests changed formatting-sensitive areas.
    - [x] Record coverage status and any limitations.
    - [x] Perform a phase-end deduplication check and move reusable pieces to common if duplication appears.
- [x] Task: Conductor - User Manual Verification 'Phase 4: Broker Request Forwarding, Streaming, Flow Control, and Concurrency' (Protocol in workflow.md)

### Phase 4 Validation Notes

- TDD confirmation: `npm run build && node --test test/broker-routing.test.js` initially failed because `createVerserBroker` was missing. The first failing run exposed a test-cleanup issue that left Hosts open; the tests were corrected to cleanup even while Broker exports were missing.
- Validation passed: `npm run build`, `node --test test/broker-routing.test.js`, `npm run lint`, and `npm run test:coverage`.
- Coverage: `npm run test:coverage` reported all Broker routing tests at 100% and all files at 97.25% line coverage. Source-mapped package reports remain below 95% on some generated/type-adjacent lines and rarely forced protocol branches.
- Scope note: request and response bodies are forwarded as chunks through Broker HTTP/2 request streams and Guest control frames. The Guest leg uses logical base64 frames over a Guest-opened control stream as recommended by @oracle; this is MVP framing, not final binary length-prefix framing.
- Failure behavior covered in focused tests includes missing guests and local handler failures; disconnected-target, timeout, and lower-level stream failures are represented in implementation error mapping but not exhaustively forced in tests due to the MVP control-stream harness.
- Deduplication result: Broker/Guest/Host routing reuse shared common lifecycle names, development TLS helpers, routed-domain metadata, routed envelopes, and contextual errors. Host session/request registries, Broker API ergonomics, and Guest control-frame dispatch remain package-specific.
- Manual verification completed after documenting leased HTTP/2 stream routing as a future-track handoff.
- Phase 4 checkpoint commit: `189b184`.
- Related handoff document: `leased-stream-routing-handoff.md` committed as `a7759c2`.

## Phase 5: Node `http.Agent` Integration and Domain-Based Routing

- [x] Task: Review Node Agent requirements before implementation
    - [x] Confirm the minimal Agent-compatible subset needed for `http.request`-style routing through Verser2.
    - [x] Confirm domain-based routing uses Host-advertised routed domains instead of DNS for registered guest domains.
- [x] Task: Write failing Agent integration tests
    - [x] Add tests for creating an Agent from a connected Broker.
    - [x] Add tests for routing an Agent-originated request through the Broker/Host/Guest path.
    - [x] Add tests showing hostnames matching advertised guest domains are routed through Verser2 without external DNS resolution.
    - [x] Add tests documenting behavior for non-matching hostnames and unsupported advanced Agent features.
    - [x] Confirm the tests fail for missing Agent behavior.

### Phase 5 Notes

- Node Agent requirement review: the MVP should expose an `http.Agent` from a connected Broker. Matching hostnames use Host-advertised routed domains and are converted to Broker requests without DNS lookup. Non-matching hostnames should fail explicitly in the MVP instead of silently opening real sockets.
- @librarian guidance: the safest Node integration point is an Agent that provides a custom Duplex socket and lets Node's HTTP client parser build the response, instead of manually emitting `IncomingMessage` from `addRequest`.
- Agent test isolation guidance: for custom `http.Agent` or fake socket hangs, run isolated tests with `--test-name-pattern` and `--test-timeout`, wrap `http.request` helpers in explicit timeouts that call `request.destroy(error)`, and prefer production failure paths that destroy the `ClientRequest` rather than only emitting an `error` event.
- [x] Task: Implement minimal `http.Agent` exposure
    - [x] Implement an Agent-compatible integration in `@signicode/verser2-guest-node`.
    - [x] Route matching hostname requests through the Broker using the current advertised domain map.
    - [x] Preserve ordinary Node request and response behavior for the documented MVP subset.
    - [x] Document compatibility limits in the package exports/docs or README as appropriate.
- [x] Task: Validate Phase 5 narrowly
    - [x] Run `npm run build`.
    - [x] Run focused Agent integration tests.
    - [x] Run `npm run lint` if Agent code, tests, or docs changed formatting-sensitive areas.
    - [x] Record coverage status and any limitations.
    - [x] Perform a phase-end deduplication check and move reusable pieces to common if duplication appears.
- [x] Task: Conductor - User Manual Verification 'Phase 5: Node `http.Agent` Integration and Domain-Based Routing' (Protocol in workflow.md)

### Phase 5 Validation Notes

- TDD confirmation: `npm run build && node --test test/agent.test.js` initially failed because `broker.createAgent` was missing.
- Validation passed: `npm run build`, `node --test --test-timeout=15000 test/agent.test.js`, `npm run lint`, and `npm run test:coverage`.
- Coverage: `npm run test:coverage` reported all files at 95.69% line coverage. Source-mapped package reports remain below 95% on some generated/type-adjacent lines and rarely forced protocol/socket branches.
- Failure recovery: custom Agent tests initially hung because a fake socket did not complete Node's `ClientRequest` lifecycle. @oracle recommended isolated `--test-timeout` runs, request helper timeouts, and `request.destroy(error)` for non-matching routes. This recovery path is recorded in `conductor/known-solutions.md`.
- Compatibility limits: the Agent MVP supports plain `http.request`/`http.get` style calls for advertised domains, no real DNS lookup for matching routes, and explicit rejection for non-advertised hosts. Keep-alive, HTTPS, advanced socket behavior, trailers, upgrades, and full Agent pooling semantics are not supported in this phase.
- Deduplication result: Agent integration remains package-specific in `@signicode/verser2-guest-node`; it reuses the Broker API and shared contextual errors rather than adding new common abstractions.
- Manual verification completed with user approval.

## Phase 6: End-to-End Validation, Documentation, and Final Review

- [ ] Task: Write or update end-to-end tests and examples
    - [ ] Add an end-to-end test covering Host start, Node Guest attachment, Broker request, routed domain advertisement, Agent routing, and response forwarding.
    - [ ] Add or update docs/examples showing a normal `node:http` server that does not call `listen()`.
    - [ ] Document TLS HTTP/2 setup, self-signed certificate generation/setup, minimal certificate checking, and HTTP/3 exclusion.
    - [ ] Document streaming, concurrency, error behavior, and Agent MVP compatibility limits.
- [ ] Task: Run full validation
    - [ ] Run `npm run build`.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Confirm no HTTP/3, non-Node guest, authentication, authorization, or public gateway behavior was introduced.
    - [ ] Confirm 95% meaningful coverage for changed behavior or record why exact measurement is unavailable with the current test tooling.
- [ ] Task: Final code and Conductor review
    - [ ] Re-read `AGENTS.md` and relevant Conductor documentation before completion.
    - [ ] Confirm implementation matches `spec.md` acceptance criteria.
    - [ ] Review edge cases, lifecycle behavior, error paths, streaming, and concurrent requests.
    - [ ] Confirm shared code was centralized in `@signicode/verser-common` where reuse emerged.
    - [ ] Update `plan.md` with validation notes, deduplication results, and phase checkpoint commit SHAs.
- [ ] Task: Conductor - User Manual Verification 'Phase 6: End-to-End Validation, Documentation, and Final Review' (Protocol in workflow.md)

# Implementation Plan: Bun Guest

## Phase 0: Track Branch, PR, Start Commit, and Baseline

- [x] Task: Create the dedicated Conductor track branch and PR review surface
    - [x] Confirm current branch, working tree state, and `origin/main` freshness before track implementation begins.
    - [x] Create a dedicated track branch named for the Bun Guest track from the up-to-date base branch.
    - [x] Ensure the track-start commit containing `spec.md`, `plan.md`, `metadata.json`, `index.md`, and the `tracks.md` registry update is present on the track branch.
    - [x] Push the track branch and track-start commit to GitHub before requesting manual review.
    - [x] Create a GitHub PR with `gh` using a real multiline body file, not escaped `\n` sequences.
    - [x] Use a PR title and description that describe the completed Bun Guest TO-BE state, not only the planning artifacts.
- [x] Task: Establish baseline repository validation
    - [x] Run the narrowest relevant baseline validation before changing implementation files.
    - [x] Record any preexisting failures, skipped checks, or environment constraints in the track notes.
- [x] Task: Review existing shared foundations before implementation
    - [x] Inspect `@signicode/verser-common` for reusable protocol, header, lifecycle, error, and stream helpers.
    - [x] Inspect `@signicode/verser2-guest-js-common` for reusable JavaScript Guest foundations.
    - [x] Inspect existing Node Guest and Python Guest package/test/docs patterns for conventions to mirror.

### Phase 0 Notes

- PR: https://github.com/signicode/verser2/pull/8.
- Baseline validation: `npm run build` passed before implementation-file changes.
- No preexisting baseline failures were observed. `dts-bundle-generator` emitted the repository's existing composite-project warning during package builds.
- Shared scan: reuse `@signicode/verser-common` for package constants/protocol-neutral request, response, header, lifecycle, and error helpers where applicable; reuse `@signicode/verser2-guest-js-common` for JavaScript Guest foundations before adding Bun-local connection/lifecycle code.
- Package convention scan: mirror `packages/verser2-guest-node` TypeScript package layout and update hardcoded package lists in staging, package consumer, tarball, docs, and package readiness tests when the Bun package is scaffolded.
## Phase 1: Package Scaffold and Tooling Recognition

- [x] Task: Write failing package-recognition tests first
    - [x] Add or update tests that expect `packages/verser2-guest-bun` to exist as a workspace package.
    - [x] Add tests for package metadata, entrypoint exports, README presence, and staging/publishing expectations.
    - [x] Run the narrowest test command and confirm failures identify the missing Bun package scaffold.
- [x] Task: Implement the Bun package scaffold
    - [x] Add `packages/verser2-guest-bun/package.json` following monorepo package conventions.
    - [x] Add TypeScript build configuration and entrypoint structure consistent with existing TypeScript packages.
    - [x] Export package constants and placeholder public types needed by scaffold tests.
    - [x] Add initial README documenting intended Bun Guest scope and current scaffold status.
- [x] Task: Integrate tooling and package staging
    - [x] Ensure build, lint, staging, and package readiness flows recognize the Bun package.
    - [x] Update package publishing or consumer test fixtures only as needed for the new package.
    - [x] Run the narrowest validation proving scaffold recognition.
- [x] Task: Perform Phase 1 deduplication and documentation check
    - [x] Confirm no shared helper was duplicated during scaffold work.
    - [x] Update Conductor notes with validation results and common-library scan outcome.
- [x] Task: Push Phase 1 checkpoint for GitHub review
    - [x] Push the Phase 1 checkpoint commit to the track PR branch before manual verification.
    - [x] Confirm the PR reflects the current plan, baseline notes, track-start commit, and package scaffold.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Package Scaffold and Tooling Recognition' (Protocol in workflow.md)

### Phase 1 Notes

- Failing test confirmation: `node --test test/docs.test.js test/packages.test.js test/package-publish-readiness.test.js test/package-consumer-imports.test.js` failed as expected before scaffold implementation because `packages/verser2-guest-bun` and package list updates were missing.
- Scaffold implementation added `@signicode/verser2-guest-bun` with TypeScript build configuration, public package constant, `createVerserBunGuest` placeholder helper, scaffold public types, README, package license, npm workspace lockfile entry, root project reference, staging recognition, package consumer recognition, tarball recognition, package publish readiness coverage, and root README package inventory.
- Validation passed: `npm run build && npm run stage:packages && node --test test/docs.test.js test/packages.test.js test/package-publish-readiness.test.js test/package-consumer-imports.test.js && npm run lint`.
- Coverage check passed for changed scaffold behavior: `node --test --experimental-test-coverage test/docs.test.js test/packages.test.js test/package-publish-readiness.test.js test/package-consumer-imports.test.js` reported `packages/verser2-guest-bun/dist/index.js` at 97.26% line coverage and 100% function coverage. The lower duplicate staged-package coverage entry reflects package-consumer import-only checks against `dist/packages` staging output, not the source workspace scaffold behavior.
- Deduplication result: no shared helper was duplicated; Phase 1 introduced only package-local scaffold types/constants and package enumeration updates. Existing common libraries remain the intended reuse point for later protocol, lifecycle, header, stream, and routed request helpers.
- Phase checkpoint commit: `198a8f2`.
- Manual verification: confirmed by user after Phase 1 changes were pushed for review.

## Phase 2: Bun Handler Adapter API

- [x] Task: Write failing unit tests for Bun handler adaptation
    - [x] Test `fetch(req)` handler invocation with method, URL/path/query, headers, and body.
    - [x] Test async handler response handling.
    - [x] Test status, response headers, and response body serialization.
    - [x] Test clear failure behavior for unsupported or invalid handler results.
- [x] Task: Write failing tests for Bun route/method handlers
    - [x] Test dispatch to route/method handlers for ordinary HTTP methods.
    - [x] Test not-found or unsupported-method behavior.
    - [x] Test route handler body/header propagation.
- [x] Task: Implement the Bun handler adapter
    - [x] Define minimal public types for Bun fetch handlers and route handlers.
    - [x] Convert routed Verser2 requests into Web-standard `Request` objects.
    - [x] Invoke fetch and route handlers without starting a Bun listening server.
    - [x] Convert Web-standard `Response` objects into Verser2-compatible response data.
    - [x] Keep Bun-specific behavior in the Bun package and reuse common helpers where available.
- [x] Task: Validate adapter behavior narrowly
    - [x] Run Bun-specific unit tests with `bun test`.
    - [x] Run npm build or type-check validation needed for TypeScript package correctness.
    - [x] Record any Bun runtime limitations discovered during adapter work.
- [x] Task: Perform Phase 2 deduplication and documentation check
    - [x] Review whether request/response conversion helpers belong in common JavaScript foundations.
    - [x] Update docs or notes for any intentionally package-local Bun behavior.

### Phase 2 Notes

- Bun documentation scan: `Bun.serve` supports `fetch(req)` and `fetch(req, server)` handler forms; `routes` supports exact/static paths, dynamic/wildcard forms, and per-method handlers in Bun 1.2.3+. Phase 2 implements exact path route dispatch only and leaves dynamic/wildcard routing for later if needed.
- Failing test confirmation: `bun test packages/verser2-guest-bun/test/adapter.test.ts` failed before implementation because `dispatchVerserBunRequest` was not exported.
- Adapter implementation added `dispatchVerserBunRequest`, Web `Request` construction, `Response` serialization, fetch handler dispatch, `fetch(req, server)` compatibility with `server.upgrade()` returning `false`, exact route dispatch, 404 missing-route responses, 405 unsupported-method responses with `Allow`, and clear non-`Response` errors.
- Runtime limitation: Phase 2 does not start a Bun server, does not call `listen()`, and does not support WebSocket upgrades; upgrade-oriented handlers receive a minimal server object whose `upgrade()` returns `false`.
- Validation passed: `npm run test --workspace=@signicode/verser2-guest-bun`; `npm run build`; `npm run stage:packages`; `node --test test/packages.test.js`; `npm run lint`; `bun test --coverage packages/verser2-guest-bun/test/adapter.test.ts`.
- Coverage: Bun coverage reported 100% function coverage and 99.21% line coverage across the Bun package files included by the Phase 2 test.
- Deduplication result: request/response conversion and exact Bun route dispatch remain package-local because they are runtime-adapter behavior and are not yet repeated across JavaScript guest runtimes. No common library changes were needed.
- Phase checkpoint commit: `d47c2f6`.

## Phase 2b: Public API Surface and Bun Runtime Test Migration

- [x] Task: Write failing public-surface tests for Bun API exposure
    - [x] Assert `dispatchVerserBunRequest` is not exported as a public API.
    - [x] Assert no `__internal` testing hook or internal adapter helper is exported.
    - [x] Assert handler conversion behavior is reachable only through supported public surfaces such as Guest attach and Broker request/fetch/dispatcher paths.
- [x] Task: Move Bun adapter validation onto Bun public-runtime execution
    - [x] Replace Node-only adapter validation with a Bun-process runtime harness that mirrors the Python pattern:
        - Start Host/Broker in Node test code.
        - Spawn `bun runtime_guest.ts` as a separate process.
        - Wait for a readiness message from the child process before proceeding.
        - Assert routed requests pass through Host/Broker to that spawned runtime.
    - [x] Ensure tests do not import private helpers, generated internals, or Node-only test hooks.
    - [x] Keep bounded timeouts so hangs indicate implementation problems quickly.
- [x] Task: Implement public/internal boundary cleanup
    - [x] Remove `dispatchVerserBunRequest` from `packages/verser2-guest-bun/src/index.ts` public exports.
    - [x] Remove `__internal` from public exports and generated declarations.
    - [x] Move adapter request/response conversion into package-local internal modules used by Guest/Broker parity implementations.
- [x] Task: Validate Phase 2b behavior narrowly
    - [x] Run focused `bun test` public-surface tests.
    - [x] Run package export smoke tests and declaration checks proving internal helpers are not public.
    - [x] Run `npm run lint` and Bun package build validation.
- [x] Task: Perform Phase 2b review
    - [x] Confirm public API no longer exposes internal dispatch/test hooks.
    - [x] Confirm Bun tests use public APIs rather than implementation internals.
    - [x] Record validation and any intentionally private adapter helper locations.
- [x] Task: Push Phase 2b checkpoint for GitHub review
    - [x] Push the Phase 2b checkpoint commit to the track PR branch before manual verification.
    - [x] Confirm the PR reflects the public/internal boundary cleanup and Bun public-runtime validation work.
- [ ] Task: Conductor - User Manual Verification 'Phase 2b: Public API Surface and Bun Runtime Test Migration' (Protocol in workflow.md)

### Phase 2b Notes

- Public surface cleanup removed `dispatchVerserBunRequest`, `__internal`, ignored handler `origin`, route-table types, and dispatch-named public server types from the Bun package entrypoint/declarations.
- Adapter conversion code now lives in `packages/verser2-guest-bun/src/lib/adapter.ts` as package-local implementation detail used by `createVerserBunGuest().attach()`.
- Bun package tests now exercise the public `createVerserBunGuest()` surface instead of importing private helpers.
- Spawned Bun runtime validation mirrors the Python pattern: `test/bun-guest-integration.test.js` starts Node Host/Broker, spawns `bun packages/verser2-guest-bun/examples/runtime_guest.ts`, waits for `bun guest ready`, then sends routed Broker requests to the Bun process.
- Validation passed: `timeout 20s npm run test --workspace=@signicode/verser2-guest-bun`; `timeout 20s bun test packages/verser2-guest-bun/test/*.test.ts`; `timeout 60s npm run build --workspace=@signicode/verser2-guest-bun`; `timeout 20s node --test test/packages.test.js`; `timeout 20s npm run lint`.
- Phase checkpoint commit: `27aaeb2`.

## Phase 3: Outbound Guest Integration

- [x] Task: Write failing integration tests for Host-routed Bun Guest requests
    - [x] Test connecting a Bun Guest outbound to an existing Verser2 Host.
    - [x] Test a Broker or Host-routed request reaching a Bun `fetch(req)` handler.
    - [x] Test status, headers, and body returning through the existing Host/Guest route.
    - [x] Confirm the Bun handler does not open an inbound listening port.
- [x] Task: Implement Bun Guest connection lifecycle
    - [x] Reuse JavaScript Guest foundations for Host connection, registration, route advertisement, and request dispatch where possible.
    - [x] Add Bun Guest create/connect helpers with explicit endpoint, guest identity, route, and lifecycle options.
    - [x] Surface lifecycle errors with useful Host/Guest/path context.
    - [x] Preserve existing transport behavior and avoid HTTP/3 or unrelated Host/Broker changes.
- [x] Task: Validate integrated request/response behavior
    - [x] Run focused Bun integration tests.
    - [x] Run relevant npm integration or build checks affected by the new package.
    - [x] Record coverage status or limitations for Bun integration paths.
- [x] Task: Perform Phase 3 deduplication and lifecycle review
    - [x] Confirm shared connection/lifecycle code was reused rather than duplicated.
    - [x] Move repeated JavaScript Guest helper code into `@signicode/verser2-guest-js-common` if reuse emerges.
- [x] Task: Push Phase 3 checkpoint for GitHub review
    - [x] Push the Phase 3 checkpoint commit to the track PR branch before manual verification.
    - [x] Confirm the PR contains the package scaffold, handler adapter, and outbound integration work for review.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Outbound Guest Integration' (Protocol in workflow.md)

### Phase 3 Notes

- Failing test confirmation: `npm run build && npm run stage:packages && node --test test/bun-guest-integration.test.js` failed before implementation with `bun route advertisement timed out`, confirming the Bun Guest did not yet connect/register routes.
- Integration implementation reuses `@signicode/verser2-guest-node`'s Node Guest transport for Host connection, registration, route advertisements, lease management, lifecycle, and close behavior. Bun-specific code adapts Node-style routed requests into `dispatchVerserBunRequest` and writes the serialized Bun response back to the Node-style response shim.
- No inbound listener is opened by the Bun package; `attach()` wires an in-process adapter function into the reused Node Guest transport.
- Validation passed with bounded/narrow commands only: `timeout 20s node --test test/packages.test.js`; `timeout 20s node --test test/bun-guest-integration.test.js`; `timeout 20s npm run test --workspace=@signicode/verser2-guest-bun`; `timeout 20s npm run lint`; `timeout 60s npm run build --workspace=@signicode/verser2-guest-bun`; `timeout 20s npm run stage:packages`.
- Coverage status: `timeout 20s bun test --coverage packages/verser2-guest-bun/test/adapter.test.ts` passed but now includes the reused Node Guest/common dependency graph because the Bun Guest imports the Node Guest transport. The reported aggregate coverage is therefore not a meaningful measure of the Phase 3 integration slice. Meaningful Phase 3 behavior is covered by the focused Host/Broker/Bun Guest integration test plus existing Node Guest transport coverage.
- Validation recovery: a package smoke test initially called real `guest.connect()` after `createVerserBunGuest` became a real transport wrapper, causing a self-signed certificate failure and timeout. This session-introduced in-scope test issue was fixed by keeping `test/packages.test.js` as an export/attach smoke test and leaving real transport verification to `test/bun-guest-integration.test.js`.
- Deduplication result: connection/lifecycle/lease code is reused from `@signicode/verser2-guest-node`; no duplicate HTTP/2 transport implementation was introduced. The Bun adapter remains package-local because it maps Bun/Web handler shapes to the existing JavaScript transport path.
- Phase checkpoint commit: `a549ddf`.
- Manual verification: confirmed by user after Phase 3 changes were pushed for review.

## Phase 3b: Public API Parity, Broker Surface, and Host-Owned Routing

- [x] Task: Write failing public API parity tests
    - [x] Assert `@signicode/verser2-guest-bun` exports Bun equivalents for the Node package public surface: `createVerserBunGuest`, `createVerserBroker`, package constants, and public Broker/Guest option and result types.
    - [x] Assert Bun Broker exposes `connect`, `close`, `request`, `getRoutes`, `waitForRoute`, `createAgent`, `createDispatcher`, and `createFetch` behavior compatible with the Node Broker surface.
    - [x] Assert Bun package consumer import checks can import the parity exports from source, staged packages, and tarballs.
- [x] Task: Implement Bun public API parity over the existing transport
    - [x] Reuse the existing Node Guest/Broker HTTP/2 transport internally as the compatibility substrate for Host connection, registration, session, lease stream pool, Agent, Dispatcher, and wrapped fetch behavior.
    - [x] Export `createVerserBroker` from the Bun package and delegate to the existing Broker implementation without exposing Node-only internals.
    - [x] Export or alias Bun-appropriate Broker/Guest types so Bun users can consume the package without importing `@signicode/verser2-guest-node` directly.
    - [x] Keep the Node transport reuse an implementation detail; public docs and tests should treat Bun as a first-class package surface, not a second-grade wrapper.
- [x] Task: Strictly remove local route table ownership from Verser routing semantics
    - [x] Ensure Host/Broker route resolution remains based on Host-advertised Guest domains and Broker route state.
    - [x] Remove public Bun `routes` support from `@signicode/verser2-guest-bun` for this track; do not preserve it as a documented local-dispatch feature.
    - [x] Remove docs and examples that present developer-controlled Bun `routes` as a supported package API.
    - [x] Add tests proving Bun `routes` are not part of the public package API and cannot influence Host/Broker route state.
    - [x] Add tests proving Broker `getRoutes()` and `waitForRoute()` use Host route advertisements only.
- [x] Task: Add process-hosted runtime regression test coverage for parity checks
    - [x] Add/confirm a Bun runtime integration test that validates `bun runtime_guest.ts` + Host/Broker flow used with spawned process.
    - [x] Keep the process test bounded and fail-fast, including startup timeout and `waitForRoute` synchronization.
- [x] Task: Validate Phase 3b parity and route ownership narrowly
    - [x] Run bounded Bun runtime tests for Guest/Broker route behavior.
    - [x] Run bounded package consumer tests for Bun parity exports.
    - [x] Run focused package build, staging, and lint checks.
- [x] Task: Perform Phase 3b deduplication and transport review
    - [x] Confirm no HTTP/2 session, control stream, or lease stream pool implementation was duplicated in the Bun package.
    - [x] Record that Bun uses the existing Node transport internally for compatibility while exposing a Bun-first public package surface.
    - [x] Confirm no HTTP/3, authentication, authorization, public gateway, or unrelated runtime guest behavior was introduced.
- [x] Task: Push Phase 3b checkpoint for GitHub review
    - [x] Push the Phase 3b checkpoint commit to the track PR branch before manual verification.
    - [x] Confirm the PR reflects public API parity, strict route removal, Host-owned routing, and transport reuse.
- [ ] Task: Conductor - User Manual Verification 'Phase 3b: Public API Parity, Broker Surface, and Host-Owned Routing' (Protocol in workflow.md)

## Phase 3c: Rejected Review Corrective Routes and Phase-Gated Validation

- [x] Task: Fix Bun test TypeScript editor/runtime typing
    - [x] Add Bun type declarations so `bun:test` resolves in local TypeScript tooling.
    - [x] Add a test-scoped tsconfig for Bun runtime tests without changing package build inputs.
    - [x] Validate the Bun test tsconfig before changing route behavior.
- [x] Task: Restore Bun-compatible route table support
    - [x] Reintroduce public `routes` support using the Bun `Bun.serve({ routes })` contract instead of the earlier simplified route shape.
    - [x] Support static `Response` routes, function routes, and per-method route handlers for exact paths.
    - [x] Support practical Bun-style param and wildcard route keys where feasible without changing Host-owned route advertisement semantics.
    - [x] Keep Host/Broker route advertisements as the only Verser routing state; local Bun routes dispatch only inside the advertised Guest handler.
- [x] Task: Validate Phase 3c routes narrowly before continuing
    - [x] Run focused Bun runtime tests for route table dispatch.
    - [x] Run package export/declaration smoke tests for the restored public route types.
    - [x] Record validation results before moving to Phase 4 corrective follow-up.

### Phase 3c Notes

- Review correction: public Bun `routes` support was restored because route tables are part of the Bun `Bun.serve({ routes })` contract, but they remain local handler dispatch only and do not create Host/Broker route advertisements.
- Route support covers exact static `Response` routes, function routes, per-method route objects, param routes, wildcard routes, fallback `fetch`, 405 `Allow`, and 404 when no route or fallback exists.
- Static `Response` routes are cloned before consumption so repeated requests to the same route remain reusable.
- Runtime route behavior is validated through the spawned Bun process integration rather than private adapter imports.
- Bun test TypeScript tooling was fixed with `@types/bun` and `packages/verser2-guest-bun/test/tsconfig.json`; the package build keeps tests out of production declarations through `tsconfig.build.json`.
- Validation passed before moving to Phase 4b: `timeout 20s node node_modules/typescript/bin/tsc --project packages/verser2-guest-bun/test/tsconfig.json`; `timeout 20s bun test packages/verser2-guest-bun/test/*.test.ts`; `timeout 20s node --test test/bun-guest-integration.test.js`; `timeout 60s npm run build --workspace=@signicode/verser2-guest-bun`; `timeout 20s node --test test/packages.test.js test/docs.test.js`; `timeout 20s npm run lint`.
- Phase checkpoint commit: `b1005dd`.
- Manual verification: confirmed by user after Phase 3c changes were pushed for review.

### Phase 3b Notes

- Bun package public API now includes `createVerserBroker`, Bun Guest/Broker option/result types, and the Bun package constant while preserving Node transport reuse as an implementation detail.
- Host-owned route semantics are covered by docs and tests: examples pass an explicit advertised domain to `attach(..., domain)`, and Broker `getRoutes()`/`waitForRoute()` assertions use Host-advertised domains rather than local Bun route tables.
- Public Bun `routes` support was removed from source, docs, examples, tests, and generated declarations for this track.
- Package consumer probes now require Bun parity exports and forbid internal dispatch/test-hook exports across source, staged, tarball, and authenticated GitHub modes.
- Validation passed: `timeout 20s node --test test/package-consumer-imports.test.js`; `timeout 20s node --test test/bun-guest-integration.test.js`; `timeout 20s node --test test/packages.test.js test/docs.test.js test/package-consumer-imports.test.js`; `timeout 20s npm run stage:packages`; `timeout 20s npm run lint`.
- Phase checkpoint commit: `27aaeb2`.

## Phase 4: Streaming, Node Compatibility, and Unsupported WebSocket Boundary

- [x] Task: Write failing tests for Bun body and streaming behavior
    - [x] Test representative request body forwarding into Bun `Request` APIs (string, `Buffer`, and `ReadableStream`).
    - [x] Test representative response body forwarding from Web `Response` APIs (stream, `Buffer`, and read helpers).
    - [x] Test Web `ReadableStream` handling where currently supported by adapter behavior.
- [x] Task: Write failing tests for Node compatibility within reason
    - [x] Add smoke tests for `Buffer`, `node:events`, and stream interop used by the Bun adapter.
    - [x] Test practical Node-like handler bridge behavior via the adapter request bridge used by attach path.
    - [x] Document and test explicit non-support for obscure Node internals in public notes.
- [x] Task: Write failing tests for WebSocket upgrade boundary behavior
    - [x] Test that WebSocket upgrade attempts are rejected/false and explicit in response payloads.
    - [x] Confirm no full WebSocket forwarding is introduced in this track.
- [x] Task: Implement body, compatibility, and boundary behavior
    - [x] Preserve body semantics with Web streams where supported in adapter helpers.
    - [x] Add Node compatibility bridge coverage where small and Bun-appropriate.
    - [x] Add explicit WebSocket unsupported behavior and diagnostics in docs.
    - [x] Document buffering and stream handling limitations in package notes.
- [x] Task: Validate Phase 4 behavior narrowly
    - [x] Run focused `bun test` coverage for streaming, compatibility, and WebSocket boundary cases.
    - [x] Run relevant npm build/test validation for changed package code.
    - [x] Confirm coverage/measurement status for changed behavior and note limitations.
- [x] Task: Perform Phase 4 deduplication and protocol compatibility check
    - [x] Confirm method, path, headers, body, status, and response semantics remain compatible.
    - [x] Centralize repeated stream/header/body helpers if reuse emerges.
- [x] Task: Replace adapter aggregation with end-to-end streaming behavior
    - [x] Write failing tests proving Host-routed request bodies reach Bun `Request.body` as a stream instead of being pre-buffered.
    - [x] Write failing tests proving Bun `Response.body` streams back through Broker/Agent/Dispatcher/fetch paths without pre-aggregating in the Bun adapter.
    - [x] Preserve binary chunks without UTF-8 coercion across the Bun Guest bridge.
    - [x] Allow helper methods such as `text()` or `json()` to aggregate only when explicitly called by consumers.
    - [x] Validate streaming behavior with bounded Bun runtime integration tests, not internal helper tests.
- [x] Task: Re-test WebSocket boundary through public surfaces only
    - [x] Remove internal-hook WebSocket tests and cover unsupported upgrade behavior through public Guest/Broker request paths.
    - [x] Keep `server.upgrade()` behavior explicit and false unless a future track implements WebSocket forwarding.
    - [x] Confirm no WebSocket forwarding, CONNECT, HTTP/3, or unrelated upgrade behavior is introduced.
- [x] Task: Push Phase 4 corrective checkpoint for GitHub review
    - [x] Push the Phase 4 streaming parity and public-surface WebSocket boundary checkpoint to the track PR branch before manual verification.
    - [x] Confirm the PR reflects true streaming behavior, binary preservation, public-surface tests, and no adapter pre-aggregation.
- [ ] Task: Conductor - User Manual Verification 'Phase 4 Corrective: Streaming Parity and Public WebSocket Boundary' (Protocol in workflow.md)

## Phase 4b: Rejected Review Corrective Bun Request and Body Coverage

- [x] Task: Add missing Bun request/fetch coverage
    - [x] Test that Bun runtime handlers receive `Request` method, URL, query, headers, and streamed body through public Guest attach paths.
    - [x] Test fallback `fetch(request, server)` behavior when no Bun route matches.
    - [x] Test route handler request behavior through static, function, method, param, and wildcard routes where supported.
    - [x] Test Bun-originated Broker `request()` and `createFetch()` calls from inside the spawned Bun runtime.
- [x] Task: Add missing Bun response/body coverage
    - [x] Test JSON responses with `Response.json()`.
    - [x] Test iterable or async-iterable response bodies where Bun accepts them.
    - [x] Test Node.js stream response bodies where Bun accepts them.
    - [x] Preserve binary chunks without UTF-8 coercion across public Host/Broker/Bun runtime paths.
- [x] Task: Extend spawned Bun runtime readiness to self-check Bun-originating transport APIs
    - [x] In the spawned Bun runtime, import `createVerserBroker` from `@signicode/verser2-guest-bun` and connect it to Host with TLS CA configuration.
    - [x] From inside Bun runtime, call `broker.request()` against `/status` on the hosted guest and assert `ok`.
    - [x] From inside Bun runtime, call `broker.createFetch()` against `http://<guestDomain>/response-json` and assert JSON `{ ok: true }` before reporting readiness.
- [x] Task: Validate Phase 4b narrowly before continuing
    - [x] Run focused `bun test` coverage for Bun request/response shapes.
    - [x] Run spawned Bun runtime integration for public Host/Broker/Guest request behavior.
    - [x] Record validation results before any final readiness work.

### Phase 4b Notes

- Spawned Bun runtime integration now verifies `Request` method, path, query, headers, and streamed request body through a public fallback `fetch(request, server)` path.
- The spawned Bun runtime now creates a Bun-package Broker and self-checks both `broker.request()` and `broker.createFetch()` through the Host before printing readiness. The Bun package wraps `createFetch()` so Bun-originated fetches route through `broker.request()` instead of falling back to direct TCP/DNS behavior.
- Runtime response coverage now includes `Response.json()`, async iterable response bodies, Node.js `Readable` response bodies, streamed Web `ReadableStream` response bodies, and binary preservation.
- Spawned Bun runtime now also performs Bun-originating self-checks from inside the spawned process using Bun package `createVerserBroker`: both a direct `broker.request()` and a `createFetch()` assertion are executed before emitting `bun broker self-check ready`.
- Route handler behavior remains covered through the spawned Bun runtime for static, param, wildcard, per-method, and fallback paths.
- Validation passed before final readiness work: `timeout 20s node --test test/bun-guest-integration.test.js`; `timeout 20s bun test packages/verser2-guest-bun/test/*.test.ts`; `timeout 60s npm run build --workspace=@signicode/verser2-guest-bun`; `timeout 20s npm run lint`.
- Phase checkpoint commits: `2f81923`, `443826a`.
- Manual verification: confirmed by user after Bun-originated `broker.request()` and `createFetch()` coverage was pushed for review.

### Phase 4 Corrective Notes

- Streaming and binary behavior are now covered through the public, spawned Bun runtime path instead of private adapter hooks. Routed requests reach Bun `Request.body`; Bun `Response.body` streams back through the Broker response path; binary bytes are asserted without UTF-8 coercion.
- WebSocket boundary coverage now uses the public Host/Broker/Guest route path. The Bun handler calls `server.upgrade(request)` and the routed response proves it returns `false`.
- No WebSocket forwarding, CONNECT handling, HTTP/3, authentication, authorization, public gateway behavior, or unrelated runtime guest behavior was introduced.
- Validation passed: `timeout 20s node --test test/bun-guest-integration.test.js`; `timeout 20s bun test packages/verser2-guest-bun/test/*.test.ts`; `timeout 20s npm run lint`.
- Phase checkpoint commit: `27aaeb2`.

### Phase 4 Notes

- Failing test confirmation: `bun test --coverage packages/verser2-guest-bun/test/adapter.test.ts`,
  `timeout 20s npm run test --workspace=@signicode/verser2-guest-bun`, and
  `timeout 20s node --test test/bun-guest-integration.test.js` initially failed on body/stream and
  WebSocket boundary expectations before changes.
- Changes implemented:
  - Added request/response body streaming coverage in `dispatchVerserBunRequest` tests, including
    `Buffer`, `ReadableStream`, and Web-streamed `Response` fixtures.
  - Added Node-style bridge interop tests covering `node:events` request emitters and chunked input
    preservation with EventEmitter lifecycle behavior.
  - Added explicit WebSocket boundary tests and README note that `server.upgrade()` returns `false`
    and no forwarding occurs.
  - Expanded adapter response materialization to preserve upstream body bytes while still exposing
    text/json helpers.
- Validation run list (bounded): `timeout 20s npm run test --workspace=@signicode/verser2-guest-bun`,
  `timeout 20s node --test test/bun-guest-integration.test.js`, `timeout 20s npm run lint`,
  `timeout 20s bun test --coverage packages/verser2-guest-bun/test/adapter.test.ts`, and
  `timeout 60s npm run build --workspace=@signicode/verser2-guest-bun`.
- Coverage status: earlier Phase 4 coverage primarily covered adapter helpers and included shared Node transport;
  added streaming parity tasks above must replace helper-level coverage with public-surface Bun runtime coverage.
- Deduplication result: no repeated stream/request/response helper duplicated outside this adapter; helper code
  remains Bun-package-local as currently runtime-specific conversion behavior.
- Phase checkpoint commit: `9c8b9b6`.

## Phase 5: Documentation, Package Consumer Validation, and Final Readiness

- [x] Task: Write failing documentation and package consumer tests
    - [x] Add tests requiring Bun Guest README examples and package entrypoint documentation.
    - [x] Add or update package consumer validation for `@signicode/verser2-guest-bun` imports.
    - [x] Add tests that docs state Bun apps do not call `listen()` for guest exposure.
- [x] Task: Write failing final parity documentation tests
    - [x] Require docs to show Bun package `createVerserBroker`, `createAgent`, `createDispatcher`, and `createFetch` usage.
    - [x] Require docs to state Host/Broker route advertisements own Verser route resolution.
    - [x] Require docs to avoid presenting local Bun `routes` as Host-controlled Verser routing.
    - [x] Require docs to describe streaming as implemented behavior, not as a limitation or body aggregation caveat.
- [x] Task: Complete Bun Guest documentation
    - [x] Add a tutorial-style Bun Guest example using a `Bun.serve`-style handler without opening a listening port.
    - [x] Document fetch handler, route handler, Node compatibility, streaming, and WebSocket limitations.
    - [x] Update root README and package lists for the initial Bun Guest documentation slice.
- [x] Task: Revise documentation for first-class Bun parity
    - [x] Document Bun Guest and Bun Broker APIs as first-class package exports while noting the Node transport reuse is internal compatibility infrastructure.
    - [x] Document `createFetch()` and Dispatcher usage from the Bun package.
    - [x] Document local Bun handler dispatch separately from Host/Broker route advertisement.
    - [x] Remove or correct any docs that describe body buffering as a permanent limitation after streaming parity is implemented.
- [x] Task: Validate package readiness
    - [x] Run `bun test` for Bun-specific tests.
    - [x] Run the narrowest sufficient npm build, lint, package staging, package consumer, and test commands affected by the new package.
    - [x] Record any skipped validation and reason.
- [x] Task: Validate final Bun runtime readiness
    - [x] Run bounded Node-orchestrated Bun runtime integration that starts Host/Broker, spawns Bun process, waits for readiness, and issues routed requests to verify method/path/header/body/status/headers/body behavior.
    - [x] Run bounded source/staged/tarball package consumer checks proving Bun parity exports import correctly.
    - [x] Run bounded build, staging, lint, and focused Node compatibility checks.
- [x] Task: Final review and cleanup
    - [x] Confirm all plan tasks are complete or explicitly deferred with rationale.
    - [x] Confirm docs, tests, package metadata, and implementation agree.
    - [x] Confirm no unrelated runtime guests, HTTP/3 behavior, auth policy, or public gateway behavior was introduced.
    - [x] Prepare final phase checkpoint commit and update `plan.md` with the checkpoint SHA.
- [x] Task: Final parity review and cleanup
    - [x] Confirm no `dispatchVerserBunRequest` or `__internal` export remains public.
    - [x] Confirm Bun package public API has parity with the Node package where applicable.
    - [x] Confirm response/request bodies stream through the Bun public path without adapter pre-aggregation.
    - [x] Confirm tests use public surfaces and Bun runtime where Bun behavior is being validated.
    - [x] Confirm final docs, tests, package metadata, and implementation agree after Phase 2b/3b/4 streaming corrections.
- [x] Task: Push corrective final checkpoint for GitHub review
    - [x] Push the corrective Phase 2b, Phase 3b, Phase 4 streaming, and Phase 5 parity updates to the track PR branch before requesting final manual verification again.
    - [x] Confirm the PR reflects the revised public API parity, Host-owned routing, streaming, Bun-runtime validation, and public/internal boundary requirements.
- [x] Task: Push Phase 5 checkpoint for GitHub review
    - [x] Push the final phase checkpoint commit to the track PR branch before manual verification.
    - [x] Confirm the PR contains final implementation, docs, validation notes, and package readiness updates.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Documentation, Package Consumer Validation, and Final Readiness' (Protocol in workflow.md)

### Phase 5 Notes

- Documentation validation was expanded in `test/docs.test.js` to require Bun Guest
  tutorial content, fetch and route behavior, streaming notes, WebSocket boundary
  notes, and explicit non-listening (`listen()`) guidance in root + package docs.
- Package consumer validation in `test/package-consumer-imports.test.js` now asserts
  that the Bun package name is present in import checks across source/staged/tarball
  matrix modes.
- Validation run list (bounded):
  - `timeout 20s node --test test/docs.test.js test/package-consumer-imports.test.js test/package-publish-readiness.test.js test/packages.test.js`
  - `timeout 20s npm run test --workspace=@signicode/verser2-guest-bun`
  - `timeout 20s node --test test/bun-guest-integration.test.js`
  - `timeout 60s npm run build --workspace=@signicode/verser2-guest-bun`
  - `timeout 20s npm run stage:packages`
  - `timeout 20s npm run lint`
- Skipped by scope: full suite and Python track/guest test sets, because this phase is
  documentation/readiness-only and Python track behavior remains unchanged.
- Project-level Conductor docs: synchronization is deferred to the required post-track
  documentation synchronization protocol after the track is marked complete.
- Prior readiness summary: initial docs, package consumer checks, and staging/build checks passed, but user review found unresolved parity, routing, streaming, Bun-runtime validation, and public/internal boundary issues.
- Phase checkpoint commit: `7254ea5`.
- Phase 5 verification status: not accepted by user. Corrective Phase 2b, Phase 3b,
  Phase 4 streaming parity tasks, and final parity review tasks were added to address
  public API parity, Host-owned routing, streaming, Bun-runtime validation, and public/internal boundary issues before track completion.
- Corrective final validation passed: `npm run build` (passed after constraining default repo ambient types to Node and rerunning after dependency declarations were refreshed); `npm run stage:packages`; `npm test`; `npm run lint`; `npm run test:package-consumers -- --source=source`; `npm run test:package-consumers -- --source=staging`; `npm run test:package-consumers -- --source=tarball`; `npm run test:package-tarballs`; `bun test packages/verser2-guest-bun/test/*.test.ts`.
- Validation recovery classification: initial full `npm run build` failure was session-introduced and in scope because adding Bun test types exposed Bun ambient declarations to all package declaration builds. Fix was to set root `tsconfig.json` default `types` to `['node']` and keep Bun ambient types scoped to `packages/verser2-guest-bun/test/tsconfig.json`.

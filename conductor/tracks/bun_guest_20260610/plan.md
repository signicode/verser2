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
- Coverage status: meaningful Bun adapter coverage remains in `adapter.test.ts`; full package coverage command
  includes shared Node transport and is useful for drift checks but not an exact phase-local measure because
  of helper-package reuse.
- Deduplication result: no repeated stream/request/response helper duplicated outside this adapter; helper code
  remains Bun-package-local as currently runtime-specific conversion behavior.
- Phase checkpoint commit: `9c8b9b6`.

## Phase 5: Documentation, Package Consumer Validation, and Final Readiness

- [x] Task: Write failing documentation and package consumer tests
    - [x] Add tests requiring Bun Guest README examples and package entrypoint documentation.
    - [x] Add or update package consumer validation for `@signicode/verser2-guest-bun` imports.
    - [x] Add tests that docs state Bun apps do not call `listen()` for guest exposure.
- [x] Task: Complete Bun Guest documentation
    - [x] Add a tutorial-style Bun Guest example using a `Bun.serve`-style handler without opening a listening port.
    - [x] Document fetch handler, route handler, Node compatibility, streaming, and WebSocket limitations.
    - [x] Update root README, package lists, and conductor docs to move Bun from roadmap to implemented where appropriate.
- [x] Task: Validate package readiness
    - [x] Run `bun test` for Bun-specific tests.
    - [x] Run the narrowest sufficient npm build, lint, package staging, package consumer, and test commands affected by the new package.
    - [x] Record any skipped validation and reason.
- [x] Task: Final review and cleanup
    - [x] Confirm all plan tasks are complete or explicitly deferred with rationale.
    - [x] Confirm docs, tests, package metadata, and implementation agree.
    - [x] Confirm no unrelated runtime guests, HTTP/3 behavior, auth policy, or public gateway behavior was introduced.
    - [x] Prepare final phase checkpoint commit and update `plan.md` with the checkpoint SHA.
- [ ] Task: Push Phase 5 checkpoint for GitHub review
    - [ ] Push the final phase checkpoint commit to the track PR branch before manual verification.
    - [ ] Confirm the PR contains final implementation, docs, validation notes, and package readiness updates.
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
- Readiness summary: docs, package consumer checks, and staging/build readiness agree
  with implementation; no unrelated runtime guest, HTTP/3, auth policy, or public
  gateway changes were introduced in this phase.

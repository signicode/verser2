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

- [ ] Task: Write failing unit tests for Bun handler adaptation
    - [ ] Test `fetch(req)` handler invocation with method, URL/path/query, headers, and body.
    - [ ] Test async handler response handling.
    - [ ] Test status, response headers, and response body serialization.
    - [ ] Test clear failure behavior for unsupported or invalid handler results.
- [ ] Task: Write failing tests for Bun route/method handlers
    - [ ] Test dispatch to route/method handlers for ordinary HTTP methods.
    - [ ] Test not-found or unsupported-method behavior.
    - [ ] Test route handler body/header propagation.
- [ ] Task: Implement the Bun handler adapter
    - [ ] Define minimal public types for Bun fetch handlers and route handlers.
    - [ ] Convert routed Verser2 requests into Web-standard `Request` objects.
    - [ ] Invoke fetch and route handlers without starting a Bun listening server.
    - [ ] Convert Web-standard `Response` objects into Verser2-compatible response data.
    - [ ] Keep Bun-specific behavior in the Bun package and reuse common helpers where available.
- [ ] Task: Validate adapter behavior narrowly
    - [ ] Run Bun-specific unit tests with `bun test`.
    - [ ] Run npm build or type-check validation needed for TypeScript package correctness.
    - [ ] Record any Bun runtime limitations discovered during adapter work.
- [ ] Task: Perform Phase 2 deduplication and documentation check
    - [ ] Review whether request/response conversion helpers belong in common JavaScript foundations.
    - [ ] Update docs or notes for any intentionally package-local Bun behavior.

## Phase 3: Outbound Guest Integration

- [ ] Task: Write failing integration tests for Host-routed Bun Guest requests
    - [ ] Test connecting a Bun Guest outbound to an existing Verser2 Host.
    - [ ] Test a Broker or Host-routed request reaching a Bun `fetch(req)` handler.
    - [ ] Test status, headers, and body returning through the existing Host/Guest route.
    - [ ] Confirm the Bun handler does not open an inbound listening port.
- [ ] Task: Implement Bun Guest connection lifecycle
    - [ ] Reuse JavaScript Guest foundations for Host connection, registration, route advertisement, and request dispatch where possible.
    - [ ] Add Bun Guest create/connect helpers with explicit endpoint, guest identity, route, and lifecycle options.
    - [ ] Surface lifecycle errors with useful Host/Guest/path context.
    - [ ] Preserve existing transport behavior and avoid HTTP/3 or unrelated Host/Broker changes.
- [ ] Task: Validate integrated request/response behavior
    - [ ] Run focused Bun integration tests.
    - [ ] Run relevant npm integration or build checks affected by the new package.
    - [ ] Record coverage status or limitations for Bun integration paths.
- [ ] Task: Perform Phase 3 deduplication and lifecycle review
    - [ ] Confirm shared connection/lifecycle code was reused rather than duplicated.
    - [ ] Move repeated JavaScript Guest helper code into `@signicode/verser2-guest-js-common` if reuse emerges.
- [ ] Task: Push Phase 3 checkpoint for GitHub review
    - [ ] Push the Phase 3 checkpoint commit to the track PR branch before manual verification.
    - [ ] Confirm the PR contains the package scaffold, handler adapter, and outbound integration work for review.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Outbound Guest Integration' (Protocol in workflow.md)

## Phase 4: Streaming, Node Compatibility, and Unsupported WebSocket Boundary

- [ ] Task: Write failing tests for Bun body and streaming behavior
    - [ ] Test representative request body forwarding into Bun `Request` APIs.
    - [ ] Test representative response body forwarding from Web `Response` APIs.
    - [ ] Test Web `ReadableStream` handling where supported by current transport behavior.
- [ ] Task: Write failing tests for Node compatibility within reason
    - [ ] Add smoke tests for `Buffer`, `node:events`, and stream interop used by the Bun adapter.
    - [ ] Test practical Node-like handler bridge behavior if implemented by the public API.
    - [ ] Document and test explicit non-support for obscure Node internals.
- [ ] Task: Write failing tests for WebSocket upgrade boundary behavior
    - [ ] Test that WebSocket upgrade attempts are rejected, ignored, or surfaced with a clear documented error according to the chosen API behavior.
    - [ ] Confirm no full WebSocket forwarding is introduced in this track.
- [ ] Task: Implement body, compatibility, and boundary behavior
    - [ ] Preserve body semantics with Web streams where possible.
    - [ ] Add Node compatibility bridge code only where it stays small and Bun-appropriate.
    - [ ] Add explicit WebSocket unsupported behavior and diagnostics.
    - [ ] Document any buffering or runtime limitation discovered during implementation.
- [ ] Task: Validate Phase 4 behavior narrowly
    - [ ] Run focused `bun test` coverage for streaming, compatibility, and WebSocket boundary cases.
    - [ ] Run relevant npm build/test validation for changed shared or package code.
    - [ ] Confirm 95% meaningful coverage for changed behavior or record measurement limitations.
- [ ] Task: Perform Phase 4 deduplication and protocol compatibility check
    - [ ] Confirm method, path, headers, body, status, and response semantics remain compatible.
    - [ ] Centralize repeated stream/header/body helpers if reuse emerges.

## Phase 5: Documentation, Package Consumer Validation, and Final Readiness

- [ ] Task: Write failing documentation and package consumer tests
    - [ ] Add tests requiring Bun Guest README examples and package entrypoint documentation.
    - [ ] Add or update package consumer validation for `@signicode/verser2-guest-bun` imports.
    - [ ] Add tests that docs state Bun apps do not call `listen()` for guest exposure.
- [ ] Task: Complete Bun Guest documentation
    - [ ] Add a tutorial-style Bun Guest example using a `Bun.serve`-style handler without opening a listening port.
    - [ ] Document fetch handler, route handler, Node compatibility, streaming, and WebSocket limitations.
    - [ ] Update root README, package lists, or tech-stack documentation to move Bun from roadmap to implemented where appropriate.
- [ ] Task: Validate package readiness
    - [ ] Run `bun test` for Bun-specific tests.
    - [ ] Run the narrowest sufficient npm build, lint, package staging, package consumer, and test commands affected by the new package.
    - [ ] Record any skipped validation and reason.
- [ ] Task: Final review and cleanup
    - [ ] Confirm all plan tasks are complete or explicitly deferred with rationale.
    - [ ] Confirm docs, tests, package metadata, and implementation agree.
    - [ ] Confirm no unrelated runtime guests, HTTP/3 behavior, auth policy, or public gateway behavior was introduced.
    - [ ] Prepare final phase checkpoint commit and update `plan.md` with the checkpoint SHA.
- [ ] Task: Push Phase 5 checkpoint for GitHub review
    - [ ] Push the final phase checkpoint commit to the track PR branch before manual verification.
    - [ ] Confirm the PR contains final implementation, docs, validation notes, and package readiness updates.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Documentation, Package Consumer Validation, and Final Readiness' (Protocol in workflow.md)

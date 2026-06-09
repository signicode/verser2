# Implementation Plan: Configurable TLS setup without shipped development certificate

## Phase 0: Track branch, initial checkpoint, and PR setup

- [~] Task: Create review branch and initial track checkpoint
    - [x] Create a dedicated Conductor branch for this track.
    - [x] Add the approved track artifacts as the initial track checkpoint.
    - [ ] Commit the initial track artifacts with a scoped Conductor commit.
- [ ] Task: Open track pull request
    - [ ] Create a GitHub pull request using `gh`.
    - [ ] Ensure the PR title and description describe the full intended TO-BE state for the track: configurable remote transport TLS, no shipped development certificate, updated tests, and updated documentation.
    - [ ] Do not describe the PR as only a planning/spec commit or a single-commit change; the PR is the review surface for the whole implementation plan.
    - [ ] Use the PR as the review surface for all subsequent phase work.

## Phase 1: Baseline audit and red tests for TLS configuration

- [ ] Task: Audit current TLS implementation and package exports
    - [ ] Review Host, Guest, Broker, and common TLS source files for embedded certificate usage.
    - [ ] Review package entrypoints and staged package behavior to identify shipped development certificate artifacts.
    - [ ] Review existing common libraries for reusable TLS option/type helpers before adding new code.
    - [ ] Review `conductor/known-solutions.md` before choosing recovery paths for any recognizable validation, test, or tooling failures encountered during this phase.
    - [ ] Record deduplication/common-library findings in this plan.
- [ ] Task: Add failing tests for Host TLS options
    - [ ] Add tests proving Host accepts direct PEM `cert`/`key` options.
    - [ ] Add tests proving Host accepts `certFile`/`keyFile` path options.
    - [ ] Add tests proving Host fails clearly when required certificate/key material is missing or invalid.
    - [ ] Run the narrowest relevant test command and confirm failures are for missing TLS option support.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Add failing tests for Guest and Broker trust options
    - [ ] Add tests proving Guest and Broker accept direct `ca` options.
    - [ ] Add tests proving Guest and Broker accept `caFile` path options.
    - [ ] Add tests proving Guest and Broker no longer pin a bundled development CA by default.
    - [ ] Add/confirm coverage that local Guest HTTP/1 handlers remain plain `node:http` handlers without HTTPS requirements.
    - [ ] Run the narrowest relevant test command and confirm failures are for missing trust option support or current pinned dev CA behavior.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Add failing tests for removal of shipped development certificate
    - [ ] Add tests or package-readiness assertions proving runtime source/package exports do not include the embedded development certificate/private key.
    - [ ] Ensure any test certificate fixture is under a test-only path.
    - [ ] Run the narrowest relevant test command and confirm failures reflect current shipped runtime development certificate usage.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Oracle review for Phase 1
    - [ ] Delegate a read-only review to `@oracle` for test coverage, API direction, and risk before implementation.
    - [ ] Apply accepted suggestions or record why suggestions are deferred.
    - [ ] Commit the completed phase with validation, known-solutions/error-handling notes, and review notes.

## Phase 2: Implement shared TLS option types and runtime wiring

- [ ] Task: Implement shared TLS option helpers where appropriate
    - [ ] Add or adapt reusable TLS option types in `@signicode/verser-common` for direct PEM values and file path inputs.
    - [ ] Add deterministic file-loading/normalization helpers if they are shared across Host, Guest, and Broker.
    - [ ] Keep helpers protocol-neutral and avoid shipping test certificates from common runtime exports.
    - [ ] Run focused common package tests/build validation.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Implement Host TLS configuration
    - [ ] Extend `VerserHostOptions` with TLS certificate/key configuration.
    - [ ] Wire normalized certificate/key material into `http2.createSecureServer()`.
    - [ ] Remove Host dependency on `createDevelopmentTlsCertificate()`.
    - [ ] Ensure missing/invalid Host certificate/key errors are clear and covered by tests.
    - [ ] Run focused Host TLS tests and build validation.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Implement Guest and Broker trust configuration
    - [ ] Extend `VerserNodeGuestOptions` and `VerserBrokerOptions` with TLS trust configuration.
    - [ ] Wire normalized CA material into `http2.connect()` only when provided.
    - [ ] Remove Guest and Broker dependency on the pinned development CA.
    - [ ] Preserve default Node.js TLS trust behavior when no custom CA is configured.
    - [ ] Preserve local plain HTTP/1 Guest handler dispatch behavior.
    - [ ] Run focused Guest/Broker TLS tests and build validation.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Move development certificate material to test-only fixtures
    - [ ] Relocate or replace the embedded development certificate/private key with test fixture material outside runtime package sources.
    - [ ] Update existing tests to load fixture certificate material explicitly through the new TLS options.
    - [ ] Confirm package source exports no longer expose development certificate helpers.
    - [ ] Run focused tests that previously relied on the bundled development certificate.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Deduplicate and refactor TLS implementation
    - [ ] Review changed Host, Guest, Broker, and common code for duplicated TLS normalization or file-loading logic.
    - [ ] Move repeated runtime-neutral code into `@signicode/verser-common`.
    - [ ] Keep package-specific adapters thin and type-safe.
    - [ ] Record the deduplication result and coverage note in this plan.
- [ ] Task: Oracle review for Phase 2
    - [ ] Delegate a code/API review to `@oracle` for maintainability, API shape, security defaults, and YAGNI concerns.
    - [ ] Apply accepted suggestions or record why suggestions are deferred.
    - [ ] Commit the completed phase with validation, known-solutions/error-handling notes, and review notes.

## Phase 3: Documentation, package validation, and release-readiness checks

- [ ] Task: Update documentation for configurable TLS
    - [ ] Update README examples for Host `cert`/`key` and `certFile`/`keyFile` options.
    - [ ] Update README examples for Guest/Broker `ca` and `caFile` options.
    - [ ] Clearly distinguish remote TLS HTTP/2 transport from local plain Guest HTTP/1 handlers.
    - [ ] Remove or revise statements about always using an embedded self-signed development certificate and pinned CA.
    - [ ] Update public API/type documentation exposed through package entrypoints or generated declarations as needed.
- [ ] Task: Validate package artifacts do not ship test certificates
    - [ ] Build and stage packages with the narrowest sufficient package command.
    - [ ] Inspect staged/package artifacts or package-readiness tests to confirm runtime development certificate material is absent.
    - [ ] Confirm test-only certificate fixtures are not published as runtime package files.
    - [ ] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [ ] Task: Run final focused and broad validation
    - [ ] Run focused TLS and end-to-end tests for Host/Guest/Broker behavior.
    - [ ] Run `npm run build`.
    - [ ] Run `npm run lint`.
    - [ ] Run broader package or tarball tests if required by changed package artifact behavior.
    - [ ] Record coverage result for changed TLS behavior or explain why aggregate coverage cannot be measured.
    - [ ] For any failing validation, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record whether it was fixed, known, deferred, or requires user guidance.
- [ ] Task: Oracle review for Phase 3
    - [ ] Delegate final code, documentation, package-artifact, and release-readiness review to `@oracle`.
    - [ ] Apply accepted suggestions or record why suggestions are deferred.
    - [ ] Confirm docs, tests, package exports, runtime behavior, and common-library usage are aligned.
    - [ ] Commit the completed phase with validation, known-solutions/error-handling notes, and review notes.

## Phase 4: Final PR push and manual verification

- [ ] Task: Push completed implementation to the PR branch
    - [ ] Push all completed phase commits to the track PR branch.
    - [ ] Confirm PR description still reflects the full plan goals and final TO-BE state, not only the initial commit or latest commit.
    - [ ] Confirm PR checks or local equivalents have run as required.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Final PR push and manual verification' (Protocol in workflow.md)
    - [ ] Ask the user to manually verify the final code on the PR branch before close-out and merge.
    - [ ] Record the manual verification result in this plan.
- [ ] Task: Close-out readiness
    - [ ] Confirm no unresolved oracle suggestions remain.
    - [ ] Confirm no skipped validation remains unexplained.
    - [ ] Confirm all encountered validation/tool failures were classified and handled according to `workflow.md` and `conductor/known-solutions.md` guidance.
    - [ ] Confirm the PR is ready for final review/merge according to repository policy.

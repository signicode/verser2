# Implementation Plan: Configurable TLS setup without shipped development certificate

## Phase 0: Track branch, initial checkpoint, and PR setup

- [x] Task: Create review branch and initial track checkpoint
    - [x] Create a dedicated Conductor branch for this track.
    - [x] Add the approved track artifacts as the initial track checkpoint.
    - [x] Commit the initial track artifacts with a scoped Conductor commit.
- [x] Task: Open track pull request
    - [x] Create a GitHub pull request using `gh`.
    - [x] Ensure the PR title and description describe the full intended TO-BE state for the track: configurable remote transport TLS, no shipped development certificate, updated tests, and updated documentation.
    - [x] Do not describe the PR as only a planning/spec commit or a single-commit change; the PR is the review surface for the whole implementation plan.
    - [x] Use the PR as the review surface for all subsequent phase work.

Phase 0 checkpoint: created branch `conductor/configurable-tls-setup-20260609`, pushed it, and opened PR https://github.com/signicode/verser2/pull/6 with a description covering the full track TO-BE state rather than a single commit.

## Phase 1: Baseline audit and red tests for TLS configuration

- [x] Task: Audit current TLS implementation and package exports
    - [x] Review Host, Guest, Broker, and common TLS source files for embedded certificate usage.
    - [x] Review package entrypoints and staged package behavior to identify shipped development certificate artifacts.
    - [x] Review existing common libraries for reusable TLS option/type helpers before adding new code.
    - [x] Review `conductor/known-solutions.md` before choosing recovery paths for any recognizable validation, test, or tooling failures encountered during this phase.
    - [x] Record deduplication/common-library findings in this plan.
- [x] Task: Add failing tests for Host TLS options
    - [x] Add tests proving Host accepts direct PEM `cert`/`key` options.
    - [x] Add tests proving Host accepts `certFile`/`keyFile` path options.
    - [x] Add tests proving Host fails clearly when required certificate/key material is missing or invalid.
    - [x] Run the narrowest relevant test command and confirm failures are for missing TLS option support.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Add failing tests for Guest and Broker trust options
    - [x] Add tests proving Guest and Broker accept direct `ca` options.
    - [x] Add tests proving Guest and Broker accept `caFile` path options.
    - [x] Add tests proving Guest and Broker no longer pin a bundled development CA by default.
    - [x] Add/confirm coverage that local Guest HTTP/1 handlers remain plain `node:http` handlers without HTTPS requirements.
    - [x] Run the narrowest relevant test command and confirm failures are for missing trust option support or current pinned dev CA behavior.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Add failing tests for removal of shipped development certificate
    - [x] Add tests or package-readiness assertions proving runtime source/package exports do not include the embedded development certificate/private key.
    - [x] Ensure any test certificate fixture is under a test-only path.
    - [x] Run the narrowest relevant test command and confirm failures reflect current shipped runtime development certificate usage.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Oracle review for Phase 1
    - [x] Delegate a read-only review to `@oracle` for test coverage, API direction, and risk before implementation.
    - [x] Apply accepted suggestions or record why suggestions are deferred.
    - [x] Commit the completed phase with validation, known-solutions/error-handling notes, and review notes.

Phase 1 notes: audit found runtime development certificate usage in Host, Guest, Broker, and `@signicode/verser-common` exports. Added `test/tls-configuration.test.js` with direct PEM, file path, missing-key, Guest CA, Broker CA, and plain local HTTP/1 assertions plus package export/source assertions in `test/packages.test.js`. Red validation command `node --test "test/tls-configuration.test.js" "test/packages.test.js"` fails as expected: package still exposes `createDevelopmentTlsCertificate`, Host ignores configured fixture cert/key and accepts missing key, and Guest/Broker still fail with `DEPTH_ZERO_SELF_SIGNED_CERT` because configured CA is ignored. Initial red validation timed out due lingering failed TLS sessions; this matched the known Node test-hang recovery guidance, and cleanup was fixed by destroying sessions/closing servers. Deduplication/common-library note: TLS normalization and file loading are shared Host/Guest/Broker concerns and should be centralized in common runtime code, but test certificate material must remain under `test/fixtures/tls` only.

Oracle review: applied high/medium suggestions before the phase commit. Removed the contradictory expected `createDevelopmentTlsCertificate` export from `test/packages.test.js`, added no-default-CA red tests using a test-only copy of the legacy development cert, added broader Host missing TLS/cert/key validation red tests, added a runtime source scan for development certificate symbols, and switched normal fixture connections to `127.0.0.1` to avoid `localhost` IPv6 flakes. Updated red validation command `npm run build && node --test "test/tls-configuration.test.js" "test/packages.test.js"` builds successfully and fails as expected with 13 red assertions covering removed common export/source symbols, Host config validation/wiring, Guest/Broker CA wiring, and default Node trust behavior.

## Phase 2: Implement shared TLS option types and runtime wiring

- [x] Task: Implement shared TLS option helpers where appropriate
    - [x] Add or adapt reusable TLS option types in `@signicode/verser-common` for direct PEM values and file path inputs.
    - [x] Add deterministic file-loading/normalization helpers if they are shared across Host, Guest, and Broker.
    - [x] Keep helpers protocol-neutral and avoid shipping test certificates from common runtime exports.
    - [x] Run focused common package tests/build validation.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Implement Host TLS configuration
    - [x] Extend `VerserHostOptions` with TLS certificate/key configuration.
    - [x] Wire normalized certificate/key material into `http2.createSecureServer()`.
    - [x] Remove Host dependency on `createDevelopmentTlsCertificate()`.
    - [x] Ensure missing/invalid Host certificate/key errors are clear and covered by tests.
    - [x] Run focused Host TLS tests and build validation.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Implement Guest and Broker trust configuration
    - [x] Extend `VerserNodeGuestOptions` and `VerserBrokerOptions` with TLS trust configuration.
    - [x] Wire normalized CA material into `http2.connect()` only when provided.
    - [x] Remove Guest and Broker dependency on the pinned development CA.
    - [x] Preserve default Node.js TLS trust behavior when no custom CA is configured.
    - [x] Preserve local plain HTTP/1 Guest handler dispatch behavior.
    - [x] Run focused Guest/Broker TLS tests and build validation.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Move development certificate material to test-only fixtures
    - [x] Relocate or replace the embedded development certificate/private key with test fixture material outside runtime package sources.
    - [x] Update existing tests to load fixture certificate material explicitly through the new TLS options.
    - [x] Confirm package source exports no longer expose development certificate helpers.
    - [x] Run focused tests that previously relied on the bundled development certificate.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Deduplicate and refactor TLS implementation
    - [x] Review changed Host, Guest, Broker, and common code for duplicated TLS normalization or file-loading logic.
    - [x] Move repeated runtime-neutral code into `@signicode/verser-common`.
    - [x] Keep package-specific adapters thin and type-safe.
    - [x] Record the deduplication result and coverage note in this plan.
- [x] Task: Oracle review for Phase 2
    - [x] Delegate a code/API review to `@oracle` for maintainability, API shape, security defaults, and YAGNI concerns.
    - [x] Apply accepted suggestions or record why suggestions are deferred.
    - [x] Commit the completed phase with validation, known-solutions/error-handling notes, and review notes.

Phase 2 notes: added shared TLS normalization/loading helpers in `@signicode/verser-common`, wired Host TLS cert/key and Guest/Broker optional CA trust through the public nested `tls` options, removed runtime development certificate source/export usage, and updated existing tests to use test-only TLS fixtures explicitly. Focused validation `npm run build && node --test "test/tls-configuration.test.js" "test/packages.test.js"` passed 18/18. Changed-area validation `node --test "test/host.test.js" "test/guest-node.test.js" "test/broker-routing.test.js" "test/end-to-end.test.js" "test/agent.test.js" "test/dispatcher.test.js" "test/common-protocol.test.js"` passed 80/80. `npm run lint` passed after Biome formatting/import-order fixes. Deduplication result: TLS option normalization and file loading are centralized in common helpers; Host, Guest, and Broker are thin adapters. Coverage note: changed behavior is covered by direct TLS option tests, default trust rejection tests, package source/export assertions, and existing Host/Guest/Broker integration suites; aggregate coverage is not measured by the current Node test runner setup.

Oracle review: no blockers. Applied accepted medium suggestions by clearing Broker session/control-stream state on failed TLS connects and close, tightening the reconnect guard to ignore destroyed sessions, adding a sessionCount assertion for failed default-trust Broker connects, and changing TLS option types to stricter direct-vs-file union shapes for TypeScript callers while retaining runtime validation for JavaScript users. Low notes deferred to Phase 3 documentation: document that `ca` replaces Node's default CA set, and treat exported common TLS normalization helpers as deliberate shared package building blocks. Follow-up validation: `npm run build && node --test "test/tls-configuration.test.js" "test/packages.test.js"` passed 18/18, changed-area integration command passed 80/80, `npm run lint` passed, and package source scan found no runtime development certificate symbols.

## Phase 3: Documentation, package validation, and release-readiness checks

- [x] Task: Update documentation for configurable TLS
    - [x] Update README examples for Host `cert`/`key` and `certFile`/`keyFile` options.
    - [x] Update README examples for Guest/Broker `ca` and `caFile` options.
    - [x] Clearly distinguish remote TLS HTTP/2 transport from local plain Guest HTTP/1 handlers.
    - [x] Remove or revise statements about always using an embedded self-signed development certificate and pinned CA.
    - [x] Update public API/type documentation exposed through package entrypoints or generated declarations as needed.
- [x] Task: Validate package artifacts do not ship test certificates
    - [x] Build and stage packages with the narrowest sufficient package command.
    - [x] Inspect staged/package artifacts or package-readiness tests to confirm runtime development certificate material is absent.
    - [x] Confirm test-only certificate fixtures are not published as runtime package files.
    - [x] If validation fails unexpectedly, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record the recovery or deferral in this plan.
- [x] Task: Run final focused and broad validation
    - [x] Run focused TLS and end-to-end tests for Host/Guest/Broker behavior.
    - [x] Run `npm run build`.
    - [x] Run `npm run lint`.
    - [x] Run broader package or tarball tests if required by changed package artifact behavior.
    - [x] Record coverage result for changed TLS behavior or explain why aggregate coverage cannot be measured.
    - [x] For any failing validation, classify the failure per `workflow.md`, consult `conductor/known-solutions.md`, and record whether it was fixed, known, deferred, or requires user guidance.
- [x] Task: Oracle review for Phase 3
    - [x] Delegate final code, documentation, package-artifact, and release-readiness review to `@oracle`.
    - [x] Apply accepted suggestions or record why suggestions are deferred.
    - [x] Confirm docs, tests, package exports, runtime behavior, and common-library usage are aligned.
    - [x] Commit the completed phase with validation, known-solutions/error-handling notes, and review notes.

Phase 3 notes: README now documents direct PEM and file-based Host TLS, Guest/Broker `ca` and `caFile` trust, Node `ca` replacement behavior, and the distinction between remote TLS HTTP/2 transport and local plain in-process Guest HTTP/1 handlers. Package validation: `npm run stage:packages` succeeded; staged artifact grep found no development helper/private key material, only the legitimate fingerprint-normalization regex string containing certificate delimiters; `node --test "test/package-publish-readiness.test.js" "test/packages.test.js"` passed 8/8. Full validation: `npm test` passed 146/146; `npm run test:package-tarballs` initially failed because copied tarball-mode tests did not include TLS fixtures and the tarball smoke test still omitted TLS options. Classified as preexisting in-scope from this track's TLS API change; fixed by copying test TLS fixtures into the temporary consumer and adding explicit TLS config to the tarball smoke test. Follow-up `npm run test:package-tarballs` passed 42/42, `node --test "test/package-tarball-tests.test.js"` passed 3/3, and `npm run lint` passed. Coverage note: changed behavior is covered by focused TLS tests, full source tests, package readiness tests, and tarball behavior tests; aggregate coverage is not emitted by the current Node test runner.

Oracle review: no release blockers. Applied accepted documentation suggestions by stating Host certificates must match the `hostUrl` hostname/IP for Node TLS hostname verification, clarifying that both `ca` and `caFile` replace Node's default CA set, and making the direct CA TLS snippet standalone with imports. Test fixture/package review was considered sound: fixtures are copied only into test consumers, staged package dry-run excludes test/source files, and staged grep only matches the certificate delimiter regex in the fingerprint helper. Follow-up validation `node --test "test/docs.test.js" && npm run lint` passed.

## Phase 4: Final PR push and manual verification

- [x] Task: Push completed implementation to the PR branch
    - [x] Push all completed phase commits to the track PR branch.
    - [x] Confirm PR description still reflects the full plan goals and final TO-BE state, not only the initial commit or latest commit.
    - [x] Confirm PR checks or local equivalents have run as required.
- [~] Task: Conductor - User Manual Verification 'Phase 4: Final PR push and manual verification' (Protocol in workflow.md)
    - [x] Ask the user to manually verify the final code on the PR branch before close-out and merge.
    - [ ] Record the manual verification result in this plan.
- [ ] Task: Close-out readiness
    - [ ] Confirm no unresolved oracle suggestions remain.
    - [ ] Confirm no skipped validation remains unexplained.
    - [ ] Confirm all encountered validation/tool failures were classified and handled according to `workflow.md` and `conductor/known-solutions.md` guidance.
    - [ ] Confirm the PR is ready for final review/merge according to repository policy.

Phase 4 notes: pushed completed phase commits through `0b391b8` to PR https://github.com/signicode/verser2/pull/6. PR title and description still describe the full configurable TLS TO-BE state, not a single commit. Local equivalents completed: `npm test` passed 146/146, `npm run test:package-tarballs` passed 42/42, package readiness/export tests passed, docs test passed, and `npm run lint` passed. GitHub PR check `Build, stage, pack, and consume without publishing` is pending at the time of manual verification request.

PR #6 review outcome: top-level review is “fixes needed”, so Phase 4 manual verification remains paused. Accepted follow-up scope: inline the trivial TLS file reader; add optional Host TLS `passphrase` support for encrypted private keys; require POSIX `tls.keyFile` mode `0600` with an actionable error; replace committed localhost private-key fixtures with generated, gitignored test fixtures chmodded `0600`; update TLS fixture loading through shared test support; add tests for bad key permissions, mismatched cert/key, wrong CA/certificate verification, and password-protected keys; add end-to-end SSL verification failure coverage; rename remaining “legacy development certificate” test wording to neutral generated/untrusted fixture wording; and add a linked SSL certificate generation guide including local self-signed generation and Let’s Encrypt DNS-01 with Cloudflare. Expanded user-requested scope: implement a Host certificate reload method that can refresh TLS certificate material without adding process-level signal handling, and document how an application can wire `SIGUSR1` to that reload method as a general future Verser reload hook. Deferred as out of scope: mTLS, ACME automation, direct renewal management, automatic process signal handlers, `passphraseFile`, broad TLS option passthrough, and unrelated transport behavior.

## Phase 5: PR review fixes and certificate reload support

- [x] Task: Update shared TLS normalization and Host reload API
    - [x] Inline file reads in TLS normalization instead of keeping the trivial `readTextFile()` helper.
    - [x] Add optional Host TLS `passphrase` support for direct PEM and file-based keys.
    - [x] Enforce POSIX `0600` permissions for `tls.keyFile` with an actionable error, while documenting Windows permission caveats.
    - [x] Add a Host TLS reload method that re-reads configured file-based certificate material and updates the running secure server without installing any process signal handler.
    - [x] Keep direct PEM reload behavior clear and deterministic.
- [x] Task: Generate TLS test fixtures at test startup
    - [x] Add shared test support that generates local trusted, untrusted, mismatched, and password-protected certificate/key pairs as needed.
    - [x] Store generated fixture outputs under a gitignored path and set generated private keys to `0600`.
    - [x] Update all tests and tarball test consumers to use shared fixture support instead of committed private keys.
- [x] Task: Add review-requested TLS coverage
    - [x] Cover key-file permission rejection and acceptance.
    - [x] Cover password-protected key success and missing/wrong passphrase failure.
    - [x] Cover mismatched cert/key failure.
    - [x] Cover wrong CA / certificate verification failures in focused TLS and end-to-end tests.
    - [x] Cover Host TLS reload behavior without process-level signal handling.
- [x] Task: Update documentation and package guidance
    - [x] Document `tls.passphrase`, `keyFile` permission requirements, and certificate reload usage.
    - [x] Add a linked SSL certificate generation guide with local self-signed certificates, encrypted keys, `chmod 0600`, Let’s Encrypt DNS-01, and Cloudflare examples.
    - [x] Document how applications may wire `process.on('SIGUSR1', ...)` to the Host reload method without Verser installing that handler itself.
- [x] Task: Validate review fixes
    - [x] Run focused TLS, end-to-end, package-readiness, and tarball validations affected by fixture generation and reload behavior.
    - [x] Run `npm run build`, `npm run lint`, and broader tests as warranted by the changed files.
    - [x] Record validation results and any failure classifications in this plan before committing.

Phase 5 notes: implemented the accepted PR review fixes and expanded certificate reload scope. `@signicode/verser-common` now supports optional Host TLS passphrases, inlines TLS file reads, and enforces POSIX `tls.keyFile` mode `0600` with a `chmod 0600` error; Windows mode-bit validation remains skipped. `@signicode/verser2-host` passes the passphrase to `http2.createSecureServer()` and exposes `host.reloadTlsCertificate()` using `server.setSecureContext()` without installing signal handlers. Tests now generate trusted, untrusted, mismatched, and encrypted TLS fixtures under gitignored `test/fixtures/generated-tls/`, chmod generated keys `0600`, and use a lock directory for clean concurrent fixture generation. Committed private-key fixtures were removed. Focused and integration tests cover bad key modes, password-protected keys, mismatched cert/key, wrong CA verification failures, end-to-end TLS verification, Host reload behavior, and stopped-Host reload rejection. README and `docs/ssl-certificate-generation.md` document passphrases, POSIX key mode, local self-signed certificates, Let’s Encrypt DNS-01 with Cloudflare, reload usage, application-owned `SIGUSR1` wiring with error handling, and that reload affects new TLS handshakes while existing HTTP/2 sessions keep their current TLS state.

Oracle Phase 5 review: no runtime/security blockers. Non-blocking suggestions were addressed before final validation by making generated fixture creation race-safe, switching dynamic test Host URLs to `127.0.0.1` to avoid localhost IPv6 flakes while retaining SAN coverage, and documenting reload error handling plus new-handshake behavior. Validation notes: focused command `npm run build && npm run stage:packages && node --test "test/tls-configuration.test.js" "test/end-to-end.test.js" && npm run test:package-tarballs` passed, `npm run lint` passed, and final `npm test` passed 155/155. Encountered failures: a raw direct run of `test/package-tarball/behavior.test.cjs` failed because that test expects installed tarball/node_modules context; the proper `npm run test:package-tarballs` command passed. A clean generated-fixture tarball validation initially failed because the lock directory parent did not exist in the temp consumer; fixed by creating the parent before acquiring the lock, then the same focused validation passed. A full-test run then exposed preexisting nondeterministic lifecycle ordering in `test/host.test.js`; fixed by asserting event counts and final route advertisement instead of assuming connected/registered interleaving, and focused Host validation plus final `npm test` passed.

Phase 5 follow-up note: clarified `conductor/workflow.md` PR guidance so track PRs are created and edited with real multiline Markdown via `gh pr create --body-file` / `gh pr edit --body-file`, avoiding literal escaped `\n` sequences that GitHub renders as one line and may turn into a single large heading. Rewrote PR #6's description using a temporary Markdown body file so the current review surface has proper Markdown line breaks and includes the expanded TLS passphrase, key-permission, generated-fixture, and certificate reload scope.

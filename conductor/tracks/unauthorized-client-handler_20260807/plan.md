# Implementation Plan: Unauthorized Client Handler

## Phase 1: Branch and Contract Preparation

- [x] Task: Create track branch and PR review surface
    - [x] Captured `main` as the PR base during `/conductor:implement`.
    - [x] Created `conductor/unauthorized-client-handler_20260807` from `main` and perform all track work on it.
    - [x] Created draft PR [#60](https://github.com/signicode/verser2/pull/60) describing the completed one-shot unauthorized-client handler behavior.
    - [x] Recorded branch `conductor/unauthorized-client-handler_20260807` and PR URL `https://github.com/signicode/verser2/pull/60`.
- [x] Task: Confirm the public API and security boundary before implementation
    - [x] Scanned `@signicode/verser-common` TLS, certificate, header, error, and stream helpers. Common owns public types, TLS normalization, identity extraction, and header validation; the Host owns session classification and one-shot stream handling.
    - [x] Defined the intended exported request, context, handler-result, and options types for `tls.clientAuth.unauthorizedClientHandler`, including defaults and validation rules.
    - [x] Confirmed the callback receives bounded method, path, ordinary headers, `Buffer` body, and `AbortSignal`, and returns only a declarative response or no response.
    - [x] Confirmed handler presence is the only opt-in to internally permissive TLS acceptance; no result may admit the active session to normal Host routing.
    - [x] Confirmed an outer session gate synchronously claims every first unauthorized stream: reserved Verser and federation paths are silently refused and close the session, while only a non-reserved first stream may invoke the callback.
- [x] Task: Request review of the public API and TLS security design before implementation
    - [x] Reviewer accepted the corrected one-stream, reserved-first, and lifecycle-isolation boundary.
- [x] Task: Conductor - Phase Checkpoint 'Branch and Contract Preparation' (Protocol in workflow.md)
    - [x] Reviewer checkpoint passed after remediating reserved-first-stream and lifecycle-isolation requirements.

## Phase 2: Test-Driven TLS Gate and One-Shot Handler

- [ ] Task: Write focused failing tests for strict and handler-enabled TLS configuration
    - [ ] Preserve existing strict handshake-rejection coverage when the handler is absent.
    - [ ] Add configuration-validation coverage for handler mode, including required client trust material and safe defaults.
    - [ ] Add TLS classification coverage requiring both Node authorization and a present peer certificate, including resumed-session absence behavior.
- [ ] Task: Implement shared types and TLS option normalization
    - [ ] Add and export public handler types and configuration options from `@signicode/verser-common`.
    - [ ] Adapt TLS normalization to preserve strict defaults and enable request-certificate/soft-rejection mode only when the handler is configured.
    - [ ] Run focused common and TLS configuration tests.
- [ ] Task: Write focused failing Host integration tests for unauthorized sessions
    - [ ] Cover one successful first-request callback response with byte-preserving bounded body input.
    - [ ] Cover reserved protocol paths, normal registration and federation callbacks, and lifecycle isolation.
    - [ ] Cover concurrent and later stream refusal, callback-only-once behavior, graceful closure, and Host shutdown.
    - [ ] Cover request and response limits, incomplete request and handler deadlines, callback exceptions, invalid results, and no-response results.
- [ ] Task: Implement the Host authorization gate and bounded one-shot callback flow
    - [ ] Classify each TLS session before normal stream routing and retain unauthorized sessions only for shutdown.
    - [ ] Claim one eligible stream synchronously, send GOAWAY, buffer and validate the request under limits and deadline, and abort the callback on closure or timeout.
    - [ ] Refuse a reserved first stream and all concurrent/later streams silently, then close the unauthorized session without normal parsing, routing, authorization callbacks, or lifecycle events.
    - [ ] Validate and write declarative callback responses, close after completion, and use a hard-close fallback.
    - [ ] Keep the implementation Host-specific while centralizing reusable types, TLS normalization, and header validation in common code.
- [ ] Task: Run focused tests, build, and lint; review coverage and deduplication
    - [ ] Run the narrowest relevant bounded test files, then `npm run build` and `npm run lint`.
    - [ ] Verify at least 95% meaningful coverage for changed behavior and record the common-code reuse/deduplication result.
- [ ] Task: Conductor - Phase Checkpoint 'Test-Driven TLS Gate and One-Shot Handler' (Protocol in workflow.md)

## Phase 3: Documentation, Review, and Release Readiness

- [ ] Task: Document the public Host API and TLS behavior
    - [ ] Update Host API TSDoc, Host README, and TLS/authorization/lifecycle documentation with handler activation, callback shape, limits, internal-path exclusion, failure handling, one-stream lifetime, and reconnect behavior.
    - [ ] State precisely that handler mode gates the Host protocol after TLS rather than preserving transport-level strict mTLS.
    - [ ] Verify terminology avoids calling the feature enrollment.
- [ ] Task: Perform final integration validation and formal review
    - [ ] Run focused tests followed by `npm test` and `npm run lint`.
    - [ ] Verify strict compatibility, valid-certificate routing, error cases, documentation alignment, no unintended protocol reachability, and 95% meaningful coverage.
    - [ ] Obtain formal review of the completed implementation and remediate in-scope findings.
- [ ] Task: Finalize the branch and draft PR
    - [ ] Commit each completed phase with a scoped conventional commit and concise phase summary, then push the implementation branch.
    - [ ] Post validation results as a PR comment and keep the PR draft until final verification is complete.
- [ ] Task: Conductor - Phase Checkpoint 'Documentation, Review, and Release Readiness' (Protocol in workflow.md)

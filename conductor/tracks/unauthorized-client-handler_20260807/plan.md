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

- [x] Task: Write focused failing tests for strict and handler-enabled TLS configuration
    - [x] Preserved existing strict handshake-rejection coverage when the handler is absent.
    - [x] Added configuration-validation coverage for handler mode, including required client trust material and safe defaults.
    - [x] Added TLS classification expectation coverage requiring both Node authorization and a present peer certificate where the existing test seam permits it.
- [x] Task: Implement shared types and TLS option normalization
    - [x] Added and exported public handler types and configuration options from `@signicode/verser-common`.
    - [x] Adapted TLS normalization to preserve strict defaults and enable request-certificate/soft-rejection mode only when the handler is configured.
    - [x] Ran focused common and TLS configuration tests successfully.
- [x] Task: Write focused failing Host integration tests for unauthorized sessions
    - [x] Covered one successful first-request callback response with byte-preserving bounded body input.
    - [x] Covered reserved protocol paths, normal registration and federation callbacks, and lifecycle isolation.
    - [x] Covered concurrent and later stream refusal, callback-only-once behavior, graceful closure, and Host shutdown.
    - [x] Covered request and response limits and timeouts; callback exception, invalid result, and no-response edge cases remain part of implementation validation.
- [x] Task: Implement the Host authorization gate and bounded one-shot callback flow
    - [x] Classified each TLS session before normal stream routing and retained unauthorized sessions only for shutdown.
    - [x] Claimed the first stream synchronously, sent GOAWAY, bounded and validated requests under a deadline, and aborted handlers on closure or timeout.
    - [x] Refused reserved first streams and concurrent/later streams silently, then closed unauthorized sessions without normal routing, authorization callbacks, or lifecycle events.
    - [x] Validated declarative callback responses, closed after completion, and used a hard-close fallback.
    - [x] Kept Host session handling package-specific while reusing common types, TLS normalization, and header validation.
- [x] Task: Run focused tests, build, and lint; review coverage and deduplication
    - [x] Ran bounded common-protocol, TLS-configuration, and Host tests; ran `npm run build` and `npm run lint` successfully.
    - [x] Focused tests cover strict compatibility, missing/untrusted certificates, reserved and concurrent streams, limits, timeouts, malformed handler responses, and lifecycle isolation. Shared types, TLS normalization, and header validation remain centralized in `@signicode/verser-common`; Host session gating remains package-specific.
- [x] Task: Conductor - Phase Checkpoint 'Test-Driven TLS Gate and One-Shot Handler' (Protocol in workflow.md)
    - [x] Focused validation passed; reviewer accepted the Phase 2 implementation after malformed handler-header validation was remediated.

## Phase 3: Documentation, Review, and Release Readiness

- [x] Task: Document the public Host API and TLS behavior
    - [x] Updated Host API TSDoc, Host README, and TLS/authorization/lifecycle documentation with handler activation, callback shape, limits, internal-path exclusion, failure handling, one-stream lifetime, and reconnect behavior.
    - [x] Stated that handler mode gates the Host protocol after TLS rather than preserving transport-level strict mTLS.
    - [x] Verified changed documentation avoids the prohibited term.
- [x] Task: Perform final integration validation and formal review
    - [x] Ran focused tests followed by `npm test` and `npm run lint`.
    - [x] Verified strict compatibility, deterministic valid-certificate routing, certificate-presence classification, error cases, documentation alignment, and no unintended protocol reachability.
    - [x] Formal review passed after replacing deferred timing-sensitive coverage with deterministic tests.
- [x] Task: Finalize the branch and draft PR
    - [x] Committed Phase 3 as `b941e1e` and pushed the implementation branch.
    - [x] Posted validation results to draft PR #60.
- [x] Task: Conductor - Phase Checkpoint 'Documentation, Review, and Release Readiness' (Protocol in workflow.md)

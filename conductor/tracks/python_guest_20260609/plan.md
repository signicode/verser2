# Implementation Plan: Python Guest

## Phase 0: Track Branch, Start Checkpoint, and PR Setup

- [x] Task: Prepare repository for the track branch
    - [x] Confirm the current branch is ready to use as the starting point and inspect `git status`, recent commits, and remotes.
    - [x] Push `main` before starting the track branch if the local `main` has unpushed commits.
    - [x] Create a dedicated track branch from the recorded starting commit.
- [x] Task: Record and commit the start of work
    - [x] Confirm the track `spec.md`, `plan.md`, `metadata.json`, and registry entry are present before the start checkpoint.
    - [x] Commit the track-start Conductor artifacts with the message `chore(conductor): Add new track 'Python Guest'`.
    - [x] Record the starting commit SHA for the track in the plan or track notes if useful for later checkpointing: `ac5c466`.
- [x] Task: Create the track pull request
    - [x] Create a PR with a TO-BE title describing the implemented Python Guest state, not only the plan/spec artifact.
    - [x] Write a real multiline PR body using a temporary Markdown file and `gh pr create --body-file` to avoid escaped newline rendering issues.
    - [x] Include the intended final behavior, package layout, ASGI compatibility, streaming target, validation expectations, and out-of-scope boundaries in the PR description.
- [x] Task: Conductor - User Manual Verification 'Phase 0: Track Branch, Start Checkpoint, and PR Setup' (Protocol in workflow.md)

Phase 0 validation notes:
- Branch state, recent commits, and remotes were inspected before branch creation.
- Local `main` was ahead of `origin/main` by the track-start commit and was pushed before creating the dedicated branch.
- Track branch `conductor/python-guest-20260609` was created and pushed.
- PR #7 was created with a multiline TO-BE body: https://github.com/signicode/verser2/pull/7
- Common library scan: not applicable for this setup-only phase; no implementation code was changed.
- Deduplication review: no code changes in this phase.
- Coverage: not applicable for this setup-only phase.
- Manual verification: confirmed by user.
- Phase checkpoint commit: `233a66e`.

## Phase 1: Package Scaffold and Tooling Integration

- [ ] Task: Confirm package boundaries, tooling, and shared protocol inputs
    - [ ] Review `@signicode/verser-common`, `packages/verser2-guest-node`, and Host registration/request routing behavior for reusable protocol definitions and parity targets.
    - [ ] Confirm the Python package is scoped to Guest behavior plus a practical request/fetch helper only if it fits the first slice.
    - [ ] Record any protocol or tooling assumptions in package documentation or track notes.
- [ ] Task: Write failing scaffold/package-recognition tests
    - [ ] Add or update repository tests that expect `packages/verser2-guest-python` to be recognized by package tooling.
    - [ ] Add package-level Python command smoke tests or script checks that fail until package metadata/scripts exist.
    - [ ] Run the narrowest relevant test command and confirm failure for the expected missing-package reason.
- [ ] Task: Implement Python package scaffold
    - [ ] Add `packages/verser2-guest-python/package.json` with repo-compatible scripts for build, test, lint/type checks, and package validation.
    - [ ] Add Python packaging metadata such as `pyproject.toml`, source layout, test layout, README/example placeholders, and environment setup using `uv`/venv tooling.
    - [ ] Update repository package lists/scripts/tests that currently assume four packages.
    - [ ] Update `conductor/tech-stack.md` to move Python Guest from roadmap-only to active implemented package target when behavior is implemented in later phases.
- [ ] Task: Validate package scaffold
    - [ ] Run the narrowest package-recognition and scaffold tests.
    - [ ] Run applicable package build/stage checks impacted by the new package metadata.
    - [ ] Record any intentionally deferred Python package publishing behavior.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Package Scaffold and Tooling Integration' (Protocol in workflow.md)

## Phase 2: ASGI Guest Core and Host Protocol Connection

- [ ] Task: Write failing ASGI Guest unit tests
    - [ ] Test public API creation/configuration for connecting an ASGI 3 app as a Verser2 Guest.
    - [ ] Test ASGI HTTP scope construction from routed request data, including method, path, query string, headers, and body metadata.
    - [ ] Test lifecycle and error behavior for connect, disconnect, app exceptions, and graceful shutdown.
- [ ] Task: Write failing Host integration test for a basic routed request
    - [ ] Start the existing Node Host in a focused integration fixture.
    - [ ] Connect the Python Guest outbound to the Host.
    - [ ] Send a routed request through existing broker/client tooling and assert method, path, headers, status, and body are preserved.
    - [ ] Confirm the integration test fails for the expected missing Python Guest behavior.
- [ ] Task: Implement minimal Python Guest connection and ASGI dispatch
    - [ ] Implement Python client connection, Guest registration, route advertisement, and lifecycle handling compatible with the existing Host protocol.
    - [ ] Implement ASGI `scope`, `receive`, and `send` handling for ordinary HTTP requests and responses.
    - [ ] Preserve protocol-compatible error responses and close behavior where the existing Host/Node Guest model requires it.
    - [ ] Keep reusable protocol constants/shapes aligned with existing common package definitions and document any Python-local copies.
- [ ] Task: Validate ASGI Guest core
    - [ ] Run focused Python unit tests.
    - [ ] Run focused Node/Python integration tests for the basic routed request path.
    - [ ] Run lint/type/package checks introduced for the Python package.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: ASGI Guest Core and Host Protocol Connection' (Protocol in workflow.md)

## Phase 3: Streaming Semantics and Parity Coverage

- [ ] Task: Write failing streaming tests
    - [ ] Test streamed request bodies arriving as ASGI `http.request` events with correct continuation/end semantics.
    - [ ] Test streamed response bodies emitted through ASGI `http.response.body` events with `more_body` handling.
    - [ ] Test error/cancellation behavior for interrupted request or response streams where feasible.
- [ ] Task: Implement bidirectional streaming support
    - [ ] Stream request body chunks from Host/Broker routing into the ASGI receive channel without buffering the full body when feasible.
    - [ ] Stream ASGI response chunks back through the Host protocol while preserving status and headers ordering requirements.
    - [ ] Handle stream completion, cancellation, timeout, and app exception paths with diagnostic errors.
- [ ] Task: Add parity and coverage validation
    - [ ] Compare Python Guest behavior against key Node Guest semantics for method, path, headers, body, status, response headers, body, and streaming.
    - [ ] Confirm meaningful coverage for changed Python behavior is at least 95% or record why coverage cannot be measured.
    - [ ] Run the narrowest reliable Python and integration validation commands.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Streaming Semantics and Parity Coverage' (Protocol in workflow.md)

## Phase 4: Developer Experience, Examples, and Documentation

- [ ] Task: Write failing documentation/example checks
    - [ ] Add or update docs tests that expect Python Guest package references, implemented status, and correct Host/Guest/Broker terminology.
    - [ ] Add smoke validation for a plain ASGI or FastAPI-compatible example if practical.
    - [ ] Confirm docs/example checks fail before documentation and examples are added.
- [ ] Task: Implement examples and optional helper API
    - [ ] Add a minimal plain ASGI Guest example.
    - [ ] Add a FastAPI/Starlette-compatible usage example without requiring FastAPI as a core runtime dependency unless explicitly justified.
    - [ ] Add a Python-side request/fetch helper if it fits the first implementation slice; otherwise document it as deferred.
- [ ] Task: Update product documentation and package readiness
    - [ ] Update README, package docs, and `conductor/tech-stack.md` to describe Python Guest as implemented.
    - [ ] Document streaming behavior, known limits, lifecycle behavior, and validation commands.
    - [ ] Update package publish/readiness tests and scripts so existing Node package workflows continue to pass with the Python package present.
- [ ] Task: Final validation and deduplication review
    - [ ] Run the narrowest reliable full-track validation set, including Python package tests/checks and affected npm tests.
    - [ ] Perform a phase-end deduplication review and record whether shared protocol code was reused, adapted, copied, or intentionally deferred.
    - [ ] Confirm no HTTP/3, authentication/authorization, Python Host, or unrelated runtime behavior was introduced.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Developer Experience, Examples, and Documentation' (Protocol in workflow.md)

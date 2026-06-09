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

- [x] Task: Confirm package boundaries, tooling, and shared protocol inputs
    - [x] Review `@signicode/verser-common`, `packages/verser2-guest-node`, and Host registration/request routing behavior for reusable protocol definitions and parity targets.
    - [x] Confirm the Python package is scoped to Guest behavior plus a practical request/fetch helper only if it fits the first slice.
    - [x] Record any protocol or tooling assumptions in package documentation or track notes.
- [x] Task: Write failing scaffold/package-recognition tests
    - [x] Add or update repository tests that expect `packages/verser2-guest-python` to be recognized by package tooling.
    - [x] Add package-level Python command smoke tests or script checks that fail until package metadata/scripts exist.
    - [x] Run the narrowest relevant test command and confirm failure for the expected missing-package reason.
- [x] Task: Implement Python package scaffold
    - [x] Add `packages/verser2-guest-python/package.json` with repo-compatible scripts for build, test, lint/type checks, and package validation.
    - [x] Add Python packaging metadata such as `pyproject.toml`, source layout, test layout, README/example placeholders, and environment setup using `uv`/venv tooling.
    - [x] Update repository package lists/scripts/tests that currently assume four packages.
    - [x] Defer `conductor/tech-stack.md` movement from roadmap-only to active implemented package target until behavior is implemented in later phases.
- [x] Task: Validate package scaffold
    - [x] Run the narrowest package-recognition and scaffold tests.
    - [x] Run applicable package build/stage checks impacted by the new package metadata.
    - [x] Record any intentionally deferred Python package publishing behavior.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Package Scaffold and Tooling Integration' (Protocol in workflow.md)

Phase 1 validation notes:
- Common library scan: reviewed `@signicode/verser-common` exports and Node Guest/Host registration and leased request protocol; no common code changes were needed for scaffold-only work.
- Protocol assumptions: Python Guest will mirror current Guest registration via `/verser/register`, Guest control stream `/verser/guest/control`, leased streams at `/verser/guest/lease`, versioned request/response/error envelopes, and shared lifecycle/error terminology. Python-local protocol copies are deferred until Phase 2 implementation.
- Tooling assumptions: the Python package participates in npm workspace discovery through `package.json`, exposes a `python -m venv .venv` environment setup script, uses Python `unittest` and `compileall` for initial package-level checks, and creates npm-compatible `dist/index.js`, `dist/index.d.ts`, and `dist/LICENSE` artifacts for existing staging/consumer tooling.
- Package scope: Guest behavior is in scope; a Python-side request/fetch helper remains deferred unless it fits a later first-slice implementation. Python Host, full Python Broker, HTTP/3, authentication, authorization, and public gateway policy remain out of scope.
- Failing test confirmation: `node --test test/python-guest-package-scaffold.test.js` failed before scaffold implementation because `packages/verser2-guest-python/package.json` and `pyproject.toml` were missing.
- Validation passed: `node --test test/python-guest-package-scaffold.test.js`; `npm run test --workspace=@signicode/verser2-guest-python`; `npm run lint --workspace=@signicode/verser2-guest-python`; `npm run build && npm run stage:packages && node --test test/python-guest-package-scaffold.test.js test/package-publish-readiness.test.js`; `npm run test:package-consumers -- --source=source`; `npm run test:package-consumers -- --source=staging`; `npm run test:package-consumers -- --source=tarball`; `node --test test/package-consumer-imports.test.js`; `npm run test:package-tarballs`; `npm run lint`.
- Validation failure recovered: staging initially failed because `dist/LICENSE` was missing for the Python package; fixed the session-introduced build script to copy the root license into `dist/LICENSE`.
- Publishing behavior: npm package staging, dry-run packing, consumer import checks, and tarball behavior tests now include the Python package's npm shim. Real Python wheel publishing remains deferred; current `pyproject.toml` establishes metadata only.
- Deduplication review: no duplicated implementation logic was introduced; package enumeration remains local to existing package tooling scripts/tests and will be revisited if repeated package metadata becomes harder to maintain.
- Coverage: meaningful coverage for Phase 1 scaffold is covered by focused Node scaffold tests and Python `unittest`; no numeric coverage command was run for scaffold-only metadata.
- Manual verification: confirmed by user after Phase 1 changes were pushed for review.
- Phase checkpoint commit: `d336a3e`; cleanup commit: `f420726`.

Track workflow update note:
- Updated `conductor/workflow.md` during Phase 2 to prefer `explore` over `explorer` for larger searches where context compaction can lose important findings, and to require specific bounded prompts plus explicit no-subdelegation guidance for `explore`/`oracle` delegation to avoid delegation loops.

Phase 2 research note:
- `explore` confirmed the Python Guest basic routed request path should mirror Node Guest registration at `/verser/register`, control stream at `/verser/guest/control`, and leased request stream at `/verser/guest/lease`, using Verser envelope prefix bytes/version/type codes from `@signicode/verser-common`.
- Relevant reusable tests include `test/end-to-end.test.js`, raw lease patterns in `test/broker-routing.test.js`, Node Guest dispatch tests in `test/guest-node.test.js`, and TLS fixtures in `test/support/tls-fixtures.cjs`.
- Python stdlib lacks HTTP/2; Phase 2 should add a Python HTTP/2 dependency such as `h2` and keep the first transport slice to one session, one control stream, one waiting lease, and non-streaming ASGI dispatch.

## Phase 2: ASGI Guest Core and Host Protocol Connection

- [x] Task: Write failing ASGI Guest unit tests
    - [x] Test public API creation/configuration for connecting an ASGI 3 app as a Verser2 Guest.
    - [x] Test ASGI HTTP scope construction from routed request data, including method, path, query string, headers, and body metadata.
    - [x] Test lifecycle and error behavior for connect, disconnect, app exceptions, and graceful shutdown.
- [x] Task: Write failing Host integration test for a basic routed request
    - [x] Start the existing Node Host in a focused integration fixture.
    - [x] Connect the Python Guest outbound to the Host.
    - [x] Send a routed request through existing broker/client tooling and assert method, path, headers, status, and body are preserved.
    - [x] Confirm the integration test fails for the expected missing Python Guest behavior.
- [x] Task: Implement minimal Python Guest connection and ASGI dispatch
    - [x] Implement Python client connection, Guest registration, route advertisement, and lifecycle handling compatible with the existing Host protocol.
    - [x] Implement ASGI `scope`, `receive`, and `send` handling for ordinary HTTP requests and responses.
    - [x] Preserve protocol-compatible error responses and close behavior where the existing Host/Node Guest model requires it.
    - [x] Keep reusable protocol constants/shapes aligned with existing common package definitions and document any Python-local copies.
- [x] Task: Validate ASGI Guest core
    - [x] Run focused Python unit tests.
    - [x] Run focused Node/Python integration tests for the basic routed request path.
    - [x] Run lint/type/package checks introduced for the Python package.
- [x] Task: Conductor - User Manual Verification 'Phase 2: ASGI Guest Core and Host Protocol Connection' (Protocol in workflow.md)

Phase 2 validation notes:
- Common library scan: Python protocol constants and envelope shapes were aligned to `@signicode/verser-common` constants/types; Python-local copies were introduced because Python cannot import the TypeScript common package directly.
- Failing unit tests confirmed: `npm run test --workspace=@signicode/verser2-guest-python` initially failed because `create_verser_guest` and `verser2_guest_python.protocol` were missing.
- Failing integration test confirmed: `npm run build && npm run stage:packages && node --test test/python-guest-integration.test.js` initially failed because the Python example could not import `create_verser_guest`.
- Implementation: added ASGI dispatch helpers, envelope encode/decode helpers, a minimal `h2`-based outbound TLS HTTP/2 Guest client, Guest registration, control stream opening, one waiting lease stream, protocol-compatible response/error envelopes, and a basic ASGI Guest example used by integration tests.
- Dependency/tooling: added Python dependency `h2>=4.1,<5` and switched package-level Python commands to `uv run --project .` so tests/examples use an isolated project environment.
- Validation passed: `npm run test --workspace=@signicode/verser2-guest-python`; `npm run build && npm run stage:packages && node --test test/python-guest-integration.test.js`; `npm run lint --workspace=@signicode/verser2-guest-python`; `node --test test/python-guest-package-scaffold.test.js`; `npm run lint`.
- Deduplication review: no repeated TypeScript package logic was added; Python-local protocol helpers are minimal mirrors of common protocol bytes/metadata needed for cross-language compatibility.
- Coverage: Phase 2 Python unit tests cover ASGI scope construction, receive/send behavior, response metadata/body capture, app exception error metadata, and envelope encoding; Node/Python integration covers Host registration, route advertisement, Broker routed request, headers, status, and body preservation. Numeric coverage was not measured because repository coverage tooling is Node-only.
- Manual verification: confirmed by user.
- Phase checkpoint commit: `3c297e2`.

## Phase 3: Streaming Semantics and Parity Coverage

- [x] Task: Write failing streaming tests
    - [x] Test streamed request bodies arriving as ASGI `http.request` events with correct continuation/end semantics.
    - [x] Test streamed response bodies emitted through ASGI `http.response.body` events with `more_body` handling.
    - [x] Test error/cancellation behavior for interrupted request or response streams where feasible.
- [x] Task: Implement bidirectional streaming support
    - [x] Stream request body chunks from Host/Broker routing into the ASGI receive channel without buffering the full body when feasible.
    - [x] Stream ASGI response chunks back through the Host protocol while preserving status and headers ordering requirements.
    - [x] Handle stream completion, cancellation, timeout, and app exception paths with diagnostic errors.
- [x] Task: Add parity and coverage validation
    - [x] Compare Python Guest behavior against key Node Guest semantics for method, path, headers, body, status, response headers, body, and streaming.
    - [x] Confirm meaningful coverage for changed Python behavior is at least 95% or record why coverage cannot be measured.
    - [x] Run the narrowest reliable Python and integration validation commands.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Streaming Semantics and Parity Coverage' (Protocol in workflow.md)

Phase 3 validation notes:
- Failing streaming test confirmation: `npm run test --workspace=@signicode/verser2-guest-python` failed before implementation because chunked request bodies were delivered as one receive event instead of multiple ASGI `http.request` events.
- Implementation: ASGI dispatch now supports request body chunk lists with correct `more_body` continuation semantics; leased transport now starts the ASGI app after request envelope metadata arrives, forwards HTTP/2 DATA chunks into ASGI receive events, and writes ASGI response body chunks back to the lease stream while preserving response envelope ordering.
- Streaming parity: method, path, query string, headers, status, response headers, body, and multi-chunk Broker body preservation were validated through Python unit tests and the Node/Python routed Broker integration test.
- Error/cancellation scope: app exceptions before response start continue to return `local-handler-failure` error envelopes with Guest/request/path context; post-response interruption handling remains minimal and closes the lease response stream when the app raises after response start.
- Validation passed: `npm run test --workspace=@signicode/verser2-guest-python`; `npm run build && npm run stage:packages && node --test test/python-guest-integration.test.js`; `npm run lint --workspace=@signicode/verser2-guest-python`; `npm run lint`.
- Deduplication review: no repeated TypeScript logic was introduced; Python-specific HTTP/2 stream orchestration remains in the Python Guest package, and protocol constants remain the minimal cross-language mirror needed for compatibility.
- Coverage: Phase 3 streaming behavior is covered by focused Python unit tests and a Node/Python integration test. Numeric 95% coverage was not measured because repository coverage tooling is Node-only and the Python package currently uses `unittest` without a coverage dependency.
- Manual verification: confirmed by user.
- Phase checkpoint commit: `3cea4f4`.

## Phase 4: Developer Experience, Examples, and Documentation

- [x] Task: Write failing documentation/example checks
    - [x] Add or update docs tests that expect Python Guest package references, implemented status, and correct Host/Guest/Broker terminology.
    - [x] Add smoke validation for a plain ASGI or FastAPI-compatible example if practical.
    - [x] Confirm docs/example checks fail before documentation and examples are added.
- [x] Task: Implement examples and optional helper API
    - [x] Add a minimal plain ASGI Guest example.
    - [x] Add a FastAPI/Starlette-compatible usage example without requiring FastAPI as a core runtime dependency unless explicitly justified.
    - [x] Add a Python-side request/fetch helper if it fits the first implementation slice; otherwise document it as deferred.
- [x] Task: Update product documentation and package readiness
    - [x] Update README, package docs, and `conductor/tech-stack.md` to describe Python Guest as implemented.
    - [x] Document streaming behavior, known limits, lifecycle behavior, and validation commands.
    - [x] Update package publish/readiness tests and scripts so existing Node package workflows continue to pass with the Python package present.
- [x] Task: Final validation and deduplication review
    - [x] Run the narrowest reliable full-track validation set, including Python package tests/checks and affected npm tests.
    - [x] Perform a phase-end deduplication review and record whether shared protocol code was reused, adapted, copied, or intentionally deferred.
    - [x] Confirm no HTTP/3, authentication/authorization, Python Host, or unrelated runtime behavior was introduced.
- [x] Task: Conductor - User Manual Verification 'Phase 4: Developer Experience, Examples, and Documentation' (Protocol in workflow.md)

Phase 4 validation notes:
- Failing docs/example checks confirmed: `node --test test/python-guest-documentation.test.js` failed before README/package README/tech-stack updates because implemented Python Guest references, `create_verser_guest`, FastAPI-compatible wording, and `uv`/`h2` tech-stack details were missing.
- Documentation updates: README now lists `@signicode/verser2-guest-python` as implemented, includes Python ASGI Guest usage, documents FastAPI-compatible usage, streaming behavior, and current Python Guest limits. Package README now documents commands, `create_verser_guest`, ASGI 3 usage, FastAPI-compatible usage, streaming behavior, and known limits. `conductor/tech-stack.md` now lists the Python ASGI Guest as implemented with `uv` and `h2`.
- Examples: existing plain ASGI example remains, `examples/basic_guest.py` is used by the Node/Python integration test, and package tests smoke-validate the plain ASGI example import surface. Python-side request/fetch helper remains deferred and documented as a known limit.
- Streaming proof: `test/python-guest-integration.test.js` now asserts the Python ASGI Guest can return a response after the first request chunk before the Broker request body ends, and that the Broker can observe the first Python ASGI response body chunk before the response stream ends.
- Validation passed: `node --test test/python-guest-documentation.test.js`; `npm run test --workspace=@signicode/verser2-guest-python`; `npm test`; `npm run build && npm run stage:packages && node --test test/python-guest-integration.test.js`; `npm run lint --workspace=@signicode/verser2-guest-python`; `npm run lint`; `npm run test:package-tarballs`.
- Deduplication review: shared TypeScript protocol code remains in `@signicode/verser-common`; Python mirrors only cross-language constants/envelope behavior needed by the Python runtime. No new HTTP/3, authentication/authorization, Python Host, full Python Broker, or unrelated runtime behavior was introduced.
- Coverage: repository Node tests and Python package tests cover docs, examples, package recognition, ASGI dispatch, streaming, and Node/Python routed integration. Numeric Python coverage remains unmeasured because no Python coverage dependency is configured.
- Manual verification: confirmed by user.

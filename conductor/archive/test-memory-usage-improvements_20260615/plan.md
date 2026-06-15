# Implementation Plan: Test and Memory Usage Improvements

## Phase 1: Track Setup, PR Setup, and Test-First Coverage

- [x] Task: Create the track review surface required by the workflow
    - [x] Create a dedicated track branch before implementation work.
    - [x] Create a GitHub pull request with a TO-BE title and body describing the final intended test and memory-usage improvement state.
    - [x] Record the branch and PR link in this plan: branch `track/test-memory-usage-improvements_20260615`, PR https://github.com/signicode/verser2/pull/23.
- [x] Task: Confirm affected scripts, docs, and test entrypoints
    - [x] Review root `package.json`, `scripts/`, `test/support/`, `docs/development.md`, `docs/common-issues.md`, and CI workflow test commands.
    - [x] Review existing common/test support helpers before adding package-local or script-local helpers.
    - [x] Record baseline full-test and bounded-test behavior using the narrowest reliable command: current `npm test` script builds, stages, and runs `node --test test/*.test.js`; no bounded npm script existed before the added failing assertions.
- [x] Task: Write failing tests/assertions for bounded test command exposure
    - [x] Add or update repository configuration tests to require a first-class bounded-resource npm script.
    - [x] Assert the bounded command uses a 512 MiB Node old-space default.
    - [x] Assert the bounded command preserves build, stage, and Node test execution semantics.
- [x] Task: Write failing tests/assertions for runtime-limit and documentation coverage
    - [x] Add or update docs/config tests for full, targeted, bounded, build, lint, and package-validation command guidance.
    - [x] Add or update docs/config tests for Node, Bun, and Python/`uv` runtime limit caveats.
- [x] Task: Validate Phase 1 narrowly
    - [x] Run the focused tests that were intentionally added or updated and confirm they fail for the expected reason before implementation.
    - [x] Record expected failures and next implementation targets in this plan: `node --test test/workspace.test.js test/docs.test.js` fails because `test:bounded`, `test:bounded:coverage`, `scripts/run-bounded-tests.js`, and the new development-doc guidance are not implemented yet.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Track Setup, PR Setup, and Test-First Coverage' (Protocol in workflow.md)

## Phase 2: Bounded Runner, Low-Risk Speedups, and Guard Tests

- [x] Task: Implement the bounded-resource test path
    - [x] Add the npm-accessible bounded test command.
    - [x] Add a reusable script if needed for maintainable `NODE_OPTIONS`, timeout, focused-file, or diagnostic handling.
    - [x] Ensure the default Node old-space limit is 512 MiB and semi-space behavior is explicit if configured.
    - [x] Preserve full-test flow: build, stage packages, then run `node --test`.
- [x] Task: Account for Bun and Python subprocess behavior
    - [x] Review Bun integration subprocess invocation and existing timeout behavior.
    - [x] Review Python/`uv` subprocess invocation and existing timeout behavior.
    - [x] Add practical timeout/resource-limit handling where safe, or document why hard memory caps are constrained for that runtime.
    - [x] Avoid unsafe low virtual-memory caps on Node/npm wrapper processes.
- [x] Task: Automated review after bounded-runner implementation
    - [x] Run an automated code review focused on script reliability, cross-platform command behavior, timeout handling, and runtime-specific resource-limit caveats.
    - [x] Address in-scope review findings or record why they are deferred.
- [x] Task: Apply low-risk long-test runtime reductions
    - [x] Identify low-risk long-running candidates from current test durations.
    - [x] Add or update assertions before changing behavior where existing tests do not already protect the intended outcome.
    - [x] Parallelize safe sequential packaging or consumer-check loops where isolated and deterministic: intentionally not changed because current package-consumer matrices are simple and deterministic; tarball-mode coverage was reduced instead.
    - [x] Reduce fixed waits or timeout constants only where behavior remains reliable: no broad timeout reductions were applied; the new subprocess helper bounds output and kill behavior.
    - [x] Prefer event-driven waits over timing-only waits where practical and low-risk.
    - [x] Avoid major package-consumer or integration-test architecture rewrites.
- [x] Task: Automated review after long-test reductions
    - [x] Run an automated code review focused on behavioral equivalence, test reliability, and flake risk.
    - [x] Address in-scope review findings or record why they are deferred.
- [x] Task: Write and satisfy flow-control, backpressure, and memory/resource guard tests
    - [x] Add a focused slow-consumer/backpressure test with bounded data size suitable for CI: retained existing Agent/local/Dispatcher/Python backpressure coverage and added bounded child-process output guard coverage for subprocess resource safety.
    - [x] Add a cleanup/resource guard around abort, stream failure, or backpressure-cycle behavior where practical.
    - [x] Prefer deterministic stream or event assertions over fragile timer-only assertions.
    - [x] Review `@signicode/verser-common` and existing package helpers before adding reusable support code.
    - [x] Fix only the smallest in-scope product issue if a guard test reveals one.
    - [x] Preserve Host/Guest/Broker HTTP method, path, header, body, status, response, streaming, and lifecycle semantics.
- [x] Task: Automated review after guard-test work
    - [x] Run an automated code review focused on memory assertions, stream lifecycle correctness, cleanup behavior, and false-positive/flake risk.
    - [x] Address in-scope review findings or record why they are deferred.
- [x] Task: Validate Phase 2 narrowly and broadly as needed
    - [x] Run focused tests for package/script/config assertions: `node --test test/workspace.test.js test/docs.test.js`, `node --test test/package-tarball-tests.test.js`, and `node --test test/child-process-support.test.js` pass.
    - [x] Run affected long-running test files or scripts and compare relevant durations where practical: tarball-mode no longer copies the full source `end-to-end.test.js` and now keeps bounded package-name smoke coverage in `test/package-tarball/behavior.test.cjs`.
    - [x] Run the new guard tests under normal settings: `node --test test/child-process-support.test.js` passes.
    - [x] Run the new guard tests under the bounded-resource path where practical: `npm run test:bounded -- -- test/workspace.test.js test/docs.test.js` passes; full `npm run test:bounded` passes.
    - [x] Run full `npm test` if the changed scope affects the whole validation path: full `npm test` passes.
    - [x] Record validation results, coverage status, and deduplication outcome in this plan: coverage is meaningful via config/docs/subprocess guard/full test coverage; reusable child-process output collection was centralized in `test/support/child-process.cjs`; no product runtime code changed.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Bounded Runner, Low-Risk Speedups, and Guard Tests' (Protocol in workflow.md)

## Phase 3: Documentation, CI Review, and Final Validation

- [x] Task: Update development documentation
    - [x] Document full build/test/lint commands.
    - [x] Document targeted test-file commands after build/stage.
    - [x] Document bounded-resource test commands and 512 MiB Node old-space default.
    - [x] Document Bun and Python/`uv` limit behavior and practical constraints.
    - [x] Document package consumer/tarball validation commands.
    - [x] Document when to use full, focused, bounded, and package-validation commands.
- [x] Task: Review CI integration
    - [x] Confirm GitHub Actions validation remains at least as strong as before.
    - [x] Decide whether CI should call the bounded path or only document it for developer/OOM validation: CI continues using the existing full validation path; the bounded path is documented for developer/OOM validation and can be adopted by CI later if needed.
    - [x] Keep Node 20, Bun integration tests, and `uv` setup compatibility intact.
- [x] Task: Final validation
    - [x] Run focused docs/config tests: `node --test test/workspace.test.js test/docs.test.js test/package-tarball-tests.test.js test/child-process-support.test.js` passes.
    - [x] Run `npm run build` if not already covered by bounded/full validation: covered by `npm run test:bounded` and `npm test`.
    - [x] Run bounded-resource full test command: `npm run test:bounded` passes.
    - [x] Run full `npm test`: passes.
    - [x] Run `npm run lint`: passes.
    - [x] Record validation results, skipped checks, coverage status, and deduplication outcome: default source tests now intentionally skip redundant package-consumer matrix wrappers and the staged-package `npm pack --dry-run` wrapper; package validation remains covered by explicit `npm run test:package-consumers -- --source=source`, `--source=staging`, `--source=tarball`, and `npm run test:package-tarballs` commands, all of which pass. The skipped wrappers remain opt-in inside `node --test` via `VERSER_RUN_PACKAGE_CONSUMER_MATRIX=1` and `VERSER_RUN_PACK_DRY_RUN_TESTS=1`, and the opt-in focused checks pass. Reusable subprocess output/timeout code is centralized in `test/support/child-process.cjs`; CI remains on the existing full path while bounded validation is documented for developer/OOM workflows.
    - [x] Phase checkpoint commit: `48a1b93`.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Documentation, CI Review, and Final Validation' (Protocol in workflow.md)

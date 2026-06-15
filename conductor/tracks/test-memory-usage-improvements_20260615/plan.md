# Implementation Plan: Test and Memory Usage Improvements

## Phase 1: Track Setup, PR Setup, and Test-First Coverage

- [~] Task: Create the track review surface required by the workflow
    - [x] Create a dedicated track branch before implementation work.
    - [ ] Create a GitHub pull request with a TO-BE title and body describing the final intended test and memory-usage improvement state.
    - [ ] Record the branch and PR link in this plan.
- [ ] Task: Confirm affected scripts, docs, and test entrypoints
    - [ ] Review root `package.json`, `scripts/`, `test/support/`, `docs/development.md`, `docs/common-issues.md`, and CI workflow test commands.
    - [ ] Review existing common/test support helpers before adding package-local or script-local helpers.
    - [ ] Record baseline full-test and bounded-test behavior using the narrowest reliable command.
- [ ] Task: Write failing tests/assertions for bounded test command exposure
    - [ ] Add or update repository configuration tests to require a first-class bounded-resource npm script.
    - [ ] Assert the bounded command uses a 512 MiB Node old-space default.
    - [ ] Assert the bounded command preserves build, stage, and Node test execution semantics.
- [ ] Task: Write failing tests/assertions for runtime-limit and documentation coverage
    - [ ] Add or update docs/config tests for full, targeted, bounded, build, lint, and package-validation command guidance.
    - [ ] Add or update docs/config tests for Node, Bun, and Python/`uv` runtime limit caveats.
- [ ] Task: Validate Phase 1 narrowly
    - [ ] Run the focused tests that were intentionally added or updated and confirm they fail for the expected reason before implementation.
    - [ ] Record expected failures and next implementation targets in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Track Setup, PR Setup, and Test-First Coverage' (Protocol in workflow.md)

## Phase 2: Bounded Runner, Low-Risk Speedups, and Guard Tests

- [ ] Task: Implement the bounded-resource test path
    - [ ] Add the npm-accessible bounded test command.
    - [ ] Add a reusable script if needed for maintainable `NODE_OPTIONS`, timeout, focused-file, or diagnostic handling.
    - [ ] Ensure the default Node old-space limit is 512 MiB and semi-space behavior is explicit if configured.
    - [ ] Preserve full-test flow: build, stage packages, then run `node --test`.
- [ ] Task: Account for Bun and Python subprocess behavior
    - [ ] Review Bun integration subprocess invocation and existing timeout behavior.
    - [ ] Review Python/`uv` subprocess invocation and existing timeout behavior.
    - [ ] Add practical timeout/resource-limit handling where safe, or document why hard memory caps are constrained for that runtime.
    - [ ] Avoid unsafe low virtual-memory caps on Node/npm wrapper processes.
- [ ] Task: Automated review after bounded-runner implementation
    - [ ] Run an automated code review focused on script reliability, cross-platform command behavior, timeout handling, and runtime-specific resource-limit caveats.
    - [ ] Address in-scope review findings or record why they are deferred.
- [ ] Task: Apply low-risk long-test runtime reductions
    - [ ] Identify low-risk long-running candidates from current test durations.
    - [ ] Add or update assertions before changing behavior where existing tests do not already protect the intended outcome.
    - [ ] Parallelize safe sequential packaging or consumer-check loops where isolated and deterministic.
    - [ ] Reduce fixed waits or timeout constants only where behavior remains reliable.
    - [ ] Prefer event-driven waits over timing-only waits where practical and low-risk.
    - [ ] Avoid major package-consumer or integration-test architecture rewrites.
- [ ] Task: Automated review after long-test reductions
    - [ ] Run an automated code review focused on behavioral equivalence, test reliability, and flake risk.
    - [ ] Address in-scope review findings or record why they are deferred.
- [ ] Task: Write and satisfy flow-control, backpressure, and memory/resource guard tests
    - [ ] Add a focused slow-consumer/backpressure test with bounded data size suitable for CI.
    - [ ] Add a cleanup/resource guard around abort, stream failure, or backpressure-cycle behavior where practical.
    - [ ] Prefer deterministic stream or event assertions over fragile timer-only assertions.
    - [ ] Review `@signicode/verser-common` and existing package helpers before adding reusable support code.
    - [ ] Fix only the smallest in-scope product issue if a guard test reveals one.
    - [ ] Preserve Host/Guest/Broker HTTP method, path, header, body, status, response, streaming, and lifecycle semantics.
- [ ] Task: Automated review after guard-test work
    - [ ] Run an automated code review focused on memory assertions, stream lifecycle correctness, cleanup behavior, and false-positive/flake risk.
    - [ ] Address in-scope review findings or record why they are deferred.
- [ ] Task: Validate Phase 2 narrowly and broadly as needed
    - [ ] Run focused tests for package/script/config assertions.
    - [ ] Run affected long-running test files or scripts and compare relevant durations where practical.
    - [ ] Run the new guard tests under normal settings.
    - [ ] Run the new guard tests under the bounded-resource path where practical.
    - [ ] Run full `npm test` if the changed scope affects the whole validation path.
    - [ ] Record validation results, coverage status, and deduplication outcome in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Bounded Runner, Low-Risk Speedups, and Guard Tests' (Protocol in workflow.md)

## Phase 3: Documentation, CI Review, and Final Validation

- [ ] Task: Update development documentation
    - [ ] Document full build/test/lint commands.
    - [ ] Document targeted test-file commands after build/stage.
    - [ ] Document bounded-resource test commands and 512 MiB Node old-space default.
    - [ ] Document Bun and Python/`uv` limit behavior and practical constraints.
    - [ ] Document package consumer/tarball validation commands.
    - [ ] Document when to use full, focused, bounded, and package-validation commands.
- [ ] Task: Review CI integration
    - [ ] Confirm GitHub Actions validation remains at least as strong as before.
    - [ ] Decide whether CI should call the bounded path or only document it for developer/OOM validation.
    - [ ] Keep Node 20, Bun integration tests, and `uv` setup compatibility intact.
- [ ] Task: Final validation
    - [ ] Run focused docs/config tests.
    - [ ] Run `npm run build` if not already covered by bounded/full validation.
    - [ ] Run bounded-resource full test command.
    - [ ] Run full `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Record validation results, skipped checks, coverage status, and deduplication outcome.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Documentation, CI Review, and Final Validation' (Protocol in workflow.md)

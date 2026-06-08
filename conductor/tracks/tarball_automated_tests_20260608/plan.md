# Implementation Plan: Automated tarball package test execution

## Phase 1: Baseline audit and red tests for tarball automated testing

- [ ] Task: Audit existing package tests and tarball harnesses
    - [ ] Inspect existing package-readiness scripts, consumer import harnesses, package workflow tests, and GitHub Actions publish workflow.
    - [ ] Classify current tests by feasibility for tarball mode: package export/API shape, common protocol/envelope, consumer import compatibility, lightweight Host/Guest/Broker behavior, and source-internal/end-to-end tests.
    - [ ] Record which tests should run from tarball-installed package names and which remain source-only with reasons.
    - [ ] Review existing common libraries and release-engineering scripts before adding new helpers.
- [ ] Task: Write failing tests for tarball automated test command
    - [ ] Add focused tests that expect a local tarball automated test command/script to exist.
    - [ ] Assert the command packs staged packages, installs tarballs into a temp consumer, and runs automated behavior tests from package names.
    - [ ] Assert the harness reports included and excluded tarball-mode test groups.
- [ ] Task: Write failing workflow tests for tarball automated testing
    - [ ] Assert pull-request validation runs tarball automated tests without publishing.
    - [ ] Assert main/tag publish jobs run tarball automated tests after version mutation and before `npm publish`.
    - [ ] Assert no npmjs publish behavior is introduced.
- [ ] Task: Run narrow failing validation
    - [ ] Run the focused new tests and confirm they fail for the expected missing tarball automated test harness or workflow integration.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Baseline audit and red tests for tarball automated testing' (Protocol in workflow.md)

## Phase 2: Tarball automated test harness

- [ ] Task: Implement tarball package test runner
    - [ ] Add a low-dependency Node/npm script such as `scripts/test-package-tarballs.js`.
    - [ ] Consume existing staged packages, run `npm pack`, install all tarballs into an isolated temp consumer project, and fail with actionable errors when prerequisites are missing.
    - [ ] Ensure tarball-mode tests resolve Verser packages by package name from temp consumer `node_modules`.
- [ ] Task: Adapt feasible automated tests for tarball mode
    - [ ] Add or adapt tests for package export/API shape using installed package names.
    - [ ] Add or adapt common protocol/envelope behavior tests to run against tarball-installed `@signicode/verser-common` where feasible.
    - [ ] Add or adapt lightweight Host/Guest/Broker behavior tests that do not depend on source-only internals.
    - [ ] Preserve existing source/local tests unchanged unless a small resolver abstraction is needed.
- [ ] Task: Report exclusions and limitations
    - [ ] Make the tarball test runner report test groups that are included.
    - [ ] Document source-only exclusions with concise reasons when a test cannot reasonably run from tarballs.
    - [ ] Ensure exclusions do not hide failures in the normal source test suite.
- [ ] Task: Add npm script and local validation
    - [ ] Add `npm run test:package-tarballs` or equivalent.
    - [ ] Run `npm run build && npm run stage:packages && npm run test:package-tarballs`.
    - [ ] Run relevant focused tests for the tarball harness.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Tarball automated test harness' (Protocol in workflow.md)

## Phase 3: GitHub Actions integration for tarball automated tests

- [ ] Task: Update workflow tests for CI ordering and no-publish guarantees
    - [ ] Assert PR workflows run `test:package-tarballs` and do not publish packages.
    - [ ] Assert publish workflows apply the final publish version before running `test:package-tarballs`.
    - [ ] Assert `test:package-tarballs` runs before any `npm publish` command in main/tag jobs.
- [ ] Task: Update GitHub Actions workflow
    - [ ] Add tarball automated tests to pull-request validation after build/stage/pack and before the validation job ends.
    - [ ] Add tarball automated tests to the publish job after staged publish-version mutation and before `npm publish`.
    - [ ] Preserve post-publish GitHub Packages install validation where feasible.
    - [ ] Preserve the explicit no-PR-publish guarantee and npmjs out-of-scope boundary.
- [ ] Task: Validate workflow shape and local scripts
    - [ ] Run static workflow tests.
    - [ ] Run tarball automated tests locally.
    - [ ] Run lint.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: GitHub Actions integration for tarball automated tests' (Protocol in workflow.md)

## Phase 4: Documentation, final validation, and review

- [ ] Task: Update release-engineering documentation
    - [ ] Document the local tarball automated test command and expected prerequisites.
    - [ ] Explain how tarball automated tests differ from import-only consumer checks.
    - [ ] Document pull-request, pre-publish, and post-publish CI behavior.
    - [ ] Document tarball-mode test coverage and source-only exclusions.
- [ ] Task: Run final validation
    - [ ] Run `npm run build`.
    - [ ] Run `npm run stage:packages`.
    - [ ] Run `npm run test:package-tarballs`.
    - [ ] Run focused package workflow and package-readiness tests.
    - [ ] Run `npm test` if changed behavior warrants full validation.
    - [ ] Run `npm run lint`.
    - [ ] Record coverage status for changed behavior or explain why aggregate coverage is not meaningful for release-engineering harnesses.
- [ ] Task: Perform release-readiness review
    - [ ] Confirm tests run against installed tarball package names in temp consumer mode.
    - [ ] Confirm package metadata, tarball installation, workflow ordering, and docs are aligned.
    - [ ] Confirm no secrets, generated artifacts, npmjs publish behavior, or PR publish path are introduced.
    - [ ] Request maintainability/workflow-risk review if needed.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Documentation, final validation, and review' (Protocol in workflow.md)

## Phase Checkpoint Policy

- [ ] Task: Commit only after completing each phase.
    - [ ] Use scoped conventional commit messages.
    - [ ] Include a concise phase summary in commit bodies when useful.
    - [ ] Update this `plan.md` with checkpoint commit SHAs after each phase.
- [ ] Task: Keep the Conductor PR as the review surface for the full track.
    - [ ] Create or use a dedicated Conductor branch and PR before implementation starts.
    - [ ] Ensure the PR title and description describe the intended fully implemented tarball automated-test state, not only planning artifacts.

# Implementation Plan: Automated tarball package test execution

## Phase 1: Baseline audit and red tests for tarball automated testing

- [x] Task: Audit existing package tests and tarball harnesses
    - [x] Inspect existing package-readiness scripts, consumer import harnesses, package workflow tests, and GitHub Actions publish workflow.
    - [x] Classify current tests by feasibility for tarball mode: package export/API shape, common protocol/envelope, consumer import compatibility, lightweight Host/Guest/Broker behavior, and source-internal/end-to-end tests.
    - [x] Record which tests should run from tarball-installed package names and which remain source-only with reasons.
    - [x] Review existing common libraries and release-engineering scripts before adding new helpers.

      Audit notes: `scripts/test-package-consumers.js` already packs staged packages for import-only checks and can be reused as a model, but it does not run behavior tests. Feasible tarball-mode groups are package import/export shape, selected `@signicode/verser-common` protocol/envelope helpers, and lightweight Host/Guest/Broker behavior through public package entrypoints. Workflow, publish-readiness, version-policy, docs, workspace metadata, source-internal, and full end-to-end/streaming suites remain source-only because they inspect repository files, staged metadata, workflow YAML, or broad integration behavior rather than installed package entrypoints. Common libraries were reviewed; this release-engineering harness is package/test-specific and does not need new common runtime exports.
- [x] Task: Write failing tests for tarball automated test command
    - [x] Add focused tests that expect a local tarball automated test command/script to exist.
    - [x] Assert the command packs staged packages, installs tarballs into a temp consumer, and runs automated behavior tests from package names.
    - [x] Assert the harness reports included and excluded tarball-mode test groups.
- [x] Task: Write failing workflow tests for tarball automated testing
    - [x] Assert pull-request validation runs tarball automated tests without publishing.
    - [x] Assert main/tag publish jobs run tarball automated tests after version mutation and before `npm publish`.
    - [x] Assert no npmjs publish behavior is introduced.
- [x] Task: Run narrow failing validation
    - [x] Run the focused new tests and confirm they fail for the expected missing tarball automated test harness or workflow integration.

      Red validation: `node --test test/package-tarball-tests.test.js test/package-workflow.test.js` failed as expected because `test:package-tarballs` and `scripts/test-package-tarballs.js` do not exist yet, and the workflow does not yet run `npm run test:package-tarballs` before no-publish confirmation or before `npm publish`.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Baseline audit and red tests for tarball automated testing' (Protocol in workflow.md)

  Manual verification: user approved moving to Phase 2 after the expected red test failures.

  Phase checkpoint commit: `d557dae`.

## Phase 2: Tarball automated test harness

- [x] Task: Implement tarball package test runner
    - [x] Add a low-dependency Node/npm script such as `scripts/test-package-tarballs.js`.
    - [x] Consume existing staged packages, run `npm pack`, install all tarballs into an isolated temp consumer project, and fail with actionable errors when prerequisites are missing.
    - [x] Ensure tarball-mode tests resolve Verser packages by package name from temp consumer `node_modules`.
- [x] Task: Adapt feasible automated tests for tarball mode
    - [x] Add or adapt tests for package export/API shape using installed package names.
    - [x] Add or adapt common protocol/envelope behavior tests to run against tarball-installed `@signicode/verser-common` where feasible.
    - [x] Add or adapt lightweight Host/Guest/Broker behavior tests that do not depend on source-only internals.
    - [x] Preserve existing source/local tests unchanged unless a small resolver abstraction is needed.
- [x] Task: Report exclusions and limitations
    - [x] Make the tarball test runner report test groups that are included.
    - [x] Document source-only exclusions with concise reasons when a test cannot reasonably run from tarballs.
    - [x] Ensure exclusions do not hide failures in the normal source test suite.
- [x] Task: Add npm script and local validation
    - [x] Add `npm run test:package-tarballs` or equivalent.
    - [x] Run `npm run build && npm run stage:packages && npm run test:package-tarballs`.
    - [x] Run relevant focused tests for the tarball harness.

      Validation: `node --test test/package-tarball-tests.test.js` passed after fixing a session-introduced brittle static assertion. `npm run build && npm run stage:packages && npm run test:package-tarballs` passed; after user feedback, the runner was revised to copy the checked-in `test/package-tarball/behavior.test.cjs` loader target instead of generating test code strings, and `node --test test/package-tarball-tests.test.js` plus `npm run test:package-tarballs` passed again. Coverage note: changed behavior is a release-engineering harness exercised by focused static tests plus the harness's own copied Node test groups in the temporary consumer; aggregate coverage is not meaningful for the spawned temporary consumer process. Deduplication: existing consumer-tarball packing patterns were reused conceptually, but no common runtime code was added because the harness is release-engineering/test-specific.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Tarball automated test harness' (Protocol in workflow.md)

  Manual verification: user requested replacing generated test-code strings with a checked-in loader target, then approved moving to Phase 3 after that revision passed focused validation.

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

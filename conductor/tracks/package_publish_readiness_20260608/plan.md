# Implementation Plan: Package buildability and publish readiness

## Phase 1: Baseline package audit and failing staging tests

- [x] Task: Audit current package build and publish metadata
    - [x] Inspect root and workspace `package.json` files, TypeScript configs, tsup configs, package entrypoints, generated declaration paths, and `.gitignore` behavior.
    - [x] Record required publish fields for `@signicode/verser-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node`.
    - [x] Confirm whether existing package names are compatible with GitHub Packages scoped npm publishing.
    - [x] Review existing common libraries and scripts before adding package-local release helpers.
- [x] Task: Write failing staging metadata tests
    - [x] Add tests that expect a central staged package tree under `dist/packages`.
    - [x] Add tests that verify staged package metadata keeps publish-critical fields and removes scripts, test commands, dev-only fields, and workspace-only settings.
    - [x] Add tests that fail when built JavaScript or declaration files are missing from a staged package.
- [x] Task: Write failing package packing tests
    - [x] Add focused tests or validation helpers that run `npm pack --dry-run` or equivalent against staged packages.
    - [x] Assert that packable contents include built entrypoints and declarations and exclude generated test/dev-only files.
- [x] Task: Run narrow failing validation
    - [x] Run the smallest relevant test command and confirm new tests fail for the expected missing staging behavior.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Baseline package audit and failing staging tests' (Protocol in workflow.md)

### Phase 1 validation notes

- Existing workspaces audited: `@signicode/verser-common`, `@signicode/verser2-guest-js-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node` all build CommonJS `dist/index.js` and `dist/index.d.ts` artifacts with inline `tsup` plus `dts-bundle-generator` scripts.
- Package names are scoped and compatible with GitHub Packages npm publishing, but source manifests are currently `private: true` and include development build scripts that must be omitted from staged publish manifests.
- Phase-start common-code review: no reusable runtime common code is needed for Phase 1; package readiness checks are test-only release engineering scaffolding.
- Failing validation command: `npm run build && node --test test/package-publish-readiness.test.js`.
- Expected failure: `dist/packages/signicode-verser-common` and other staged package directories do not exist yet. This is the intended Phase 1 red test for Phase 2 implementation.
- Coverage note: behavior is test scaffolding for missing release artifacts; meaningful coverage will be assessed after implementation phases make the tests pass.

## Phase 2: Central staging implementation

- [x] Task: Implement package staging command
    - [x] Add a low-dependency Node/npm staging script that builds or consumes existing package `dist/` output and writes staged packages to `dist/packages`.
    - [x] Preserve existing per-package build output and avoid committing generated staging artifacts.
    - [x] Fail with actionable errors when required build output, package metadata, README, LICENSE, or declaration files are missing.
- [x] Task: Implement publish-only `package.json` generation
    - [x] Generate staged metadata using a publish-field allowlist or equivalent publish-only transform.
    - [x] Preserve `name`, `version`, `description`, `license`, `repository`, `main`, `types`, `exports`, runtime dependencies, and package manager-compatible consumer metadata.
    - [x] Remove scripts, tests, development-only metadata, workspace-only configuration, and unnecessary local fields.
    - [x] Rewrite internal workspace dependencies to publishable package versions where needed.
- [x] Task: Align staged entrypoints and declaration paths
    - [x] Ensure `main`, `types`, and `exports` resolve correctly from each staged package directory.
    - [x] Preserve CommonJS package behavior while allowing ESM consumers to import the CommonJS entrypoint.
    - [x] Verify declaration files reference accessible paths after staging and packing.
- [x] Task: Pass staging and packing tests
    - [x] Run the narrowest staging and packing validation.
    - [x] Update docs or inline script help for staging command usage.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Central staging implementation' (Protocol in workflow.md)

### Phase 2 validation notes

- Added `scripts/stage-packages.js` and root `npm run stage:packages` to stage publish-ready packages into `dist/packages/<safe-package-name>` after `npm run build`.
- Staged manifests retain publish-critical consumer fields and omit source-only fields including `private`, `scripts`, `devDependencies`, and `workspaces`.
- Staged package `exports` point CommonJS and type consumers to `./dist/index.js` and `./dist/index.d.ts`.
- Phase common-code review and deduplication: no reusable runtime common code emerged; the staging script is release-engineering tooling and centralizes repeated package staging behavior in one script.
- Validation passed: `npm run build && npm run stage:packages && node --test test/package-publish-readiness.test.js`.
- Lint passed after formatting fix: `npm run lint`.
- Coverage note: this phase adds script behavior covered by focused node:test checks; aggregate coverage is deferred to final validation.

## Phase 3: Consumer source selection and import compatibility tests

- [x] Task: Write failing consumer matrix tests
    - [x] Add test fixtures or generated temporary consumers for CommonJS `require`, ESM `.mjs` import, and TypeScript import/type-check.
    - [x] Cover all current packages: `@signicode/verser-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node`.
    - [x] Add source-target selection for workspace source, central staged directories, packed tarballs, and GitHub Packages installs.
- [x] Task: Implement source-targeted test harness
    - [x] Add npm scripts or test helpers to select package source via documented environment variable or CLI argument.
    - [x] Install or link packages into an isolated temporary consumer project for staged, tarball, and GitHub Packages modes.
    - [x] Keep tests deterministic and avoid requiring network access except for explicit GitHub Packages mode.
- [x] Task: Implement TypeScript consumer validation
    - [x] Add a minimal TypeScript consumer compile/type-check path using the repo's npm/TypeScript tooling.
    - [x] Confirm emitted declarations are usable by TypeScript consumers.
- [x] Task: Pass consumer import matrix validation
    - [x] Run local source, staging, and tarball modes.
    - [x] Document how to run GitHub Packages mode when authenticated packages are available.
    - [x] Record any network/auth-dependent validation as skipped unless credentials are present.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Consumer source selection and import compatibility tests' (Protocol in workflow.md)

### Phase 3 validation notes

- Added `scripts/test-package-consumers.js` and root `npm run test:package-consumers` to validate package consumption from `source`, `staging`, `tarball`, and optional `github` modes.
- Added `test/package-consumer-imports.test.js` to cover CommonJS `require`, ESM `.mjs` import, and TypeScript import/type-check for all current packages.
- GitHub Packages mode is intentionally gated by `VERSER_RUN_GITHUB_CONSUMER_TESTS=1` and a package token; without that explicit opt-in it exits successfully with a skip report, keeping default tests network-free.
- Phase common-code review and deduplication: no runtime common code reuse was needed; repeated consumer setup is centralized in one release-engineering harness script.
- Validation passed: `npm run build && npm run stage:packages && npm run test:package-consumers -- --source=source && npm run test:package-consumers -- --source=staging && npm run test:package-consumers -- --source=tarball && node --test test/package-consumer-imports.test.js && npm run lint`.
- Coverage note: consumer import and type-check behavior is covered by focused node:test checks; aggregate coverage remains deferred to final validation.

## Phase 4: Versioning and dist-tag scripts

- [x] Task: Write failing version policy tests
    - [x] Add tests for stable vs prerelease dist-tag selection.
    - [x] Add tests for deterministic main-merge `<current-version>-sha` package version derivation.
    - [x] Add tests or dry-run checks that prevent accidental npmjs publishing during this track.
- [x] Task: Implement version helper scripts
    - [x] Add low-dependency npm/Node scripts for determining publish tag (`latest` or `next`) from package version.
    - [x] Add deterministic main-build version handling for GitHub Packages using the current version and commit SHA.
    - [x] Keep package version mutation scoped to staging or CI-safe generated artifacts unless an explicit version bump command is run.
- [x] Task: Document version bump and tag usage
    - [x] Document stable version, prerelease version, `latest`, `next`, and main-build GitHub Packages behavior.
    - [x] Explain the future npmjs publish path without executing npmjs publish in this track.
- [x] Task: Pass versioning validation
    - [x] Run the narrowest version helper tests and staging validation.
- [x] Task: Conductor - User Manual Verification 'Phase 4: Versioning and dist-tag scripts' (Protocol in workflow.md)

### Phase 4 validation notes

- Added `scripts/package-version-policy.js` and `npm run package:version-policy` with a `--version` CLI,
  optional `--main-build/--sha`, `--apply-staged`, and `--json` output.
- Added `test/package-version-policy.test.js` for stable/latest, prerelease/next, deterministic SHA versions,
  invalid inputs, staged manifest updates, and npmjs publish prohibition checks.
- Documented stable/prerelease dist-tag behavior, main-build SHA versions, staged-only version mutation, and the npmjs publishing boundary in `docs/package-publishing.md`.
- Validation passed: `node --test test/package-version-policy.test.js && npm run build && npm run stage:packages && npm run package:version-policy -- --version 1.2.3 --json && npm run package:version-policy -- --version 1.2.3-next.0 --json && npm run lint`.
- Phase common-code review and deduplication: no runtime common code reuse was needed; versioning behavior is centralized in one release-engineering helper.
- Coverage note: version policy behavior is covered by focused unit tests; aggregate coverage remains deferred to final validation.

## Phase 5: GitHub Actions package workflow

- [x] Task: Write workflow validation expectations
    - [x] Add static validation or documentation checks for required workflow permissions, registry URL, scope, and `NODE_AUTH_TOKEN` usage.
    - [x] Confirm workflow does not commit generated `dist/` artifacts or registry tokens.
- [x] Task: Add GitHub Packages workflow
    - [x] Add a workflow for main/tag events that installs with npm, builds, stages, packs, runs local package-consumer tests, publishes to GitHub Packages, and validates GitHub Packages installs when credentials and event context allow.
    - [x] Use GitHub Packages-compatible scoped npm registry configuration and `packages: write` permissions.
    - [x] Implement the selected main/tag version policy, including `<current-version>-sha` main builds and `latest`/`next` tags for stable/prerelease versions.
    - [x] Avoid npmjs publish execution.
- [x] Task: Validate workflow shape locally
    - [x] Run lint/static checks and any workflow-related tests that can run locally.
    - [x] Document manual validation steps for the first GitHub Packages publish.
- [x] Task: Conductor - User Manual Verification 'Phase 5: GitHub Actions package workflow' (Protocol in workflow.md)

### Phase 5 validation notes

- Added workflow validation test `test/package-workflow.test.js` for required triggers, permissions, registry/scope/auth configuration, version-policy usage, local pack/consume validation, GitHub Packages publish target, and skipped npmjs publish checks.
- Added `./github/workflows/package-publish.yml` for pull request validation and main/tag publish flows.
- Documented workflow behavior and manual publish validation steps in `docs/package-publishing.md`.
- Validation passed: `node --test test/package-workflow.test.js && npm run lint && npm run build && npm run stage:packages && npm run package:version-policy -- --version 0.0.0 --main-build --sha abcdef123456`.
- Phase common-code review and deduplication: no runtime common code reuse was needed; workflow validation is centralized in static workflow tests and release-engineering scripts.
- Coverage note: workflow behavior is covered by static node:test checks; aggregate coverage remains deferred to final validation.
- Manual GitHub Actions publish verification remains user-visible and intentionally unchecked.

## Phase 6: Documentation, final validation, and review

- [x] Task: Update release engineering documentation
    - [x] Document local build, central staging, `npm pack`, source/staging/tarball/GitHub Packages consumer tests, versioning, dist-tags, and GitHub Packages authentication.
    - [x] Keep documentation tutorial-friendly and precise, without implying runtime Host/Guest/Broker API or protocol behavior changes.
- [x] Task: Run final validation
    - [x] Run `npm run build`.
    - [x] Run focused package staging, packing, versioning, and consumer matrix tests.
    - [x] Run `npm test` if the changed behavior warrants full test coverage confirmation.
    - [x] Run `npm run lint`.
    - [x] Record coverage status for changed behavior or explain why coverage cannot be measured meaningfully for script/workflow changes.
- [x] Task: Perform release-readiness review
    - [x] Confirm common libraries were scanned and no reusable runtime code was duplicated.
    - [x] Confirm package metadata, declarations, registry configuration, and docs are aligned.
    - [x] Confirm npmjs publish remains out of scope and no secrets or generated artifacts are committed.
    - [x] Request code review for maintainability, YAGNI, and workflow risk if needed.
- [x] Task: Conductor - User Manual Verification 'Phase 6: Documentation, final validation, and review' (Protocol in workflow.md)

### Phase 6 validation notes

- Updated `docs/package-publishing.md` with local staging, packing, source/staging/tarball/GitHub Packages consumer test commands, versioning, dist-tags, and authentication behavior.
- Updated default `npm test` and `npm run test:coverage` to run `npm run stage:packages` after build so package-readiness tests are clean-checkout safe.
- Fixed release-readiness review blockers by rewriting internal staged dependency versions during `--apply-staged` and validating versioned staged/tarball consumers before publish.
- Validation passed: `npm run build && npm run stage:packages && node --test test/package-publish-readiness.test.js test/package-version-policy.test.js test/package-workflow.test.js && npm run test:package-consumers -- --source=source && npm run test:package-consumers -- --source=staging && npm run test:package-consumers -- --source=tarball && npm test && npm run lint`.
- Coverage command passed: `npm run test:coverage`. Aggregate coverage is not meaningful for this release-engineering track because Node's report includes generated `dist/` artifacts and subprocess-driven helper scripts; focused changed-behavior tests cover staging, pack dry-run readiness, consumer import modes, version policy, workflow safety, and docs/workspace script expectations.
- Final @oracle review found no remaining blockers and confirmed Phase 6 can reasonably complete after validation.
- Phase common-code review and deduplication: no reusable runtime common code was added or duplicated; release-engineering behavior is centralized in `scripts/` helpers and static tests.

## Phase Checkpoint Policy

- Phase 1 checkpoint commit: `5635fd0`
- Phase 2 checkpoint commit: `e2b92e4`
- Phase 3 checkpoint commit: `1c998f3`
- Phase 4 checkpoint commit: `4733dba`
- Phase 5 checkpoint commit: `6f7ca2f`

- [ ] Task: Commit only after completing each phase.
    - [ ] Use scoped conventional commit messages.
    - [ ] Include a concise phase summary in commit bodies when useful.
    - [ ] Update this `plan.md` with checkpoint commit SHAs after each phase.
- [ ] Task: Keep the Conductor PR as the review surface for the full track.
    - [ ] Create the track branch and PR before implementation starts.
    - [ ] Ensure the PR title and description describe the intended fully implemented package publish-readiness state, not only planning artifacts.

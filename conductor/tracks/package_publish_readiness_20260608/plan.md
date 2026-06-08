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

- [ ] Task: Implement package staging command
    - [ ] Add a low-dependency Node/npm staging script that builds or consumes existing package `dist/` output and writes staged packages to `dist/packages`.
    - [ ] Preserve existing per-package build output and avoid committing generated staging artifacts.
    - [ ] Fail with actionable errors when required build output, package metadata, README, LICENSE, or declaration files are missing.
- [ ] Task: Implement publish-only `package.json` generation
    - [ ] Generate staged metadata using a publish-field allowlist or equivalent publish-only transform.
    - [ ] Preserve `name`, `version`, `description`, `license`, `repository`, `main`, `types`, `exports`, runtime dependencies, and package manager-compatible consumer metadata.
    - [ ] Remove scripts, tests, development-only metadata, workspace-only configuration, and unnecessary local fields.
    - [ ] Rewrite internal workspace dependencies to publishable package versions where needed.
- [ ] Task: Align staged entrypoints and declaration paths
    - [ ] Ensure `main`, `types`, and `exports` resolve correctly from each staged package directory.
    - [ ] Preserve CommonJS package behavior while allowing ESM consumers to import the CommonJS entrypoint.
    - [ ] Verify declaration files reference accessible paths after staging and packing.
- [ ] Task: Pass staging and packing tests
    - [ ] Run the narrowest staging and packing validation.
    - [ ] Update docs or inline script help for staging command usage.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Central staging implementation' (Protocol in workflow.md)

## Phase 3: Consumer source selection and import compatibility tests

- [ ] Task: Write failing consumer matrix tests
    - [ ] Add test fixtures or generated temporary consumers for CommonJS `require`, ESM `.mjs` import, and TypeScript import/type-check.
    - [ ] Cover all current packages: `@signicode/verser-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node`.
    - [ ] Add source-target selection for workspace source, central staged directories, packed tarballs, and GitHub Packages installs.
- [ ] Task: Implement source-targeted test harness
    - [ ] Add npm scripts or test helpers to select package source via documented environment variable or CLI argument.
    - [ ] Install or link packages into an isolated temporary consumer project for staged, tarball, and GitHub Packages modes.
    - [ ] Keep tests deterministic and avoid requiring network access except for explicit GitHub Packages mode.
- [ ] Task: Implement TypeScript consumer validation
    - [ ] Add a minimal TypeScript consumer compile/type-check path using the repo's npm/TypeScript tooling.
    - [ ] Confirm emitted declarations are usable by TypeScript consumers.
- [ ] Task: Pass consumer import matrix validation
    - [ ] Run local source, staging, and tarball modes.
    - [ ] Document how to run GitHub Packages mode when authenticated packages are available.
    - [ ] Record any network/auth-dependent validation as skipped unless credentials are present.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Consumer source selection and import compatibility tests' (Protocol in workflow.md)

## Phase 4: Versioning and dist-tag scripts

- [ ] Task: Write failing version policy tests
    - [ ] Add tests for stable vs prerelease dist-tag selection.
    - [ ] Add tests for deterministic main-merge `<current-version>-sha` package version derivation.
    - [ ] Add tests or dry-run checks that prevent accidental npmjs publishing during this track.
- [ ] Task: Implement version helper scripts
    - [ ] Add low-dependency npm/Node scripts for determining publish tag (`latest` or `next`) from package version.
    - [ ] Add deterministic main-build version handling for GitHub Packages using the current version and commit SHA.
    - [ ] Keep package version mutation scoped to staging or CI-safe generated artifacts unless an explicit version bump command is run.
- [ ] Task: Document version bump and tag usage
    - [ ] Document stable version, prerelease version, `latest`, `next`, and main-build GitHub Packages behavior.
    - [ ] Explain the future npmjs publish path without executing npmjs publish in this track.
- [ ] Task: Pass versioning validation
    - [ ] Run the narrowest version helper tests and staging validation.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Versioning and dist-tag scripts' (Protocol in workflow.md)

## Phase 5: GitHub Actions package workflow

- [ ] Task: Write workflow validation expectations
    - [ ] Add static validation or documentation checks for required workflow permissions, registry URL, scope, and `NODE_AUTH_TOKEN` usage.
    - [ ] Confirm workflow does not commit generated `dist/` artifacts or registry tokens.
- [ ] Task: Add GitHub Packages workflow
    - [ ] Add a workflow for main/tag events that installs with npm, builds, stages, packs, runs local package-consumer tests, publishes to GitHub Packages, and validates GitHub Packages installs when credentials and event context allow.
    - [ ] Use GitHub Packages-compatible scoped npm registry configuration and `packages: write` permissions.
    - [ ] Implement the selected main/tag version policy, including `<current-version>-sha` main builds and `latest`/`next` tags for stable/prerelease versions.
    - [ ] Avoid npmjs publish execution.
- [ ] Task: Validate workflow shape locally
    - [ ] Run lint/static checks and any workflow-related tests that can run locally.
    - [ ] Document manual validation steps for the first GitHub Packages publish.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: GitHub Actions package workflow' (Protocol in workflow.md)

## Phase 6: Documentation, final validation, and review

- [ ] Task: Update release engineering documentation
    - [ ] Document local build, central staging, `npm pack`, source/staging/tarball/GitHub Packages consumer tests, versioning, dist-tags, and GitHub Packages authentication.
    - [ ] Keep documentation tutorial-friendly and precise, without implying runtime Host/Guest/Broker API or protocol behavior changes.
- [ ] Task: Run final validation
    - [ ] Run `npm run build`.
    - [ ] Run focused package staging, packing, versioning, and consumer matrix tests.
    - [ ] Run `npm test` if the changed behavior warrants full test coverage confirmation.
    - [ ] Run `npm run lint`.
    - [ ] Record coverage status for changed behavior or explain why coverage cannot be measured meaningfully for script/workflow changes.
- [ ] Task: Perform release-readiness review
    - [ ] Confirm common libraries were scanned and no reusable runtime code was duplicated.
    - [ ] Confirm package metadata, declarations, registry configuration, and docs are aligned.
    - [ ] Confirm npmjs publish remains out of scope and no secrets or generated artifacts are committed.
    - [ ] Request code review for maintainability, YAGNI, and workflow risk if needed.
- [ ] Task: Conductor - User Manual Verification 'Phase 6: Documentation, final validation, and review' (Protocol in workflow.md)

## Phase Checkpoint Policy

- [ ] Task: Commit only after completing each phase.
    - [ ] Use scoped conventional commit messages.
    - [ ] Include a concise phase summary in commit bodies when useful.
    - [ ] Update this `plan.md` with checkpoint commit SHAs after each phase.
- [ ] Task: Keep the Conductor PR as the review surface for the full track.
    - [ ] Create the track branch and PR before implementation starts.
    - [ ] Ensure the PR title and description describe the intended fully implemented package publish-readiness state, not only planning artifacts.

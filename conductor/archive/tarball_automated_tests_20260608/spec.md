# Specification: Automated tarball package test execution

## Overview

Extend the package publish-readiness workflow so built package tarballs are tested with automated behavior tests, not only import probes. The repository should be able to build workspace packages, stage publish-ready artifacts, pack them into `.tgz` tarballs, install those tarballs into an isolated consumer environment, and run all feasible automated tests against the installed package entrypoints.

This track strengthens confidence that packages produced by `npm pack` work as consumers will use them, before any GitHub Packages publish occurs. Pull-request workflows must validate package buildability and tarball testability without publishing packages.

## Track Type

Feature / release-engineering test infrastructure.

## Goals

- Add a local command that builds/stages/packs package tarballs and runs automated tests against installed tarball packages.
- Use a temporary consumer project for non-local package modes so tests import packages by package name from `node_modules`, not source-relative paths.
- Run all feasible existing automated tests against tarball-installed packages, adapting or selecting tests where source-relative internals, repo fixtures, or non-package files make direct reuse impractical.
- Keep existing source/local test behavior intact.
- Update GitHub Actions so pull requests run tarball automated tests but never publish packages.
- Update GitHub Actions so main/tag publish flows run tarball automated tests after applying publish versions and before GitHub Packages publish.
- Preserve existing post-publish GitHub Packages install validation where feasible.

## Functional Requirements

1. Tarball automated test command
   - Add an npm script such as `npm run test:package-tarballs`.
   - The command must consume staged packages, run `npm pack`, install all generated tarballs into an isolated temp consumer project, and execute automated tests from that installed package environment.
   - The command must fail clearly when required build artifacts, staged packages, tarballs, package installs, or test fixtures are missing.

2. Package resolution model
   - Tests running in tarball mode must resolve Verser packages by package name from the temp consumer's `node_modules`.
   - Source/local tests may continue using existing repo-relative imports unless intentionally adapted.
   - The test harness should support local repo mode and temp consumer mode where useful, but non-local package modes must use the temp consumer approach.

3. Test coverage scope
   - Run all feasible existing tests against tarball-installed packages.
   - At minimum, cover package export/API shape tests, common protocol/envelope behavior, consumer import compatibility, and lightweight Host/Guest/Broker behavior that can run without source-only internals.
   - If an existing test cannot reasonably run from package tarballs, document why it is excluded and keep it covered by normal source tests.
   - Do not require every full end-to-end, streaming, or source-internal test to be ported when it depends on repo-relative implementation details or non-package fixtures.

4. GitHub Actions integration
   - Pull-request workflows must build, stage, pack, install tarballs, and run automated tarball tests without publishing any package to GitHub Packages.
   - Main/tag publish workflows must run automated tarball tests after the final publish version is applied to staged package manifests and before `npm publish`.
   - Post-publish GitHub Packages validation should remain available where credentials and event context allow.
   - Static workflow tests must assert that PRs do not publish and that tarball automated tests run before publish.

5. Documentation
   - Document the local tarball automated test command and how it differs from import-only consumer checks.
   - Document CI behavior for pull requests, pre-publish main/tag runs, and post-publish validation.
   - Document any test exclusions or limitations for tarball mode.

## Non-Functional Requirements

- Use npm only.
- Keep using Node.js built-in `node:test`; do not introduce a new test framework.
- Avoid hardcoded secrets and do not commit generated `dist/`, tarballs, or temp consumer artifacts.
- Preserve public Host, Guest, Broker, and common package APIs.
- Preserve the no-PR-publish guarantee.
- Keep npmjs publishing out of scope.
- Prefer low-dependency Node scripts and reuse existing package-readiness helpers where practical.

## Acceptance Criteria

- A local command runs automated tests against installed tarball packages.
- Tarball-mode tests import Verser packages by package name from a temp consumer install.
- The harness documents and reports any tests excluded from tarball mode.
- Pull-request GitHub Actions run tarball automated tests and do not publish packages.
- Main/tag publish workflows run tarball automated tests after publish-version mutation and before GitHub Packages publish.
- Static workflow tests cover the no-PR-publish and pre-publish tarball-test ordering guarantees.
- `npm run lint` and the relevant focused package/tarball tests pass.

## Out of Scope

- Changing public runtime APIs for Host, Guest, Broker, or common package consumers.
- Replacing Node's built-in `node:test` with another framework.
- Changing the no-PR-publish guarantee.
- Publishing to npmjs.
- Requiring every existing full end-to-end or streaming test to run from tarballs if doing so requires source-internal access or disproportionate fixture rewrites.

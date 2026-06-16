# Specification: GitHub Action workflow corrections

## Overview

Correct the package validation and publishing GitHub Actions workflow so release automation distinguishes between pull request validation, merged-PR SHA package publication, scheduled nightly publication, explicit GitHub tag releases, and manual npmjs publication. The workflow should avoid build/test work for Conductor-only changes, keep ordinary release paths intentional, and prevent lower-priority builds from accidentally advancing release channels.

## Functional Requirements

1. Pull request validation
   - Pull requests to the current base branch should run package build/test validation only for relevant package-affecting changes.
   - Source/package/test/workflow changes should trigger validation.
   - Release-engineering documentation changes, such as release/package publishing procedure docs, should trigger validation because they describe the workflow being tested.
   - Conductor-only changes under `conductor/**` should not run package build/test validation.

2. Merged pull request SHA publication
   - A pull request merged into the base branch should publish deterministic SHA-versioned GitHub Packages only when the merged PR changed source/package/test/workflow files.
   - Documentation-only changes should not publish SHA packages except for release-engineering documentation if the final implementation treats it as workflow-triggering validation only.
   - Conductor-only changes should not publish packages.
   - SHA packages must use a non-channel dist-tag, such as a SHA-specific or main-SHA tag, and must not advance `latest` or `next`.

3. Scheduled nightly publication
   - Add a scheduled nightly GitHub Packages publication path.
   - Nightly publication should build, stage, validate, and publish deterministic nightly semver versions under a `nightly` dist-tag.
   - Nightly publication should run independently of whether the most recent repository changes would normally trigger validation.
   - Nightly publication must not advance `latest` or `next`.

4. Explicit GitHub tag releases
   - `v*` GitHub tag pushes remain the authoritative automatic release path for GitHub Packages.
   - Stable semver tags such as `v0.5.0` should publish GitHub Packages and advance the GitHub Packages `latest` channel.
   - Prerelease semver tags such as `v0.5.0-rc.1` should publish GitHub Packages and advance the GitHub Packages `next` channel.
   - Tag release publishing must validate staged/tarball consumers before publishing.

5. npmjs publication policy
   - npmjs publication must remain manual.
   - Manual npmjs publication should consume an explicitly selected version that is already available and validated in GitHub Packages.
   - The automated GitHub Actions package publish workflow must not publish to npmjs.org.

6. Version and dist-tag policy
   - Extend or refactor package version policy code so it can describe publish kind: tag release, merged-PR SHA build, nightly build, and manual npmjs publish candidate.
   - Stable tag releases map to `latest` for GitHub Packages.
   - Prerelease tag releases map to `next` for GitHub Packages.
   - SHA and nightly builds map to non-channel dist-tags and must not move `latest` or `next`.
   - npmjs `latest`/`next` advancement is manual and out of scope for automatic workflow mutation.

7. Documentation
   - Update `docs/release-procedure.md` to describe the branch/PR workflow, manual gates, Copilot review/comment fetching through `gh`, PR merge flow, merged-PR SHA publishing, scheduled nightlies, explicit tag releases, GitHub Packages channel advancement, and manual npmjs publication from validated GitHub package versions.
   - Update any package-publishing documentation or tech-stack notes if workflow behavior changes make existing statements inaccurate.

## Non-Functional Requirements

- Preserve the repository's npm workspace and GitHub Packages publishing model.
- Keep all GitHub Actions publishing permissions scoped to the minimum required job paths.
- Keep pull request workflows non-publishing.
- Keep Conductor-only changes inexpensive by skipping build/test/publish automation.
- Use npm commands for validation and release-engineering scripts.
- Do not introduce npmjs automatic publishing.

## Acceptance Criteria

- Conductor-only pull requests do not run package build/test/publish jobs.
- Source/package/test/workflow pull requests still run package validation.
- Release procedure or package publishing documentation changes run the validation needed to protect documented workflow behavior.
- Merged source/package/test/workflow PRs can publish SHA-versioned GitHub Packages without moving `latest` or `next`.
- Nightly scheduled runs publish nightly GitHub Packages under a nightly tag without moving `latest` or `next`.
- `v*` GitHub tag releases publish GitHub Packages and automatically choose `latest` for stable semver or `next` for prerelease semver.
- npmjs publishing remains manual and references an already validated GitHub Packages version.
- Workflow tests cover the trigger, publish-kind, version, and dist-tag behavior.
- `docs/release-procedure.md` documents the updated workflow accurately.

## Out of Scope

- Publishing packages automatically to npmjs.org.
- Changing package names, public APIs, Host/Guest/Broker runtime behavior, or transport semantics.
- Enabling HTTP/3, browser, Rust, Go, Java, or Python Host support.
- Changing repository branch protection or organization-level GitHub settings.
- Replacing GitHub Packages as the primary automated package registry.

# Implementation Plan: GitHub Action workflow corrections

## Phase 1: Track branch, PR surface, and workflow behavior inventory

- [ ] Task: Create track branch and PR review surface
    - [ ] Record the current branch as the PR base before creating the track branch.
    - [ ] Create a dedicated Conductor track branch from the current branch before implementation work.
    - [ ] Create a GitHub pull request using `gh` with a title/body describing the TO-BE workflow behavior: relevant PRs validate, merged source PRs publish SHA builds, nightly runs publish nightly builds, GitHub tags publish channel releases, and npmjs remains manual.
    - [ ] Record the branch name, PR base, and PR URL in this plan.
- [ ] Task: Inventory existing workflow, scripts, tests, and docs
    - [ ] Review `.github/workflows/package-publish.yml` triggers, jobs, permissions, publish conditions, and artifact reuse.
    - [ ] Review `scripts/package-version-policy.js` and release/package scripts for current version, dist-tag, main-build, and staged apply behavior.
    - [ ] Review workflow/version-policy tests under `test/` and identify expected failing tests to add first.
    - [ ] Review `docs/release-procedure.md`, `docs/package-publishing.md`, and `conductor/tech-stack.md` for release-behavior claims that will need updates.
- [ ] Task: Write failing workflow and version-policy tests first
    - [ ] Add tests proving Conductor-only changes are ignored or skipped by package validation/publish automation.
    - [ ] Add tests proving release-procedure/package-publishing docs trigger validation without causing package publication.
    - [ ] Add tests proving merged source/package/test/workflow PRs can publish SHA builds using non-channel dist-tags.
    - [ ] Add tests proving scheduled nightly publishing uses nightly versions and a nightly dist-tag without moving `latest` or `next`.
    - [ ] Add tests proving `v*` stable and prerelease GitHub tags map to GitHub Packages `latest` and `next`, respectively.
    - [ ] Add tests proving automated workflows do not publish to npmjs.org.
- [ ] Task: Confirm tests fail for expected reasons
    - [ ] Run the narrowest workflow/version-policy test command.
    - [ ] Confirm failures represent missing or outdated workflow behavior rather than unrelated breakage.
    - [ ] Record failure output and coverage status in this plan.
- [ ] Task: Commit and push Phase 1 before manual validation
    - [ ] Run the narrowest lint or formatting validation needed for test/planning changes.
    - [ ] Commit Phase 1 changes with a scoped message.
    - [ ] Push the phase commit to the track PR branch.
    - [ ] Record the commit SHA and validation results in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Track branch, PR surface, and workflow behavior inventory' (Protocol in workflow.md)

## Phase 2: Workflow trigger and publish-kind implementation

- [ ] Task: Refine GitHub Actions triggers and gating
    - [ ] Update pull request validation paths so source/package/test/workflow and release-engineering docs trigger validation.
    - [ ] Ensure Conductor-only changes do not run package build/test/publish jobs.
    - [ ] Replace ordinary main-push publication with a merged-PR-aware publish path that only runs for merged pull requests with publish-triggering source/package/test/workflow changes.
    - [ ] Preserve `v*` tag release publishing.
    - [ ] Add scheduled nightly publishing and any needed manual dispatch guardrails.
- [ ] Task: Implement publish-kind metadata flow
    - [ ] Add or update script logic that resolves publish kind: pull request validation, merged-PR SHA build, nightly build, GitHub tag release, and manual npmjs candidate.
    - [ ] Compute deterministic SHA versions for merged PR builds and assign only non-channel dist-tags.
    - [ ] Compute deterministic nightly versions and assign only the `nightly` dist-tag.
    - [ ] Preserve stable tag release mapping to `latest` and prerelease tag release mapping to `next` for GitHub Packages.
    - [ ] Keep npmjs publish eligibility manual and disabled in automated GitHub Actions.
- [ ] Task: Preserve package validation and publication safety
    - [ ] Ensure build, stage, staged consumer validation, tarball validation, source tests, and lint still run before any automated GitHub Packages publication.
    - [ ] Ensure publish jobs use the minimum required permissions and do not publish on pull request validation runs.
    - [ ] Ensure GitHub Packages install validation still runs when appropriate after publication.
- [ ] Task: Validate workflow trigger and publish-kind implementation
    - [ ] Run focused workflow and version-policy tests until they pass.
    - [ ] Run lint for changed workflow/script/test files.
    - [ ] Record validation results and any intentionally skipped full validation in this plan.
- [ ] Task: Commit and push Phase 2 before manual validation
    - [ ] Commit Phase 2 changes with a scoped message.
    - [ ] Push the phase commit to the track PR branch.
    - [ ] Record the commit SHA and validation results in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Workflow trigger and publish-kind implementation' (Protocol in workflow.md)

## Phase 3: Release documentation and full validation

- [ ] Task: Update release and publishing documentation
    - [ ] Update `docs/release-procedure.md` with the branch/PR workflow, manual gate, Copilot review/comment fetching via `gh`, PR merge steps, merged-PR SHA publish behavior, scheduled nightly behavior, explicit GitHub tag release behavior, GitHub Packages channel advancement, and manual npmjs publication from validated GitHub Packages versions.
    - [ ] Update `docs/package-publishing.md` if package-publishing behavior or registry/channel language changes.
    - [ ] Update `conductor/tech-stack.md` if GitHub Actions behavior statements are no longer accurate.
- [ ] Task: Final safety and deduplication review
    - [ ] Review scripts for duplicated version/dist-tag logic and centralize reusable behavior in the release-engineering script layer.
    - [ ] Confirm no workflow path can automatically publish to npmjs.org.
    - [ ] Confirm Conductor-only changes remain validation-skipped while release-engineering docs remain validation-covered.
    - [ ] Confirm public package manifests and runtime code are unchanged unless required by the workflow correction.
- [ ] Task: Full validation pass
    - [ ] Run `npm run lint`.
    - [ ] Run `npm test` or narrower documented equivalents if full validation is not necessary.
    - [ ] Run package consumer/tarball validations if package output, version policy, or publish behavior changed.
    - [ ] Record skipped validation, failures, or manual-only checks with reasons.
- [ ] Task: PR handoff readiness
    - [ ] Fetch Copilot PR review/comments with `gh` and record whether corrections are required.
    - [ ] Ensure the PR body or comments summarize workflow trigger behavior, publish kinds, dist-tags, nightly behavior, npmjs manual policy, and validation.
    - [ ] Confirm all acceptance criteria from `spec.md` are addressed.
- [ ] Task: Commit and push Phase 3 before manual validation
    - [ ] Commit Phase 3 changes with a scoped message.
    - [ ] Push the phase commit to the track PR branch.
    - [ ] Record the commit SHA and validation results in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Release documentation and full validation' (Protocol in workflow.md)

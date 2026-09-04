# Package publishing runbook

This runbook describes the release-engineering helpers for preparing Verser2 workspace packages for GitHub Packages validation and maintainer-gated npmjs.org publication. It does not change Host, Guest, Broker, Peer, HTTP routing, or streaming behavior.

For the end-to-end release commit, tag, publish, and post-release bump procedure, see [Release procedure](./release-procedure.md).

## Version and dist-tag policy

Use `npm run package:version-policy` to inspect how a package version maps to publish metadata. The helper can describe tag releases, merged-PR SHA builds, nightly builds, and manual npmjs candidates. Tag routing is channel-classified: stable `vX.Y.Z` tags publish JavaScript only to npmjs.org (`latest`, behind the `npmjs-release` environment gate), prerelease `vX.Y.Z-<anything>` tags publish JavaScript only to GitHub Packages (`next`), and automatic `main` and nightly workflows publish GitHub Packages previews with the non-channel `main-sha`/`nightly` dist-tags. Stable tag releases never publish JavaScript to GitHub Packages.

Stable versions use the `latest` dist-tag:

```sh
npm run package:version-policy -- --version 1.2.3 --json
```

Prerelease versions use the `next` dist-tag:

```sh
npm run package:version-policy -- --version 1.2.3-next.0 --json
npm run package:version-policy -- --version 1.2.3-beta.1 --json
npm run package:version-policy -- --version 1.2.3-rc.0 --json
```

Merged-PR GitHub Packages builds use a deterministic SHA prerelease version and the non-channel `main-sha` dist-tag. The helper strips any prerelease from the current package version and appends a normalized short SHA:

```sh
npm run package:version-policy -- --version 1.2.3 --publish-kind merged-pr-sha --sha abcdef1234567890 --json
```

The computed version uses this shape:

```text
<base-version>-sha.<shortsha>
```

For example, `1.2.3-next.0` and SHA `ABCDEF1234567890` become `1.2.3-sha.abcdef123456`.

Nightly GitHub Packages builds use a deterministic nightly prerelease version and the non-channel `nightly` dist-tag:

```sh
npm run package:version-policy -- --version 1.2.3 --publish-kind nightly --sha abcdef1234567890 --nightly-date 20260616 --json
```

The computed version uses this shape:

```text
<base-version>-nightly.<yyyymmdd>.<shortsha>
```

The policy summary classifies every version into a release channel and a target registry through one canonical helper (`scripts/package-version-policy.js`):

- `classifyReleaseChannel(version)` returns `stable` for plain `X.Y.Z` semver and `prerelease` for any valid SemVer prerelease tag (`1.2.3-rc.1`, `1.2.3-next.0`, …). The tag workflow uses this classification to route `v*` tags.
- `deriveNextPrereleaseVersion(version)` is the single canonical post-release bump: a stable version `1.2.3` derives the next development prerelease `1.2.4-next.0`. Prerelease and build-metadata inputs are rejected for this derivation because only a stable release tag produces a post-release development bump. The tag-version-check job exposes the result as its `next_version` output for stable tags.
- `getPolicySummary({ version, publishKind: 'tag-release' })` reports `releaseChannel`, `targetRegistry` (`npmjs` for stable tags, `github-packages` for prerelease tags), `npmJsPublishAllowed` (true only for stable tags and manual npmjs candidates), and `nextVersion`.

```sh
npm run package:version-policy -- --version 1.2.3 --publish-kind tag-release --json
# releaseChannel: stable, targetRegistry: npmjs, npmJsPublishAllowed: true, nextVersion: 1.2.4-next.0
npm run package:version-policy -- --version 1.2.3-rc.1 --publish-kind tag-release --json
# releaseChannel: prerelease, targetRegistry: github-packages, npmJsPublishAllowed: false, nextVersion: null
```

SHA and nightly dist-tags never advance `latest` or `next`. GitHub Packages `next` advances only from prerelease `v*` tags; the `latest` channel on GitHub Packages and the already-published `v0.8.0` GitHub Packages content reflect the earlier publishing policy and are retained as historical/grandfathered only. Registry publishes are rerun-safe: when the exact package version already exists in the target registry, the workflow skips that package instead of failing blindly, while tag metadata conflicts still fail closed in `tag-version-check` before anything is published.

## Applying versions to staged packages

Build and stage packages first:

```sh
npm run build
npm run stage:packages
```

Then apply a computed SHA or nightly version to staged manifests only:

```sh
npm run package:version-policy -- --version 1.2.3 --publish-kind merged-pr-sha --sha abcdef1234567890 --apply-staged --json
```

This mutates only generated package manifests under `dist/packages`. It does not mutate source workspace `package.json` files.

The staging script builds a publish-only manifest from selected source fields instead of copying the source manifest wholesale. Source workspace packages may retain development-only fields such as `private`, `scripts`, `devDependencies`, or `workspaces`; staged package manifests omit those fields before packing or publishing. `test/package-publish-readiness.test.js` verifies that staged manifests do not contain `private: true`.

The publish workflow also converts the computed npm-style publish version to a
PEP 440-compatible Python version before building the Python distribution. For
example, `1.2.3-sha.abcdef123456` becomes
`1.2.3.dev0+sha.abcdef123456` in the wheel and source distribution metadata.

## Local staging, packing, and consumer tests

Run the full local package-readiness flow before publishing:

```sh
npm run build
npm run stage:packages
node --test test/package-publish-readiness.test.js
npm run test:package-consumers -- --source=source
npm run test:package-consumers -- --source=staging
npm run test:package-consumers -- --source=tarball
npm run test:package-tarballs
```

The default test command also stages packages before running the repository test suite under the bounded-memory runner:

```sh
npm test
```

`npm run test:package-consumers -- --source=tarball` is an import-compatibility probe. It packs staged packages, installs them into a temporary consumer project, and verifies CJS, ESM, and TypeScript imports for each package.

`npm run test:package-tarballs` is an automated behavior-test harness for packed artifacts. Build and stage packages first:

```sh
npm run build
npm run stage:packages
npm run test:package-tarballs
```

Staged package READMEs are copied from each source package and rewritten so
repository documentation links point at GitHub `blob/<sha-or-tag>/...` URLs.
By default `npm run stage:packages` uses the current Git commit SHA. Set
`VERSER_PACKAGE_DOCS_REF` to a release tag when staging tag-based packages:

```sh
VERSER_PACKAGE_DOCS_REF=v1.2.3 npm run stage:packages
```

The tarball behavior harness:

- packs all staged packages with `npm pack`;
- installs those `.tgz` files into an isolated temporary consumer project;
- runs checked-in Node `node:test` files from that temporary consumer;
- sets `VERSER_TEST_PACKAGE_MODE=tarball` so reusable tests import `@signicode/*` packages by package name from `node_modules` instead of repository-relative `dist` paths;
- reports included tarball-mode test groups and source-only exclusions.

Current tarball-mode coverage includes:

- consumer import/export shape for all staged packages;
- existing common protocol and envelope tests from `test/common-protocol.test.js` and `test/common-envelope.test.js`;
- existing Host, Node Guest, Broker, Agent, dispatcher/fetch, concurrent routing, and disconnect behavior from `test/end-to-end.test.js`;
- a compact tarball-specific behavior check in `test/package-tarball/behavior.test.cjs`.

Source-only exclusions remain covered by `npm test`. They include workflow/static metadata tests, package staging and version-policy tests that inspect repository files or generated staging metadata, and broader source suites whose purpose is not consumer-installed package behavior.

Use GitHub Packages consumer validation only after packages have been published and credentials are available:

```sh
VERSER_RUN_GITHUB_CONSUMER_TESTS=1 \
VERSER_GITHUB_PACKAGE_VERSION=1.2.3-sha.abcdef123456 \
GITHUB_PACKAGES_TOKEN=<token> \
npm run test:package-consumers -- --source=github
```

The GitHub mode exits successfully with a skip report unless `VERSER_RUN_GITHUB_CONSUMER_TESTS=1` is set. This keeps local and pull-request validation network-free.

## npmjs publishing boundary

This repository keeps npmjs publishing maintainer-gated behind the single `npmjs-release` GitHub environment. Automatic `main` and nightly workflow paths never publish to npmjs.org. Both npmjs paths — stable `vX.Y.Z` tag pushes and manual `workflow_dispatch` runs — use direct OIDC `npm publish` (npm trusted publishing), not `npm stage` staging. Prerelease tags never publish JavaScript to npmjs.org; they route to GitHub Packages with the `next` dist-tag. The version-policy helper can describe a manual npmjs candidate, does not run npm publishing commands itself, and reports `npmJsPublishAllowed: true` only for stable `tag-release` versions and the explicit `manual-npmjs-candidate` publish kind:

```sh
npm run package:version-policy -- --version 1.2.3 --publish-kind manual-npmjs-candidate --json
```

Manual npmjs publication uses an explicitly selected semver version validated by the workflow's staged/tarball checks and the `npmjs-release` environment gate. A manual version is not required to exist on GitHub Packages first; manual dispatch publishes JavaScript to npmjs.org directly. Under the channel policy stable tag releases publish to npmjs.org directly, and prerelease tag releases publish to GitHub Packages only — no tag path publishes to both registries.

Manual npmjs release work should reuse the same stable/prerelease dist-tag policy:

- stable versions publish with `latest`;
- prerelease versions publish with `next`.

The npmjs workflow path is available through `.github/workflows/package-publish.yml` in two modes:

- pushes of stable `vX.Y.Z` tags publish the tag version to npmjs.org directly after package validation, the fail-closed tag version consistency check, and `npmjs-release` environment approval; SHA build versions are rejected; stable and prerelease tags both require the workspace manifests, `pyproject.toml`, and `uv.lock` to match the tag (Python metadata in the canonical PEP 440 form); prerelease tags skip the npmjs job entirely because `npmjs-publish` only runs when `tag-version-check` classifies the tag as `stable`, and the job's metadata step re-checks the policy and fails closed on any prerelease routing;
- manual `workflow_dispatch` runs can direct-publish an explicitly selected version, or validate the exact publish inputs with `npm publish --dry-run`. The `npmjs-publish` condition is skip-safe: with `publish_npmjs: true` the manual path still evaluates and runs (after validation and the environment gate) even though the tag-only `tag-version-check` job is skipped.

Real (non-dry-run) npmjs publishes are rerun-safe: each package whose exact version already exists on npmjs.org is skipped with a log line instead of failing, and conflicting tag metadata still fails closed in `tag-version-check` before any publish attempt.

Tag runs fail closed: the `tag-version-check` job compares the tag semver against every workspace `package.json` version, the Python project metadata, and the Python `uv.lock` package entry (all Python metadata in the canonical PEP 440 conversion of the tag), and any mismatch stops the npmjs publish and Python release asset jobs. For stable tags the JavaScript and Python forms are identical; for prerelease tags such as `v1.2.3-rc.1` the workspace manifests must equal `1.2.3-rc.1` while `pyproject.toml` and `uv.lock` must equal `1.2.3rc1`.

Manual dispatch uses these inputs:

- `publish_npmjs: true` to opt in to npmjs publication;
- `npmjs_version` with the exact semver version to publish;
- `npmjs_dry_run: true` (default) to run `npm publish --dry-run` against the validated staged packages instead of publishing; set it to `false` for a real manual publish.

Before the first real npmjs publish run, maintainers must configure the `npmjs-release` GitHub environment with required reviewers and npm trusted publishing `npm publish` permission for the `@signicode` packages. The workflow grants `id-token: write` and relies on npm trusted publishing instead of an `NPM_TOKEN` secret.

## GitHub Actions package publish workflow

A GitHub Actions workflow publishes GitHub Packages previews and prerelease-tag packages, direct npmjs.org stable releases, tag-only Python release assets, and the stable-tag post-release version-bump pull request:

- `.github/workflows/package-publish.yml`

Behavior summary:

- Pull requests to `main`: build, stage, pack, run local package-consumer tests, and run automated tarball behavior tests without path filters so docs, governance, workflow, package metadata, and source changes receive validation. Pull-request workflow runs must never publish packages to GitHub Packages or npmjs.org.
- Pushes to `main`: classify changed files before package validation. Package-affecting merges run the validation flow, upload the validated build/staging output for reuse by the `github-packages-preview` job, compute a deterministic SHA version, re-run staged, import-only tarball, and automated tarball behavior tests after applying that version, then publish a GitHub Packages preview with the non-channel `main-sha` dist-tag. Documentation-only and Conductor-only merges do not publish packages; release-procedure/package-publishing docs can trigger validation without publication.
- Scheduled nightly runs: run independently of the latest changed files, validate package output, compute a deterministic nightly version, then publish a GitHub Packages preview with the non-channel `nightly` dist-tag.
- Pushes for tags matching `v*`: run validation, then the `tag-version-check` job fails closed unless the tag version equals every workspace `package.json` version, the Python project metadata, and the Python `uv.lock` package entry (PEP 440 canonical form; equal to the SemVer form for stable tags, converted for prereleases). The same job classifies the tag through the canonical policy helper and exposes `release_channel` (`stable`/`prerelease`) plus `next_version` (the derived `X.Y.(Z+1)-next.0` bump for stable tags). Stable tags: after the `npmjs-release` environment gate, `npmjs-publish` direct-publishes the tag version to npmjs.org with OIDC `npm publish` and the `latest` dist-tag (SHA build versions are rejected; already-published exact versions are skipped rerun-safely). Prerelease tags: `npmjs-publish` never runs; the `github-packages-tag-prerelease` job publishes the tag version to GitHub Packages only, with the `next` dist-tag, skipping packages whose exact version is already present instead of failing on reruns. Both stable and prerelease tags run the separate tag-only `python-release-assets` job, which validates artifacts and attaches a PEP 440 tag-versioned wheel and source distribution to the GitHub Release.
- Post-release development bump for stable tags only: after BOTH `npmjs-publish` and `python-release-assets` succeed, the `post-release-next-pr` job creates or reuses a normal pull request against protected `main` that bumps source version metadata to the derived next prerelease (`1.2.3` → `1.2.4-next.0`) with `npm run package:prepare-release`. The job uses a deterministic non-main branch (`release/post-<tag>`), checks for an already-open PR before creating work, branches from current `origin/main` only after verifying the stable tag commit is an ancestor of `origin/main`, commits only workspace `package.json` files, `package-lock.json`, `pyproject.toml`, and `uv.lock` (no dist files; anything else fails closed), sets the `github-actions[bot]` identity, pushes without force, and opens the PR with `gh pr create` targeting `main`. The workflow never pushes directly to `main` and never force-pushes. Prerelease tags produce no post-release PR. The job is the only job with `pull-requests: write`, has `contents: write`, and is guarded by job-level concurrency keyed by the release tag.
- Manual workflow dispatch with `publish_npmjs: true`: validates the package output, applies the requested npmjs version to staged manifests, re-runs staged/tarball consumer checks and tarball behavior tests, then direct-publishes to npmjs.org with `npm publish` — or runs `npm publish --dry-run` when `npmjs_dry_run: true` — only after the single `npmjs-release` environment gate approves the run. Python PyPI publishing remains out of scope.

For every publish path, the workflow:

- Uses `actions/setup-node` with the registry URL and `scope: @signicode` for the active publish target.
- Uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` for GitHub Packages preview publish.
- Uses npm trusted publishing (OIDC) with direct `npm publish` permission, `id-token: write`, and a current npm CLI on Node 22 for npmjs.org publication behind the single `npmjs-release` environment gate.
- Publishes GitHub Packages previews with `npm publish --access public` so package pages and installs can be public after the repository launch.
- Uploads the validation job's `dist/packages` tree and Python wheel/source-distribution artifacts, then downloads those artifacts in the publish jobs instead of running a second full `npm run build` / `npm run stage:packages` cycle.
- Runs `npm pack` on staged packages and consumes staged/tarball package sources in local validation.
- Runs automated tarball behavior tests before the pull-request validation job completes.
- Runs source tests and lint in the validation job via `npm run test:bounded:staged` (`node ./scripts/run-bounded-tests.js --skip-build-stage --live-timestamps`) plus `npm run lint`, reusing the job's earlier build/stage output after the runner's staged-artifact preflight.
- Re-runs staged consumer validation, import-only tarball consumer validation, and automated tarball behavior tests after applying the publish version so internal package dependencies point at the same published version.
- Runs automated tarball behavior tests before any `npm publish` command executes.
- Optionally runs GitHub Packages consumer validation with `VERSER_RUN_GITHUB_CONSUMER_TESTS=1`.
- Avoids npmjs.org publication on automatic `main` push, nightly, and pull-request paths; npmjs.org publication runs only from stable `vX.Y.Z` tags or an approved manual dispatch, always through the `npmjs-release` environment gate. Prerelease tags publish JavaScript to GitHub Packages only.
- Fails closed on tag runs when the tag version differs from any workspace `package.json` version, the Python project metadata, or the Python `uv.lock` package entry (PEP 440 canonical form).

The Python Guest package is built as a native Python source distribution and
pure-Python wheel under `packages/verser2-guest-python/dist/python`. Publish runs
upload those files as a workflow artifact named for the computed package version.
Tag publishes also attach the same files to the GitHub Release so Python users
can install from the release asset URL when the package is not available from a
Python package index.

Manual validation steps (first-time publish):

1. Merge a package-affecting pull request to `main` and confirm the GitHub Packages preview job uses the SHA build version with the `main-sha` dist-tag.
2. Confirm a Conductor-only pull request does not run package build/test/publish jobs.
3. Confirm release-procedure or package-publishing documentation changes run validation without publishing packages.
4. Trigger or observe a scheduled nightly run and confirm the `nightly` dist-tag preview behavior.
5. Push a stable release tag like `v1.2.3` and confirm the tag version consistency check passes, the run is classified `stable`, no JavaScript is published to GitHub Packages, the npmjs publish metadata resolves to `latest`, and — after both the npmjs and Python release asset jobs succeed — the workflow opens (or reuses) the `release/post-v1.2.3` pull request bumping metadata to `1.2.4-next.0` without pushing to `main`.
6. Push a prerelease tag like `v1.2.3-rc.1` and confirm the run is classified `prerelease`, JavaScript is published to GitHub Packages only with the `next` dist-tag, nothing is published to npmjs.org, the PEP 440 Python release assets are attached to the GitHub Release, and no post-release pull request is opened.
7. Set `VERSER_RUN_GITHUB_CONSUMER_TESTS=1` and verify GitHub Packages install checks pass from the workflow logs.
8. Configure `npmjs-release` required reviewers and npm trusted publishing `npm publish` permission before running the npmjs workflow path.
9. Run a manual npmjs dry-run with `publish_npmjs: true`, `npmjs_dry_run: true`, and the intended version — it executes `npm publish --dry-run` — before the first real direct publish.
10. Confirm the repository or organization Actions settings allow `GITHUB_TOKEN` to create and approve pull requests (`Settings → Actions → General`: workflow permissions set to “Read and write permissions” plus “Allow GitHub Actions to create and approve pull requests”), in addition to the per-job `contents: write` + `pull-requests: write` scopes already declared in `package-publish.yml`. Because the post-release PR and branch are created with `GITHUB_TOKEN`, the PR's `pull_request` workflow checks are held as approval-required and do not start automatically; a maintainer with write access must open the PR and select “Approve workflows to run” to trigger the protected-branch checks (a `GITHUB_TOKEN` follow-up push or close-and-reopen does not auto-start them). This keeps the `GITHUB_TOKEN` strategy — no PAT or GitHub App is required.

If GitHub Packages validation is intentionally disabled, confirm the step logs a skip reason instead of failing.

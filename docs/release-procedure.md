# Release procedure

This procedure prepares Verser2 workspace packages, publishes GitHub Packages previews from `main` merges and nightly runs plus GitHub Packages `next` publications from prerelease tags, and describes the maintainer-gated direct npmjs.org release path used by stable tags and manual dispatch. Stable tag releases also open an automated post-release development-bump pull request. Python PyPI publishing remains out of scope.

## Branch and pull request workflow

Do release-engineering changes on a normal branch and pull request. Pull requests to `main` run `.github/workflows/package-publish.yml` validation without path filters so source, package metadata, tests, release scripts, governance files, workflow changes, and release-engineering docs receive validation.

Before merging a release workflow pull request, fetch review feedback with `gh`:

```sh
gh pr view <number> --comments
gh pr view <number> --json reviews,comments
```

Address any required Copilot or human review comments, re-run the narrowest local validation needed for the changed files, and merge through the normal protected PR flow.

When a merged pull request changes package-affecting source, scripts, tests, package metadata, or workflow files, the main-branch workflow validates the package output and publishes deterministic SHA-versioned GitHub Packages previews with the `main-sha` dist-tag. Documentation-only and Conductor-only merges do not publish packages; release-procedure/package-publishing docs can trigger validation without advancing a package channel.

Scheduled nightly workflow runs publish deterministic nightly versions as GitHub Packages previews with the `nightly` dist-tag. SHA and nightly preview publications never move `latest` or `next`.

## Prepare the release commit

Choose the release version and update source package metadata:

```sh
npm run package:prepare-release -- --version 0.2.0
```

The script updates all workspace `package.json` versions, internal `@signicode/*` dependency pins, and `package-lock.json` with the exact SemVer version, and writes the canonical PEP 440 conversion of that version (the same `package-version-policy` `toPythonVersion` rule the tag workflow enforces fail-closed) to the Python package metadata in `pyproject.toml` and `uv.lock`. For stable versions the two forms are identical; for prereleases such as `0.2.1-rc.1`, JavaScript manifests keep `0.2.1-rc.1` while Python metadata carries `0.2.1rc1`.

Update `CHANGELOG.md` for the release, then validate:

```sh
npm run lint
npm test
npm run package:version-policy -- --version 0.2.0 --json
```

Stable versions resolve to the `latest` dist-tag. Prerelease versions such as `0.2.1-next.0` resolve to `next`.

Commit the release preparation on a release branch and open a pull request for it:

```sh
git switch --create release/v0.2.0
git add .
git commit -m "chore(release): prepare v0.2.0"
git push --set-upstream origin release/v0.2.0
gh pr create --base main --head release/v0.2.0 \
  --title "chore(release): prepare v0.2.0" \
  --body "Release preparation for v0.2.0: workspace versions, dependency pins, lockfile, Python metadata, and CHANGELOG."
```

The release-preparation commit reaches `main` only by merging this pull request through the normal protected PR flow (required reviews and checks). Never push the release-preparation commit directly to `main`.

## Publish with a release tag

After the release-preparation pull request has merged, update your local `main` to the merged commit, tag exactly that commit, and push only the tag:

```sh
git switch main
git pull --ff-only origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

The `v*` tag push is the authoritative automatic channel-release path. It runs `.github/workflows/package-publish.yml` without path filters. The workflow builds, stages, and validates staged/tarball consumers; the `tag-version-check` job then fails closed unless the tag version equals every workspace `package.json` version, the Python project metadata, and the Python `uv.lock` package entry (the canonical PEP 440 conversion of the tag, identical to the SemVer form for stable releases and converted for prereleases like `v1.2.3-rc.1` → `1.2.3rc1`). The same check classifies the tag as `stable` or `prerelease` through the canonical policy helper and routes the publication:

- Stable tags `vX.Y.Z`: after the `npmjs-release` environment gate, `npmjs-publish` direct-publishes each staged package to npmjs.org with OIDC `npm publish` and the `latest` dist-tag (already-published exact versions are skipped rerun-safely), and the tag-only `python-release-assets` job attaches a PEP 440 tag-versioned wheel and source distribution to the GitHub Release. Stable tags never publish JavaScript to GitHub Packages. After both the npmjs and Python release jobs succeed, the workflow opens (or reuses) the post-release development-bump pull request described in [After publishing](#after-publishing).
- Prerelease tags `vX.Y.Z-<anything>`: JavaScript is published to GitHub Packages only, with the `next` dist-tag, by the `github-packages-tag-prerelease` job; packages whose exact version is already present in GitHub Packages are skipped instead of failing on reruns. Prerelease tags never publish JavaScript to npmjs.org, still attach the PEP 440 wheel and source distribution to the GitHub Release, and never produce a post-release pull request.

For `v0.2.0`, the publish metadata is:

```text
version: 0.2.0
dist-tag: latest
registry: https://registry.npmjs.org/
next_version (post-release PR): 0.2.1-next.0
```

Prerelease tags such as `v0.2.1-rc.1` publish to GitHub Packages with the `next` dist-tag (`https://npm.pkg.github.com`). Stable tags publish to npmjs.org with `latest`.

The `v0.8.0` packages already present on GitHub Packages predate this policy and are retained as historical/grandfathered artifacts only. Under the current policy the GitHub Packages `next` channel advances only from prerelease tags, and stable tags never publish JavaScript to GitHub Packages.

## Manual npmjs publication boundary

Automatic `main` and nightly workflow paths publish GitHub Packages previews only and never publish to npmjs.org; pull requests never publish anywhere. Tag pushes matching `v*` route by channel: stable `vX.Y.Z` tags direct-publish the tag version to npmjs.org after validation, the fail-closed tag version consistency check, and approval through the single `npmjs-release` environment, as long as the resolved version is not a SHA build version; prerelease tags publish JavaScript to GitHub Packages only and never reach the npmjs path. Maintainers can also use the manual `workflow_dispatch` path in `.github/workflows/package-publish.yml` for an explicitly selected version; the `npmjs-publish` job condition is skip-safe, so a manual run with `publish_npmjs: true` proceeds after validation and the environment gate even though the tag-only consistency check job is skipped.

Before the first real npmjs publication:

1. Configure the `npmjs-release` GitHub environment with required reviewers.
2. Configure npm trusted publishing for each `@signicode` package with publisher `GitHub Actions`, organization `signicode`, repository `verser2`, workflow `package-publish.yml`, environment `npmjs-release`, and an allowed action for `npm publish`.
3. Confirm package access settings for public scoped packages.
4. For manual validation-only runs, run the workflow with `publish_npmjs: true`, the intended `npmjs_version`, and `npmjs_dry_run: true`; the dry-run invokes `npm publish --dry-run` against the validated staged packages.
5. Review the dry-run output. For real releases, push a `v*` tag or re-run manual dispatch with `npmjs_dry_run: false` only when maintainers approve direct publication.

The npmjs path uses the same stable/prerelease dist-tag policy: stable versions publish with `latest`, and prerelease versions publish with `next`.

## Monitor the release

Watch the tag workflow run:

```sh
gh run list --workflow "Package publish readiness" --limit 5
gh run watch <run-id> --exit-status
```

If the SHA or nightly preview publish succeeds, confirm that GitHub Packages installation validation passed in the workflow logs. For a stable tag release, confirm the `tag-version-check` job passed and classified the tag as `stable`, that staged/tarball validation passed before the direct `npm publish` step, that the run was approved through the single `npmjs-release` gate, that `python-release-assets` attached the PEP 440 wheel and source distribution to the GitHub Release, and that the `post-release-next-pr` job opened the development-bump pull request after both release jobs succeeded. For a prerelease tag release, confirm the job classified the tag as `prerelease`, `github-packages-tag-prerelease` published to GitHub Packages with `next`, the npmjs job was skipped, `python-release-assets` attached the release assets, and no post-release pull request was opened.

## After publishing

For stable tags the workflow opens the post-release pull request automatically once both the npmjs.org publish and the Python release asset jobs succeed. It uses the canonical policy helper to derive the next development prerelease (`0.2.0` → `0.2.1-next.0`), works on the deterministic non-main branch `release/post-v0.2.0`, branches only from current `origin/main` after verifying the tag commit is an ancestor of `origin/main`, commits only source version metadata (workspace `package.json` files, `package-lock.json`, `pyproject.toml`, `uv.lock`) produced by `npm run package:prepare-release`, never force-pushes, and opens a normal pull request targeting `main` for review through the protected branch flow. The run is rerun-safe: an already-open post-release PR is reused, an already-bumped `main` skips the work, and the job is serialized by tag-keyed concurrency. Prerelease tags never produce a post-release PR.

Because the branch and pull request are created with the workflow's `GITHUB_TOKEN`, GitHub does not automatically start that PR's `pull_request` workflow checks; they are held as approval-required. A maintainer with write access must open the PR and select **“Approve workflows to run”** before the protected-branch checks execute — a `GITHUB_TOKEN` follow-up push or a close-and-reopen does not auto-start them. This relies on the `GITHUB_TOKEN` strategy already configured in `package-publish.yml`; no PAT or GitHub App is introduced. Prerequisite: the repository or organization Actions settings must allow GitHub Actions to create and approve pull requests (`Settings → Actions → General` → “Allow GitHub Actions to create and approve pull requests”, with workflow permissions set to “Read and write permissions”), in addition to the `contents: write` and `pull-requests: write` job permissions the workflow already declares.

Only if the automated job was skipped or its PR was closed without merging, open the bump manually on a fresh branch from current `main`:

```sh
npm run package:prepare-release -- --version 0.2.1-next.0
```

The publish workflow never commits or pushes directly to `main`; keep release commits, tags, and post-release development bumps explicit and reviewable through pull requests.

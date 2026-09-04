# Release procedure

This procedure prepares Verser2 workspace packages, publishes GitHub Packages previews from `main` merges and nightly runs, and describes the maintainer-gated direct npmjs.org release path used by tags and manual dispatch. Python PyPI publishing remains out of scope.

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

Commit the release preparation:

```sh
git add .
git commit -m "chore(release): prepare v0.2.0"
```

## Publish with a release tag

Push the release commit to `main`, then create and push an annotated tag:

```sh
git push origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

The `v*` tag push is the authoritative automatic channel-release path for npmjs.org. It runs `.github/workflows/package-publish.yml` without path filters. The workflow builds, stages, and validates staged/tarball consumers; the `tag-version-check` job then fails closed unless the tag version equals every workspace `package.json` version, the Python project metadata, and the Python `uv.lock` package entry (the canonical PEP 440 conversion of the tag, identical to the SemVer form for stable releases and converted for prereleases like `v1.2.3-rc.1` → `1.2.3rc1`); after the `npmjs-release` environment gate, `npmjs-publish` direct-publishes each staged package to npmjs.org with OIDC `npm publish`; and the separate tag-only `python-release-assets` job validates artifacts and attaches a PEP 440 tag-versioned wheel and source distribution to the GitHub Release. Tags never publish JavaScript to GitHub Packages under this policy.

For `v0.2.0`, the publish metadata is:

```text
version: 0.2.0
dist-tag: latest
registry: https://registry.npmjs.org/
```

Prerelease tags such as `v0.2.1-rc.1` publish to npmjs.org with the `next` dist-tag. Stable tags publish with `latest`.

The `v0.8.0` packages already present on GitHub Packages predate this policy and are retained as historical/grandfathered artifacts only; the workflow does not republish or advance GitHub Packages channels from tags.

## Manual npmjs publication boundary

Automatic `main` and nightly workflow paths publish GitHub Packages previews only and never publish to npmjs.org; pull requests never publish anywhere. Tag pushes matching `v*` direct-publish the tag version to npmjs.org after validation, the fail-closed tag version consistency check, and approval through the single `npmjs-release` environment, as long as the resolved version is not a SHA build version. Maintainers can also use the manual `workflow_dispatch` path in `.github/workflows/package-publish.yml` for an explicitly selected version; the `npmjs-publish` job condition is skip-safe, so a manual run with `publish_npmjs: true` proceeds after validation and the environment gate even though the tag-only consistency check job is skipped.

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

If the SHA or nightly preview publish succeeds, confirm that GitHub Packages installation validation passed in the workflow logs. For a tag release, confirm the `tag-version-check` job passed, that staged/tarball validation passed before the direct `npm publish` step, that the run was approved through the single `npmjs-release` gate, and that `python-release-assets` attached the PEP 440 wheel and source distribution to the GitHub Release.

## After publishing

Open a normal follow-up pull request that bumps development versions to the next prerelease base, for example:

```sh
npm run package:prepare-release -- --version 0.2.1-next.0
```

Do not have the publish workflow commit directly to `main`; keep release commits, tags, and post-release development bumps explicit and reviewable.

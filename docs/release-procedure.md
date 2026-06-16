# Release procedure

This procedure prepares and publishes Verser2 workspace packages to GitHub Packages and describes the maintainer-gated npmjs.org follow-up path. Python PyPI publishing remains out of scope.

## Branch and pull request workflow

Do release-engineering changes on a normal branch and pull request. Pull requests to `main` run `.github/workflows/package-publish.yml` validation without path filters so source, package metadata, tests, release scripts, governance files, workflow changes, and release-engineering docs receive validation.

Before merging a release workflow pull request, fetch review feedback with `gh`:

```sh
gh pr view <number> --comments
gh pr view <number> --json reviews,comments
```

Address any required Copilot or human review comments, re-run the narrowest local validation needed for the changed files, and merge through the normal protected PR flow.

When a merged pull request changes package-affecting source, scripts, tests, package metadata, or workflow files, the main-branch workflow validates the package output and publishes deterministic SHA-versioned GitHub Packages with the `main-sha` dist-tag. Documentation-only and Conductor-only merges do not publish packages; release-procedure/package-publishing docs can trigger validation without advancing a package channel.

Scheduled nightly workflow runs publish deterministic nightly versions to GitHub Packages with the `nightly` dist-tag. SHA and nightly publications never move `latest` or `next`.

## Prepare the release commit

Choose the release version and update source package metadata:

```sh
npm run package:prepare-release -- --version 0.2.0
```

The script updates all workspace `package.json` versions, internal `@signicode/*` dependency pins, `package-lock.json`, and the Python package metadata in `pyproject.toml` and `uv.lock`.

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

The `v*` tag push is the authoritative automatic channel-release path for GitHub Packages. It runs `.github/workflows/package-publish.yml` without path filters. The workflow builds, stages, validates staged/tarball consumers, applies the tag version to staged manifests, and publishes each staged package to GitHub Packages.

For `v0.2.0`, the publish metadata is:

```text
version: 0.2.0
dist-tag: latest
registry: https://npm.pkg.github.com
```

Prerelease tags such as `v0.2.1-rc.1` publish to GitHub Packages with the `next` dist-tag. Stable tags publish with `latest`.

## Manual npmjs publication boundary

Automatic `main`, nightly, and pull-request workflow paths never publish to npmjs.org. Tag pushes matching `v*` stage packages on npmjs.org automatically after validation when the resolved version is not a SHA build version, but the npmjs job still requires approval through the `npmjs-release` environment. Maintainers can also use the manual `workflow_dispatch` path in `.github/workflows/package-publish.yml` for an explicitly selected version.

Before the first real npmjs publication:

1. Configure the `npmjs-release` GitHub environment with required reviewers.
2. Configure npm trusted publishing for each `@signicode` package with publisher `GitHub Actions`, organization `signicode`, repository `verser2`, workflow `package-publish.yml`, environment `npmjs-release`, and an allowed action that includes npm stage publishing.
3. Confirm package access settings for public scoped packages.
4. For manual validation-only runs, run the workflow with `publish_npmjs: true`, the intended `npmjs_version`, and `npmjs_dry_run: true`.
5. Review the validation-only output. For real releases, push a `v*` tag or re-run manual dispatch with `npmjs_dry_run: false` only when maintainers approve creating npm package stages.

The npmjs path uses the same stable/prerelease dist-tag policy: stable versions publish with `latest`, and prerelease versions publish with `next`.

## Monitor the release

Watch the tag workflow run:

```sh
gh run list --workflow "Package publish readiness" --limit 5
gh run watch <run-id> --exit-status
```

If the tag, SHA, or nightly publish succeeds, confirm that GitHub Packages installation validation passed in the workflow logs. If the manual npmjs path is used, confirm that staged/tarball validation passed before the npmjs stage-publish step and that the run was approved through `npmjs-release`.

## After publishing

Open a normal follow-up pull request that bumps development versions to the next prerelease base, for example:

```sh
npm run package:prepare-release -- --version 0.2.1-next.0
```

Do not have the publish workflow commit directly to `main`; keep release commits, tags, and post-release development bumps explicit and reviewable.

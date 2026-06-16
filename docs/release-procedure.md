# Release procedure

This procedure prepares and publishes Verser2 workspace packages to GitHub Packages. It does not publish to npmjs.org; npmjs publication remains a manual follow-up from an explicitly selected package version that has already been validated in GitHub Packages.

## Branch and pull request workflow

Do release-engineering changes on a normal branch and pull request. Package-affecting pull requests to `main` run `.github/workflows/package-publish.yml` validation when they change source, package metadata, tests, release scripts, the package workflow, or release-engineering docs such as this file and `docs/package-publishing.md`. Conductor-only changes under `conductor/**` do not run the package build/test validation jobs.

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

The automated workflow never publishes to npmjs.org. To publish to npmjs manually in a future release procedure, first choose a version that has already passed GitHub Packages publication and installation validation, then run the manual npmjs process outside `.github/workflows/package-publish.yml` with explicit maintainer approval.

## Monitor the release

Watch the tag workflow run:

```sh
gh run list --workflow "Package publish readiness" --limit 5
gh run watch <run-id> --exit-status
```

If the tag, SHA, or nightly publish succeeds, confirm that GitHub Packages installation validation passed in the workflow logs.

## After publishing

Open a normal follow-up pull request that bumps development versions to the next prerelease base, for example:

```sh
npm run package:prepare-release -- --version 0.2.1-next.0
```

Do not have the publish workflow commit directly to `main`; keep release commits, tags, and post-release development bumps explicit and reviewable.

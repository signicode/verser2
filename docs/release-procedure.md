# Release procedure

This procedure prepares and publishes Verser2 workspace packages to GitHub Packages. It does not publish to npmjs.org.

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

The `v*` tag push runs `.github/workflows/package-publish.yml` without path filters. The workflow builds, stages, validates staged/tarball consumers, applies the tag version to staged manifests, and publishes each staged package to GitHub Packages.

For `v0.2.0`, the publish metadata is:

```text
version: 0.2.0
dist-tag: latest
registry: https://npm.pkg.github.com
```

## Monitor the release

Watch the tag workflow run:

```sh
gh run list --workflow "Package publish readiness" --limit 5
gh run watch <run-id> --exit-status
```

If the tag publish succeeds, confirm that GitHub Packages installation validation passed in the workflow logs.

## After publishing

Open a normal follow-up pull request that bumps development versions to the next prerelease base, for example:

```sh
npm run package:prepare-release -- --version 0.2.1-next.0
```

Do not have the publish workflow commit directly to `main`; keep release commits, tags, and post-release development bumps explicit and reviewable.

# Package publishing runbook

This runbook describes the release-engineering helpers for preparing Verser2 workspace packages for GitHub Packages validation and maintainer-gated npmjs.org publication. It does not change Host, Guest, Broker, Peer, HTTP routing, or streaming behavior.

For the end-to-end release commit, tag, publish, and post-release bump procedure, see [Release procedure](./release-procedure.md).

## Version and dist-tag policy

Use `npm run package:version-policy` to inspect how a package version maps to publish metadata. The helper can describe tag releases, merged-PR SHA builds, nightly builds, and manual npmjs candidates; automatic `main` and nightly workflows publish only to GitHub Packages, while `v*` tag releases can publish to both GitHub Packages and npmjs.org after the `npmjs-release` environment gate approves npm trusted publishing.

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

SHA and nightly dist-tags never advance `latest` or `next`; only explicit `v*` tag releases advance those GitHub Packages channels.

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

The default test command also stages packages before running the repository test suite:

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

This repository keeps npmjs publishing maintainer-gated. Automatic `main` and nightly workflow paths never publish to npmjs.org; `v*` tag release paths may publish to npmjs.org after validation and `npmjs-release` environment approval. The version-policy helper can describe a manual npmjs candidate, does not run `npm publish` itself, and reports `npmJsPublishAllowed: true` only for the explicit `manual-npmjs-candidate` publish kind:

```sh
npm run package:version-policy -- --version 1.2.3 --publish-kind manual-npmjs-candidate --json
```

Manual npmjs publication should use an explicitly selected version that is already available and validated in GitHub Packages.

Manual npmjs release work should reuse the same stable/prerelease tag policy:

- stable versions publish with `latest`;
- prerelease versions publish with `next`.

The npmjs workflow path is available through `.github/workflows/package-publish.yml` in two modes:

- automatic `v*` tag pushes publish the tag version to npmjs.org after package validation and `npmjs-release` environment approval, as long as the resolved version is not a SHA build version;
- manual `workflow_dispatch` runs can publish an explicitly selected version.

Manual dispatch uses these inputs:

- `publish_npmjs: true` to opt in to npmjs publication;
- `npmjs_version` with the exact semver version to publish;
- `npmjs_dry_run: true` for the default dry run before a real publish.

Before the first real npmjs publish, maintainers must configure the `npmjs-release` GitHub environment with required reviewers and npm trusted publishing for the `@signicode` packages. The workflow grants `id-token: write` and relies on npm trusted publishing instead of an `NPM_TOKEN` secret.

## GitHub Actions package publish workflow

A GitHub Actions workflow publishes staged artifacts to GitHub Packages:

- `.github/workflows/package-publish.yml`

Behavior summary:

- Pull requests to `main`: build, stage, pack, run local package-consumer tests, and run automated tarball behavior tests without path filters so docs, governance, workflow, package metadata, and source changes receive validation. Pull-request workflow runs must never publish packages to GitHub Packages or npmjs.org.
- Pushes to `main`: classify changed files before package validation. Package-affecting merges run the validation flow, upload the validated build/staging output for reuse by the publish job, compute a deterministic SHA version, re-run staged, import-only tarball, and automated tarball behavior tests after applying that version, then publish with the non-channel `main-sha` dist-tag. Documentation-only and Conductor-only merges do not publish packages; release-procedure/package-publishing docs can trigger validation without publication.
- Scheduled nightly runs: run independently of the latest changed files, validate package output, compute a deterministic nightly version, then publish to GitHub Packages with the non-channel `nightly` dist-tag.
- Pushes for tags matching `v*`: run the same flow, reuse the validated build/staging output, re-run staged, import-only tarball, and automated tarball behavior tests after applying the tag-decoded version, then publish GitHub Packages and npmjs.org using stable/pre-release dist-tags from policy (`latest` for stable semver, `next` for prereleases). The npmjs publish job still waits for `npmjs-release` environment approval and rejects SHA build versions.
- Manual workflow dispatch with `publish_npmjs: true`: validates the package output, applies the requested npmjs version to staged manifests, re-runs staged/tarball consumer checks and tarball behavior tests, then publishes JavaScript packages to npmjs.org only after the `npmjs-release` environment gate approves the run. Python PyPI publishing remains out of scope.

For both publish paths, the workflow:

- Uses `actions/setup-node` with the registry URL and `scope: @signicode` for the active publish target.
- Uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` for GitHub Packages publish.
- Uses npm trusted publishing with `id-token: write` for npmjs.org publish.
- Publishes GitHub Packages with `npm publish --access public` so package pages and installs can be public after the repository launch.
- Uploads the validation job's `dist/packages` tree and Python distribution directory, then downloads those artifacts in the publish job instead of running a second full `npm run build` / `npm run stage:packages` cycle.
- Runs `npm pack` on staged packages and consumes staged/tarball package sources in local validation.
- Runs automated tarball behavior tests before the pull-request validation job completes.
- Re-runs staged consumer validation, import-only tarball consumer validation, and automated tarball behavior tests after applying the publish version so internal package dependencies point at the same published version.
- Runs automated tarball behavior tests before any `npm publish` command executes.
- Optionally runs GitHub Packages consumer validation with `VERSER_RUN_GITHUB_CONSUMER_TESTS=1`.
- Avoids npmjs.org publication on automatic push, tag, nightly, and pull-request paths.

The Python Guest package is built as a native Python source distribution and
pure-Python wheel under `packages/verser2-guest-python/dist/python`. Publish runs
upload those files as a workflow artifact named for the computed package version.
Tag publishes also attach the same files to the GitHub Release so Python users
can install from the release asset URL when the package is not available from a
Python package index.

Manual validation steps (first-time publish):

1. Merge a package-affecting pull request to `main` and confirm the publish job uses the SHA build version with the `main-sha` dist-tag.
2. Confirm a Conductor-only pull request does not run package build/test/publish jobs.
3. Confirm release-procedure or package-publishing documentation changes run validation without publishing packages.
4. Trigger or observe a scheduled nightly run and confirm the `nightly` dist-tag behavior.
5. Push a release-style tag like `v1.2.3` and confirm stable publish metadata.
6. Push a prerelease tag like `v1.2.3-next.0` and confirm the `next` dist-tag behavior.
7. Set `VERSER_RUN_GITHUB_CONSUMER_TESTS=1` and verify GitHub Packages install checks pass from the workflow logs.
8. Configure `npmjs-release` required reviewers and npm trusted publishing before running the npmjs workflow path.
9. Run a manual npmjs dry run with `publish_npmjs: true`, `npmjs_dry_run: true`, and the intended version before the first real public publish.

If GitHub Packages validation is intentionally disabled, confirm the step logs a skip reason instead of failing.

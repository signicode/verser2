# Package publishing runbook

This runbook describes the release-engineering helpers for preparing Verser2 workspace packages for GitHub Packages validation. It does not change Host, Guest, Broker, Peer, HTTP routing, or streaming behavior.

For the end-to-end release commit, tag, publish, and post-release bump procedure, see [Release procedure](./release-procedure.md).

## Version and dist-tag policy

Use `npm run package:version-policy` to inspect how a package version maps to publish metadata.

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

Main-merge GitHub Packages builds use a deterministic SHA prerelease version. The helper strips any prerelease from the current package version and appends a normalized short SHA:

```sh
npm run package:version-policy -- --version 1.2.3 --main-build --sha abcdef1234567890 --json
```

The computed version uses this shape:

```text
<base-version>-sha.<shortsha>
```

For example, `1.2.3-next.0` and SHA `ABCDEF1234567890` become `1.2.3-sha.abcdef123456`.

## Applying versions to staged packages

Build and stage packages first:

```sh
npm run build
npm run stage:packages
```

Then apply a computed main-build version to staged manifests only:

```sh
npm run package:version-policy -- --version 1.2.3 --main-build --sha abcdef1234567890 --apply-staged --json
```

This mutates only generated package manifests under `dist/packages`. It does not mutate source workspace `package.json` files.

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

This track prepares the repository for future npmjs publishing, but npmjs publish execution is out of scope. The version-policy helper does not run `npm publish` and reports `npmJsPublishAllowed: false`.

Future npmjs release work should reuse the same stable/prerelease tag policy:

- stable versions publish with `latest`;
- prerelease versions publish with `next`.

## GitHub Actions package publish workflow

A GitHub Actions workflow publishes staged artifacts to GitHub Packages:

- `.github/workflows/package-publish.yml`

Behavior summary:

- Pull requests to `main`: build, stage, pack, run local package-consumer tests, and run automated tarball behavior tests. Pull-request workflow runs must never publish packages to GitHub Packages.
- Pushes to `main`: run the same validation flow, upload the validated build/staging output for reuse by the publish job, compute a deterministic main-build version, re-run staged, import-only tarball, and automated tarball behavior tests after applying that version, then publish with `next` dist-tag. Pull-request commits do not publish; only accepted main updates publish SHA-labeled package versions.
- Pushes for tags matching `v*`: run the same flow, reuse the validated build/staging output, re-run staged, import-only tarball, and automated tarball behavior tests after applying the tag-decoded version, then publish using stable/pre-release dist-tags from policy.

For both publish paths, the workflow:

- Uses `actions/setup-node` with `registry-url: https://npm.pkg.github.com` and `scope: @signicode`.
- Uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` for publish.
- Uploads the validation job's `dist/packages` tree and Python distribution directory, then downloads those artifacts in the publish job instead of running a second full `npm run build` / `npm run stage:packages` cycle.
- Runs `npm pack` on staged packages and consumes staged/tarball package sources in local validation.
- Runs automated tarball behavior tests before the pull-request validation job completes.
- Re-runs staged consumer validation, import-only tarball consumer validation, and automated tarball behavior tests after applying the publish version so internal package dependencies point at the same published version.
- Runs automated tarball behavior tests before any `npm publish` command executes.
- Optionally runs GitHub Packages consumer validation with `VERSER_RUN_GITHUB_CONSUMER_TESTS=1`.
- Avoids `npm publish` to npmjs.org.

The Python Guest package is built as a native Python source distribution and
pure-Python wheel under `packages/verser2-guest-python/dist/python`. Publish runs
upload those files as a workflow artifact named for the computed package version.
Tag publishes also attach the same files to the GitHub Release so Python users
can install from the release asset URL when the package is not available from a
Python package index.

Manual validation steps (first-time publish):

1. Push a normal commit to `main` and confirm publish job uses the SHA build version.
2. Push a release-style tag like `v1.2.3` and confirm stable publish metadata.
3. Push a prerelease tag like `v1.2.3-next.0` and confirm the `next` dist-tag behavior.
4. Set `VERSER_RUN_GITHUB_CONSUMER_TESTS=1` and verify GitHub Packages install checks pass from the workflow logs.

If GitHub Packages validation is intentionally disabled, confirm the step logs a skip reason instead of failing.

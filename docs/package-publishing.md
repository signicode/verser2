# Package publishing runbook

This runbook describes the release-engineering helpers for preparing Verser2 workspace packages for GitHub Packages validation. It does not change Host, Guest, Broker, Peer, HTTP routing, or streaming behavior.

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

## Local staging, packing, and consumer tests

Run the full local package-readiness flow before publishing:

```sh
npm run build
npm run stage:packages
node --test test/package-publish-readiness.test.js
npm run test:package-consumers -- --source=source
npm run test:package-consumers -- --source=staging
npm run test:package-consumers -- --source=tarball
```

The default test command also stages packages before running the repository test suite:

```sh
npm test
```

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

- Pull requests to `main`: build, stage, pack, and run local package-consumer tests; no publish.
- Pushes to `main`: run the same validation flow, compute a deterministic main-build version, and publish with `next` dist-tag. Pull-request commits do not publish; only accepted main updates publish SHA-labeled package versions.
- Pushes for tags matching `v*`: run the same flow, publish the tag-decoded version using stable/pre-release dist-tags from policy.

For both publish paths, the workflow:

- Uses `actions/setup-node` with `registry-url: https://npm.pkg.github.com` and `scope: @signicode`.
- Uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` for publish.
- Runs `npm pack` on staged packages and consumes staged/tarball package sources in local validation.
- Re-runs staged and tarball consumer validation after applying the publish version so internal package dependencies point at the same published version.
- Optionally runs GitHub Packages consumer validation with `VERSER_RUN_GITHUB_CONSUMER_TESTS=1`.
- Avoids `npm publish` to npmjs.org.

Manual validation steps (first-time publish):

1. Push a normal commit to `main` and confirm publish job uses the SHA build version.
2. Push a release-style tag like `v1.2.3` and confirm stable publish metadata.
3. Push a prerelease tag like `v1.2.3-next.0` and confirm the `next` dist-tag behavior.
4. Set `VERSER_RUN_GITHUB_CONSUMER_TESTS=1` and verify GitHub Packages install checks pass from the workflow logs.

If GitHub Packages validation is intentionally disabled, confirm the step logs a skip reason instead of failing.

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

## npmjs publishing boundary

This track prepares the repository for future npmjs publishing, but npmjs publish execution is out of scope. The version-policy helper does not run `npm publish` and reports `npmJsPublishAllowed: false`.

Future npmjs release work should reuse the same stable/prerelease tag policy:

- stable versions publish with `latest`;
- prerelease versions publish with `next`.

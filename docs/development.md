# Development guide

This guide keeps repository-development instructions separate from package
consumer documentation.

## Repository layout

`verser2` is an npm workspace monorepo using `packages/*` for package sources
and `test/` for repository-level integration and packaging tests.

Implemented packages:

- `@signicode/verser-common` in `packages/verser-common`
- `@signicode/verser2-guest-js-common` in `packages/verser2-guest-js-common`
- `@signicode/verser2-host` in `packages/verser2-host`
- `@signicode/verser2-guest-node` in `packages/verser2-guest-node`
- `@signicode/verser2-guest-bun` in `packages/verser2-guest-bun`
- `@signicode/verser2-guest-python` in `packages/verser2-guest-python`

## Setup and validation commands

Use npm for repository commands. Node.js `>=20` is required.

```sh
npm install
npm run build
npm test
npm run test:bounded
npm run test:coverage
npm run lint
```

`npm test` builds all packages, stages publish-ready packages under
`dist/packages`, then runs the Node test suite.

`npm run test:bounded` preserves the same full validation flow while running the
Node-based build, staging, and test commands with a default 512 MiB V8 old-space
heap limit (`--max-old-space-size=512`) and an explicit semi-space size. Use it
when diagnosing memory growth, validating suspected OOM fixes, or running the
full suite on memory-constrained developer machines. It intentionally avoids a
low virtual-memory cap because Node and npm wrappers may reserve more address
space than they actively use.

Run a focused repository test file after building and staging when package
artifacts are needed:

```sh
npm run build
npm run stage:packages
node --test test/<name>.test.js
```

The bounded runner also accepts focused test files after `--`:

```sh
npm run test:bounded -- -- test/<name>.test.js
npm run test:bounded:coverage
```

Node heap limits apply to Node subprocesses started by the bounded runner through
`NODE_OPTIONS`. Bun and Python/`uv` integration tests run in their own runtimes;
they should use runtime-specific timeouts and cleanup behavior rather than an
unsafe inherited virtual-memory cap. Prefer focused Bun or Python validation when
diagnosing those paths, and keep output/timeouts bounded so failed subprocesses do
not leak handles or accumulate unbounded logs.

## Package staging

Build before staging packages:

```sh
npm run build
npm run stage:packages
```

The staging command creates publish-ready package directories under
`dist/packages/<safe-package-name>`. Staged packages include built entrypoints,
declarations, license files, publish-only manifests, and package READMEs.

Package README links are rewritten during staging so links to repository docs
point at GitHub `blob/<sha-or-tag>/...` URLs. By default the ref is the current
Git commit SHA. Set `VERSER_PACKAGE_DOCS_REF` when staging a tag-based release:

```sh
VERSER_PACKAGE_DOCS_REF=v1.2.3 npm run stage:packages
```

## Package validation

Run package readiness and consumer checks after building and staging:

```sh
node --test test/package-publish-readiness.test.js
npm run test:package-consumers -- --source=source
npm run test:package-consumers -- --source=staging
npm run test:package-consumers -- --source=tarball
npm run test:package-tarballs
```

See [Package publishing](./package-publishing.md) for the GitHub Packages runbook
and version/dist-tag policy.

## Documentation boundaries

- Root and package READMEs are concise package-consumer entry points.
- Task-focused usage docs live under `docs/`.
- Release and packaging process docs remain separate from API usage docs.
- Do not describe HTTP/3, browser/Rust/Go/Java Guests, Python Host behavior,
  WebSocket forwarding, or complete gateway authorization as implemented.

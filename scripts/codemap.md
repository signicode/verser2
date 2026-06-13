# scripts/

## Responsibility

Release-engineering and CI helper scripts for the Verser2 monorepo. Handle package staging (building publish-ready directory trees under `dist/packages/`), version/dist-tag policy computation, consumer import validation (CJS/ESM/TypeScript), and tarball-based integration testing.

These scripts are invoked from root `package.json` scripts and the CI workflow (`.github/workflows/package-publish.yml`). They operate on the on-disk workspace, not on running servers or network services.

## Design/Patterns

- **5 standalone Node.js scripts**, each with `--help` / `--json` support for CLI and machine-readable output. No shared module framework — each script is self-contained or requires specific helper modules directly.
- **Central staging directory** — `dist/packages/<safe-package-name>/` holds publish-ready per-package directories. Safe name conversion: `@scope/name` → `scope-name`.
- **Explicit package enumeration** — Every script lists the 6 workspace packages explicitly (`verser-common`, `verser2-guest-js-common`, `verser2-host`, `verser2-guest-node`, `verser2-guest-bun`, `verser2-guest-python`). No dynamic workspace discovery.
- **Deterministic version computation** — `package-version-policy.js` derives dist-tags (`latest`/`next`) and main-build SHA versions (`<base>-sha.<shortsha>`). Written as both CLI and importable module with unit tests.
- **README link rewriting** — `stage-packages.js` rewrites relative doc links to GitHub blob URLs using the current commit SHA (or `VERSER_PACKAGE_DOCS_REF` env var). This ensures published package READMEs resolve correctly.
- **Temp project isolation** — Consumer validation and tarball tests create temporary npm projects in `os.tmpdir()`, install/symlink packages, run checks, and clean up. No side effects on the workspace.
- **Required/forbidden export assertions** — `test-package-consumers.js` validates that staged/tarball/GitHub packages expose expected public names and hide internal symbols.

## Data & Control Flow

```
stage-packages.js (npm run stage:packages)
  ├─ for each of 6 packages:
  │    ├─ read source package.json, dist/index.js, dist/index.d.ts, LICENSE, README.md
  │    ├─ rewrite README relative links → GitHub blob URLs
  │    ├─ build staged manifest (publish-only package.json subset)
  │    └─ write to dist/packages/<safe-name>/
  └─ output: dist/packages/ with 6 subdirectories

package-version-policy.js (npm run package:version-policy)
  ├─ CLI: --version, --main-build, --sha, --apply-staged, --json
  ├─ determineDistTag(version)   → "latest" | "next"
  ├─ deriveMainBuildVersion()    → "<base>-sha.<shortsha>"
  └─ applyVersionToStagedPackages() → writes version into staged package.json manifests

test-package-consumers.js (npm run test:package-consumers)
  ├─ --source=source|staging|tarball|github
  ├─ createTempProject() + set up package source (symlink / install)
  ├─ for each package: writeProbeScripts() → CJS/ESM/TypeScript import tests
  │    └─ run with node --require / node --import / tsc --noEmit
  └─ output: pass/fail per package per module format

test-package-tarballs.js (npm run test:package-tarballs)
  ├─ packStagedPackages() → npm pack each staged dir into temp tarballs
  ├─ installTarballs() → npm install tarballs in temp consumer project
  ├─ writeBehaviorTest() → copy reusable test files (common-envelope, common-protocol, end-to-end) + behavior test
  └─ run node --test against copied test files

copy-package-license.js
  └─ copies LICENSE from package root to dist/ directory (used by individual package build scripts)
```

## Integration

- **Root package.json** — All scripts are wired as npm scripts: `build`, `test`, `stage:packages`, `package:version-policy`, `test:package-consumers`, `test:package-tarballs`, `lint`.
- **npm test chain** — `npm test` runs `build && stage:packages && node --test test/*.test.js`. The stage step must succeed before tests that validate staged artifacts.
- **CI workflow** — `.github/workflows/package-publish.yml` calls stage, version-policy, consumer checks, and tarball tests in sequence during validation and publish jobs.
- **Staging directory** — `dist/packages/` is consumed by `test/package-publish-readiness.test.js` (staged artifact assertions), `test-package-consumers.js` (staging and tarball source modes), and `test-package-tarballs.js`.
- **Python package** — The Python package (`verser2-guest-python`) is included in the explicit package list for staging, consumer validation, and tarball testing. Its `dist/index.js` bridge is built by `scripts/build.mjs` inside the package directory.

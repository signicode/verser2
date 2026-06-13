# test/

## Responsibility

Repository-level integration, packaging, publishing workflow, and documentation assertion tests. These tests validate the entire monorepo from a consumer and operator perspective — they run `npm test` after build+stage, test workspace configuration, staged package artifacts, CI workflow correctness, documentation coverage, Python Guest/Broker integration, end-to-end routing with TLS fixtures, and tarball-based consumer simulation.

They do **not** include per-package unit tests (those live in each package's own test directory, e.g., `packages/verser2-guest-python/tests/`).

## Design/Patterns

- **`node:test` framework** — All test files use Node's built-in `node:test` (via `test()` / `describe()` / `it()`). No Jest, Mocha, or Ava. Run with `node --test test/*.test.js`.
- **`node:assert/strict`** — Assertions use Node's strict assertion module. No external assertion libraries.
- **Flat file structure** — 26+ test files in `test/` root (no nested test subdirectories). Supporting modules in `test/support/`. Fixtures in `test/fixtures/` (TLS certificates).
- **Integration-heavy** — These tests typically build and stage packages (`npm run build && npm run stage:packages`), then assert properties of the resulting artifacts. Few tests start network services; those that do (end-to-end, host, guest) use ephemeral ports and TLS test fixtures.
- **Python test delegation** — Python-specific tests (`python-guest-integration`, `python-broker-tls-integration`) run Python `unittest` suites via `uv run` in a subprocess, asserting `process.exitCode === 0`.
- **Fake/mock transports** — Transport-level tests (guest, agent, dispatcher, broker) use in-memory fake streams, `PassThrough`, and event fakes rather than real TLS connections. An explicit EOF/end signal is required to avoid infinite read-loop hangs (documented in `docs/common-issues.md`).
- **Documentation as tests** — `docs.test.js` and `python-guest-documentation.test.js` read markdown files and assert that specific terms, API names, and patterns are present or absent. This codifies documentation requirements as executable assertions.

## Data & Control Flow

```
npm test  (root package.json)
  └─ npm run build
  └─ npm run stage:packages  → populates dist/packages/
  └─ node --test test/*.test.js

Test file categories:
├── Workspace configuration
│   ├── workspace.test.js        — root package.json, tsconfig.json, biome.json assertions
│   ├── packages.test.js         — all 6 package.json manifests
│   └── package-workflow.test.js — CI workflow YAML structure and steps
│
├── Packaging & publishing
│   ├── package-publish-readiness.test.js — staged artifact files, manifest fields, npm pack dry-run
│   ├── package-version-policy.test.js    — dist-tag/SHA computation, staged version application
│   ├── package-consumer-imports.test.js  — CJS/ESM/TS imports from workspace source
│   └── package-tarball-tests.test.js     — tarball behavior test runner
│
├── Runtime integration
│   ├── end-to-end.test.js          — Host + Node Guest + Broker + Agent + fetch
│   ├── host.test.js                — Host lifecycle and routing
│   ├── local-peers.test.js         — Host-side in-process local Guest/Broker attach, routing, interop, streaming, errors
│   ├── guest-node.test.js          — Node Guest dispatch
│   ├── broker-routing.test.js      — Broker route management
│   ├── agent.test.js               — Agent behavior
│   ├── dispatcher.test.js          — Dispatcher behavior
│   ├── common-envelope.test.js     — common protocol envelope encoding
│   ├── common-protocol.test.js     — common protocol helpers
│   └── tls-configuration.test.js   — Host TLS config scenarios
│
├── Python integration
│   ├── python-guest-integration.test.js           — Python Guest with TLS Host
│   ├── python-broker-tls-integration.test.js      — Python Broker TLS/mTLS
│   ├── python-guest-documentation.test.js         — Python docs coverage assertions
│   └── python-guest-package-scaffold.test.js      — Python package imports and structure
│
├── Documentation
│   ├── docs.test.js                — Root/Bun docs content assertions
│   └── python-guest-documentation.test.js — Python docs content assertions
│
├── Runtime variants
│   ├── bun-guest-integration.test.js — Bun Guest with Host
│   └── package-workflow.test.js      — CI workflow structure
│
└── Support modules (test/support/)
    ├── child-process.cjs            — subprocess helper
    ├── tls-fixtures.cjs             — TLS cert generation and loading
    └── verser-package-imports.cjs   — package import test helpers
```

## Integration

- **All 6 workspace packages** — Tests import from `@signicode/verser-common`, `verser2-host`, `verser2-guest-js-common`, `verser2-guest-node`, `verser2-guest-bun`, and `verser2-guest-python` (via its npm dist bridge).
- **docs/** — `docs.test.js` and `python-guest-documentation.test.js` read and assert against markdown files in `docs/`.
- **scripts/** — `package-version-policy.test.js` imports `scripts/package-version-policy.js` as a module; other tests may invoke scripts via `execFileSync`.
- **.github/workflows/** — `package-workflow.test.js` reads the CI workflow YAML and asserts its structure.
- **dist/packages/** — `package-publish-readiness.test.js` reads staged package directories.
- **test/package-tarball/** — Contains `behavior.test.cjs`, a reusable test file that `scripts/test-package-tarballs.js` copies into temporary consumer projects.
- **test/fixtures/** — TLS certificate files (PEM) used by end-to-end, host, guest, and Python integration tests for TLS HTTP/2 connections.

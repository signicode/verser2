# Tech Stack

## Project Structure

`verser2` is configured as an npm workspace monorepo using `packages/*` for package implementations and `test/` for tests.

Implemented package targets:

- `@signicode/verser-common` in `packages/verser-common`: Shared TypeScript primitives, protocol envelopes, registration/control contracts, route lifecycle and Guest revocation contracts, routing helpers, header serialization/protocol-header helpers, serialized error response helpers, NDJSON helpers, lifecycle names, contextual errors, HTTP/2 helpers, certificate fingerprint helpers, certificate identity extraction, mTLS registration authorization types, and TLS option normalization helpers for Verser packages.
- `@signicode/verser2-host` in `packages/verser2-host`: Configurable TLS HTTP/2 Verser2 Host implementation with Guest/Broker registration, optional mTLS client certificate enforcement, registration and upstream federation authorization callbacks, routed-domain advertisements, Guest-owned route revocation, degraded-route timeout cleanup, local-first route candidate registry, upstream Host link lifecycle, route import/export, route lifecycle propagation, federated request forwarding, new-request HA fallback, route cleanup, certificate reload support, and Broker request forwarding.
- `@signicode/verser2-guest-node` in `packages/verser2-guest-node`: Node.js Guest route revocation, Broker route-change observation, configurable Host TLS trust, configurable PEM/PFX client certificate identities, minimal plain `node:http` Agent implementation, Undici Dispatcher/fetch helpers, and default-on internal `307`/`308` Broker redirect following for advertised route hostnames with configurable replay buffer and hop limits.
- `@signicode/verser2-guest-bun` in `packages/verser2-guest-bun`: Bun Guest and Bun-facing Broker APIs compatible with Bun/Fetch handlers and local Bun-style routes, reusing the existing JavaScript/Node transport for outbound TLS HTTP/2 Host connectivity, route advertisement/revocation, lifecycle observation, Agent, Dispatcher, fetch, and mTLS behavior.
- `@signicode/verser2-guest-python` in `packages/verser2-guest-python`: Python ASGI Guest and async Broker implementation using `uv` for Python package commands, `h2` for outbound TLS HTTP/2 Guest/Broker transport, Guest route revocation, Broker route-change observation, and `cryptography` for Python Broker PFX/PKCS12 client identity loading.

Future package targets:

- `packages/verser2-guest-browser`: Browser Guest library using Fetch API concepts.
- `packages/verser2-guest-rust`: Rust Guest library with Hyper compatibility goals.
- `packages/verser2-guest-go`: Go Guest library compatible with `net/http` concepts.
- `packages/verser2-guest-java`: Java Guest library using `net.httpserver` or similar concepts.

## Primary Language and Runtime

- Primary language: TypeScript.
- Initial runtime: Node.js.
- TypeScript target: ES2019.
- Module system: CommonJS.
- TypeScript mode: strict, with declarations enabled.

## Core Platform APIs

- Node.js `node:http` for local HTTP/1 server compatibility and the MVP Broker-backed plain HTTP Agent.
- Node.js `node:http2` for the current TLS HTTP/2 Host, Guest, and Broker transport.
- Node.js TLS client certificate and PFX/PKCS12 support for optional mTLS on the Host/Guest/Broker HTTP/2 transport.
- Shared TypeScript package code through `@signicode/verser-common`.
- Bun `Request`, `Response`, `ReadableStream`, and route-table concepts for the Bun Guest adapter, with WebSocket forwarding explicitly deferred.
- Python `asyncio` plus `h2` for the Python ASGI Guest outbound TLS HTTP/2 transport.
- HTTP/3 behavior only when introduced by explicit future tracks.

## Tooling

- Package manager: npm.
- Python package command runner: `uv` for `packages/verser2-guest-python` commands and dependency resolution.
- Python package dependencies: `h2` for TLS HTTP/2 framing and `cryptography` for Python Broker PFX/PKCS12 mTLS client identities.
- Build command: `npm run build`.
- Package staging command: `npm run stage:packages`, which writes publish-ready package directories under `dist/packages` from built workspace artifacts, emits publish-only package manifests that omit source-only fields such as `private`, defaults staged registry metadata to npmjs.org public access, supports `VERSER_PACKAGE_REGISTRY` for GitHub Packages preview staging, and copies package READMEs with repository-relative documentation links rewritten to GitHub `blob/<sha-or-tag>/...` URLs. The default docs ref is the current Git SHA and can be overridden with `VERSER_PACKAGE_DOCS_REF` for tag-based releases.
- Package consumer validation command: `npm run test:package-consumers -- --source=<source|staging|tarball|github>`.
- Package tarball behavior validation command: `npm run test:package-tarballs`, which packs staged packages, installs the tarballs into an isolated temporary consumer project, and runs reusable automated tests against package-name imports from `node_modules`.
- Package version policy command: `npm run package:version-policy`, which maps stable tag releases to `latest`, prerelease tag releases to `next`, computes SHA-labeled merged-PR builds for the non-channel `main-sha` dist-tag, computes deterministic nightly builds for the non-channel `nightly` dist-tag, and supports manually gated npmjs candidates with stable/prerelease dist-tag safeguards without running `npm publish` itself.
- Test command: `npm run test` / `npm test` (runs the bounded-memory test flow: builds, stages packages, then runs `node:test` with guarded per-test memory-growth checks).
- Lint command: `npm run lint`.
- Formatting/linting: Biome.
- Test runner: Node.js built-in `node:test` smoke tests.
- TypeScript compiler: `typescript` with per-package composite builds.
- Type declarations: generated during package builds.
- Package bundling: `tsup` bundles each TypeScript package entrypoint to a single CommonJS `dist/index.js` and rolled-up `dist/index.d.ts` artifact after sources are split into internal modules.
- Package publish staging: generated publish-only package manifests retain runtime metadata and omit development scripts, private/workspace fields, and test-only metadata.
- GitHub Actions: `.github/workflows/package-publish.yml` validates package build/stage/pack/consumer/tarball behavior for pull requests without path filters, publishes merged package-affecting main updates as SHA-versioned GitHub Packages under `main-sha`, publishes scheduled nightly builds under `nightly`, publishes explicit `v*` tag releases to GitHub Packages and stages npmjs.org packages with `latest` or `next` according to semver, and provides a manual `workflow_dispatch` npmjs.org staging path gated by explicit input, the `npmjs-release` environment, npm trusted publishing, and stable/prerelease dist-tag policy.
- GitHub Actions: repository safeguard workflows include CodeQL for public repositories, dependency review for pull requests, Gitleaks secret scanning, and DCO-style external contributor signoff checks with maintainer/team exemptions.
- Repository governance files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS`, pull request template, issue templates, `.github/dependabot.yml`, and `.gitleaks.toml` support public collaboration and release safety.
- Documentation: package publishing and release-engineering workflow details live in `docs/package-publishing.md`.
- Documentation: TLS certificate generation and reload guidance lives in `docs/certificates.md`.
- Documentation: task-focused user guidance lives under `docs/`, repository development guidance lives in `docs/development.md`, and codemap state lives in `.slim/codemap.json` with the root atlas at `codemap.md`.

## Implementation Priorities

- Establish the TypeScript/Node Host and Guest packages first.
- Keep reusable cross-package foundations in `@signicode/verser-common`.
- Preserve normal Node.js HTTP handler ergonomics.
- Continue improving concurrent request, routing, streaming, and multiplexing behavior only in tracks that explicitly target it.
- Design interfaces so future guest runtimes can map to their native HTTP primitives.
- Keep HTTP/3 optional until runtime and platform support is mature enough for reliable implementation.

## Exclusions for Initial MVP

- Browser, Rust, Go, and Java guest packages are roadmap items, not blockers for the current implemented package set.
- Database drivers are not part of the currently inferred stack.
- Frontend framework dependencies are not part of the currently inferred stack.

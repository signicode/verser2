# Tech Stack

## Project Structure

`verser2` is configured as an npm workspace monorepo using `packages/*` for package implementations and `test/` for tests.

Implemented TypeScript/Node package targets:

- `@signicode/verser-common` in `packages/verser-common`: Shared TypeScript primitives, protocol envelopes, lifecycle names, contextual errors, HTTP/2 helpers, and development TLS helpers for Verser packages.
- `@signicode/verser2-host` in `packages/verser2-host`: Minimal TLS HTTP/2 Verser2 Host implementation with Guest/Broker registration, routed-domain advertisements, route cleanup, and Broker request forwarding.
- `@signicode/verser2-guest-node` in `packages/verser2-guest-node`: Node.js Guest, Broker, and minimal plain `node:http` Agent implementation.

Future package targets:

- `packages/verser2-guest-browser`: Browser Guest library using Fetch API concepts.
- `packages/verser2-guest-bun`: Bun Guest library compatible with `Bun.serve` concepts.
- `packages/verser2-guest-python`: Python Guest library with ASGI compatibility goals.
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
- Shared TypeScript package code through `@signicode/verser-common`.
- HTTP/3 behavior only when introduced by explicit future tracks.

## Tooling

- Package manager: npm.
- Build command: `npm run build`.
- Test command: `npm run test`.
- Lint command: `npm run lint`.
- Formatting/linting: Biome.
- Test runner: Node.js built-in `node:test` smoke tests.
- TypeScript compiler: `typescript` with per-package composite builds.
- Type declarations: generated during package builds.

## Implementation Priorities

- Establish the TypeScript/Node Host and Guest packages first.
- Keep reusable cross-package foundations in `@signicode/verser-common`.
- Preserve normal Node.js HTTP handler ergonomics.
- Continue improving concurrent request, routing, streaming, and multiplexing behavior only in tracks that explicitly target it.
- Design interfaces so future guest runtimes can map to their native HTTP primitives.
- Keep HTTP/3 optional until runtime and platform support is mature enough for reliable implementation.

## Exclusions for Initial MVP

- Non-TypeScript guest packages are roadmap items, not blockers for the first implementation track.
- Database drivers are not part of the currently inferred stack.
- Frontend framework dependencies are not part of the currently inferred stack.

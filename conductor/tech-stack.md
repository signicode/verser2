# Tech Stack

## Project Structure

`verser2` is planned as an npm workspace monorepo using `packages/*` for package implementations and `test/` for tests.

Initial package targets:

- `packages/verser2-host`: TypeScript Verser2 Host implementation.
- `packages/verser2-guest-node`: Node.js Guest library.

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

- Node.js `node:http` for local HTTP/1 server compatibility.
- HTTP/2 for the stable MVP multiplexed transport.
- HTTP/3 as a future or platform-dependent transport.

## Tooling

- Package manager: npm.
- Build command: `npm run build`.
- Test command: `npm run test`.
- Lint command: `npm run lint`.
- Formatting/linting: Biome.

## Implementation Priorities

- Establish the TypeScript/Node Host and Guest packages first.
- Preserve normal Node.js HTTP handler ergonomics.
- Support concurrent requests over multiplexed HTTP/2 streams.
- Design interfaces so future guest runtimes can map to their native HTTP primitives.
- Keep HTTP/3 optional until runtime and platform support is mature enough for reliable implementation.

## Exclusions for Initial MVP

- Non-TypeScript guest packages are roadmap items, not blockers for the first implementation track.
- Database drivers are not part of the currently inferred stack.
- Frontend framework dependencies are not part of the currently inferred stack.

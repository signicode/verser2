# Agent Notes

This repo is in early Conductor-managed setup. Use the Conductor files as the source of truth before implementing work.

## Conductor workflow
- Start by reading `conductor/index.md`, then the active track under `conductor/tracks/`.
- Current initial track: `conductor/tracks/setup_monorepo_20260606/`.
- Follow `conductor/workflow.md` for task lifecycle, validation, manual verification checkpoints, and commit policy.
- Implementation plans live in each track's `plan.md`; update task status there as work progresses.
- Commit after each completed phase, not after each individual task, and include a concise phase summary in the commit message body.
- Maintain at least 95% meaningful test coverage for changed behavior when coverage is measurable.
- Use TDD for feature work: write or update focused tests before implementation and confirm expected failures first.
- When validation fails, classify the failure using the workflow continuation protocol before deciding whether to fix, defer, or ask the user.

## Package manager
- Use `npm` for agent-run commands in this repo.
- Prefer `npm ci`, `npm install`, `npm run <script>` commands.

## High-value commands
- Install deps: `npm ci` for a clean install, `npm install` when updating the lockfile.
- Run: `npm run build` to build packages into `dist/`;
- `npm run test` runs package tests.
- Lint: `npm run lint`;

## Monorepo wiring
- Workspace is `packages/*`.
- Tests sit in `test/`

## Nomenclature

To avoid confusion, since verser2 works in reverse direction to the traditional client-server model, we use the following terms:

* Verser2 Host: The main server that guests connect to. It manages connections and routes requests between the guests.
* Verser2 Guest: A client that connects to the host. It can make requests to the host and receive requests from the host.
* Verser2 Broker: The guest component that connects to the host (or hosts) and allows making requests to other guests through the host.
* Verser2 Peer: A connected client that can send and receive requests through the host or directly to other peers if supported.

## Language variants

The package is meant for multilanguage support, but TypeScript is the primary language for the server. Client libraries in other languages may be developed later.

- packages/verser2-host: TypeScript verser host implementation.
- packages/verser2-guest-node: Node.js guest library.
- packages/verser2-guest-browser: Browser guest library (using Fetch API, node.js-like server API).
- packages/verser2-guest-bun: Bun guest library (Bun.serve compatible).
- packages/verser2-guest-python: Python guest library (asgi compatible).
- packages/verser2-guest-rust: Rust guest library (hyper compatible).
- packages/verser2-guest-go: Go guest library (net/http compatible).
- packages/verser2-guest-java: Java guest library (using net.httpserver or similar).

## Toolchain constraints
- TypeScript base is strict CommonJS targeting ES2019, with `allowJs`, decorators, declarations, and `noUnusedLocals` enabled.
- Biome is used for linting and formatting.

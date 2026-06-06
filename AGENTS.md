# Agent Notes

## Source of truth
- This repo uses Conductor; read `conductor/index.md` before implementation work.
- Active tracks, when any exist, are listed in `conductor/tracks.md`; completed track specs/plans may be under `conductor/archive/`.
- For Conductor tracks, follow `conductor/workflow.md`: TDD first, update the track `plan.md`, validate narrowly, and commit only at phase checkpoints.

## Commands
- Use npm only. Node requirement is `>=20`.
- Install: `npm ci` for clean installs; `npm install` when updating `package-lock.json` or workspaces.
- Build all packages: `npm run build` (`tsc -b packages/*`).
- Test: `npm test` (builds first, then runs `node --test test/*.test.js`).
- Focused test file after building: `npm run build && node --test test/<name>.test.js`.
- Lint/format check: `npm run lint` (`biome check .`).

## Monorepo layout
- npm workspaces are `packages/*`; root tests live in `test/`.
- Current package entrypoints are `packages/verser2-host/src/index.ts` and `packages/verser2-guest-node/src/index.ts`.
- Package builds emit `dist/`, which is ignored and should not be committed.

## Future language guests
- TypeScript/Node is the initial implementation target, but do not remove roadmap information for other guest runtimes.
- Future guest packages should remain documented as planned solutions: browser/Fetch API, Bun/`Bun.serve`, Python/ASGI, Rust/Hyper, Go/`net/http`, and Java `net.httpserver` or similar.
- Treat non-TypeScript guests as future track work unless an active Conductor track explicitly asks to implement one.

## Toolchain quirks
- TypeScript is strict CommonJS targeting ES2019 with declarations, decorators, `allowJs`, and `noUnusedLocals` enabled.
- Each package has a composite `tsconfig.json`; build output and `.tsbuildinfo` go under that package's `dist/`.
- Biome ignores `conductor/setup_state.json`, `dist`, `node_modules`, and `package-lock.json`.
- Biome enforces single quotes, semicolons, trailing commas, and no explicit `any`.

## Product terminology
- Use the repo terms precisely: Host accepts guest connections and routes requests; Guest connects outbound to a Host; Broker is the guest-side component that connects to hosts; Peer is any connected client that can send/receive through the host or directly when supported.
- Do not add HTTP/2 multiplexing, routing, or HTTP/3 behavior unless a track explicitly asks for it; current packages are scaffolds only.

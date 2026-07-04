# Outcomes: Host Implementation Large File Split

## Decisions & Rationale

- Split Host internals into focused modules while preserving `NodeHttp2VerserHost` as the orchestrator and keeping `createVerserHost()`/public exports unchanged.
- Added Host-internal modules:
  - `lease-pool.ts` for Guest lease stream pool state, acquisition queues, timeouts, and cleanup.
  - `degraded-route-cleanup.ts` for degraded-route expiration timer orchestration via Host callbacks.
  - `broker-routing.ts` for H2/local Broker dispatch, lease routing, local Guest dispatch, cancellation propagation, and federated fallback.
  - `federation.ts` for upstream handshake helpers, federated route/request stream helpers, lifecycle forwarding/tagging, route frame handling, and incoming federated request dispatch.
- Kept Host-owned maps and high-level orchestration in `node-http2-verser-host.ts` where extraction would have required broad map-ownership facades.
- Did not move Host-specific orchestration into `@signicode/verser-common`; existing protocol-neutral common helpers remain reused.

## Outcomes & Results

- `packages/verser2-host/src/lib/node-http2-verser-host.ts` was meaningfully reduced and delegates core split responsibilities to Host-internal modules.
- Public API, package exports, and protocol behavior were preserved.
- Host codemaps were updated to describe the new internal module structure.
- PR: https://github.com/signicode/verser2/pull/50

## Verification Summary

Final validation passed:

- `npm run build --workspace=@signicode/verser2-host`
- `node --test test/host.test.js test/host-route-registry.test.js test/host-upstreams.test.js`
- `node --test test/local-peers.test.js test/broker-routing.test.js`
- `node --test test/agent.test.js test/dispatcher.test.js test/guest-node.test.js`
- `npm test` — 334 total, 330 passed, 4 skipped, 0 failed
- `npm run lint`

Final @oracle review found no code blockers and confirmed readiness after bookkeeping.

## Constraints

- Behavior-preserving refactor only: no public API changes, no protocol changes, and no new runtime dependencies.
- New modules remain Host-internal and do not import `NodeHttp2VerserHost`.
- Common code stayed in `@signicode/verser-common` only where already protocol-neutral.

## Risks & Open Items

- `node-http2-verser-host.ts` remains large; additional small future cleanup could extract shared Guest registration/degraded-restoration logic.
- `degraded-route-cleanup.ts` uses an async `check()` method without awaits; future cleanup could make it synchronous or explicitly catch/report callback failures.
- `broker-routing.ts` `PeerInfo.role` could be tightened to `VerserPeerRole` in a future non-blocking cleanup.
- A minor codemap wording improvement can further avoid mentioning lease maps directly outside `LeasePool`.

## Follow-ups

- Optional future refactor: extract “apply Guest registration / restore degraded routes” helper.
- Optional future cleanup: tighten internal callback/type shapes and degraded cleanup timer error handling.

## PR / Base Branch

- PR: #50 — https://github.com/signicode/verser2/pull/50
- Base branch: `main`
- Implementation branch: `conductor/host_implementation_large_file_split_20260704`

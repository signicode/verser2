# Specification: Host Implementation Large File Split

## Overview

Refactor the large Host implementation in `packages/verser2-host/src/lib/node-http2-verser-host.ts` into smaller Host-internal modules while preserving public API and runtime behavior. The track addresses the tech debt recorded in `conductor/archive/verser2-tunneling-ha-upstreams_20260615/outcomes.md`: the Host file has grown large and should extract federation links, route streams, request forwarding, lease routing, and local peer coordination into smaller units.

This is a behavior-preserving refactor track. Small internal cleanup is acceptable only when it keeps external behavior unchanged and is proven by focused and full validation.

## Functional Requirements

1. Split the Host implementation along clear internal responsibility boundaries.
   - Extract federation/upstream-link and federated route/request handling where practical.
   - Extract broker request routing and lease-based local Guest routing where practical.
   - Extract Guest lease pool management where practical.
   - Extract degraded-route cleanup/timer handling where practical.
2. Keep `NodeHttp2VerserHost` as the internal orchestration class and preserve the existing `createVerserHost()` factory behavior.
3. Preserve all public exports and interfaces from `@signicode/verser2-host`.
4. Preserve route registration, route revocation, degraded-route timeout, route lifecycle events, Broker route advertisements, local peer behavior, upstream federation, federated request forwarding, and close/error semantics.
5. Avoid moving Host-specific orchestration into `@signicode/verser-common`; only reuse common helpers already appropriate for protocol-neutral behavior.
6. Update the Host codemap to describe any new internal modules and their responsibilities.
7. Record split boundaries, validation results, and any intentionally deferred extraction in the Conductor plan notes.

## Non-Functional Requirements

1. No public API change.
2. No protocol behavior change.
3. No new runtime dependencies.
4. Avoid circular dependencies between new Host-internal modules.
5. Preserve cleanup ordering and lifecycle semantics, especially around `close()`, session disconnects, upstream disconnects, lease cleanup, route advertisement, and degraded-route expiration.
6. Keep extracted modules internal to the Host package unless a clearly reusable Host-internal type belongs in `types.ts`.
7. Maintain TypeScript strictness, lint cleanliness, and existing test coverage expectations.

## Acceptance Criteria

1. `packages/verser2-host/src/lib/node-http2-verser-host.ts` is meaningfully smaller and delegates at least the core split responsibilities to focused internal modules.
2. The refactor preserves existing public package exports and `createVerserHost()` construction semantics.
3. Focused Host validations pass, including Host build and Host route/federation/routing/local-peer tests.
4. End-to-end Host path validations pass, including Agent, Dispatcher, and Guest Node routing tests.
5. Final validation passes with `npm test` and `npm run lint`.
6. Host codemap documentation reflects the new internal file/module structure.
7. The implementation records any extraction that remains intentionally deferred, with rationale.

## Out of Scope

1. Per-request Broker target authorization.
2. New federation behavior or HA semantics.
3. WebSocket, CONNECT, generic stream tunneling, or HTTP/3 support.
4. Public API changes to Host, Guest, Broker, or common packages.
5. User-facing documentation changes beyond codemap/internal architecture documentation.
6. Large local peer behavior redesign unless strictly needed to make the core split safe.

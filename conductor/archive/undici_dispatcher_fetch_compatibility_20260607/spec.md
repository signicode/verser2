# Specification: Undici Dispatcher and Fetch Helper Compatibility

## Overview

Implement Undici `Dispatcher` compatibility for the Node Broker so users can call Verser-routed guest services through `fetch` without DNS or inbound ports. The primary public APIs are `broker.createDispatcher()`, returning an Undici-compatible dispatcher that routes requests through the existing `VerserBroker.request(...)` primitive, and `broker.createFetch()`, returning a convenience fetch function preconfigured to use that dispatcher.

This track also extracts a new TypeScript workspace package, `@signicode/verser2-guest-js-common`, to hold reusable JavaScript guest foundations for route resolution, request/response typing, header normalization, abstract dispatch structure, and stream conversion helpers that can support future browser-compatible guests. The new common package must remain runtime-neutral and must not import `node:*`, `node:http`, `node:http2`, `node:stream`, or `undici`.

## Context

Current relevant implementation lives in `packages/verser2-guest-node/src/index.ts`:

- `VerserBroker` exposes `connect`, `close`, `createAgent`, `getRoutes`, `waitForRoute`, and `request`.
- `Http2VerserBroker.request(...)` is the core routing primitive used by the existing `node:http` Agent path.
- `VerserBrokerAgent` and `VerserBrokerSocket` provide plain `node:http` compatibility and should remain Node-specific.
- The new Dispatcher implementation should reuse the same advertised-domain route matching and broker request path rather than creating a second transport path.

## Functional Requirements

1. Add Node guest public APIs for fetch compatibility:
   - Extend `VerserBroker` with `createDispatcher(): Dispatcher`.
   - Extend `VerserBroker` with `createFetch(): typeof fetch` or an equivalent Undici fetch-compatible function type.
   - Implement both methods on the Node Broker implementation.
   - Return a Node-specific `VerserBrokerDispatcher` from `createDispatcher()`.
   - Return a convenience fetch function from `createFetch()` that uses the Broker dispatcher by default while preserving normal fetch call semantics.
   - Keep `createAgent()` behavior unchanged.

2. Add `@signicode/verser2-guest-js-common`:
   - Add a new npm workspace package under `packages/verser2-guest-js-common`.
   - Depend on `@signicode/verser-common` only.
   - Export runtime-neutral route, request, response, header, abstract dispatch, and stream-conversion helpers useful to Node and future browser-compatible guest code.
   - Update root TypeScript project references and workspace/package tests as needed.

3. Route Undici requests through the existing Broker path:
   - Parse Dispatcher request origin and path.
   - Resolve the request hostname against advertised Broker routes.
   - Forward method, path, headers, and request body to `broker.request(...)`.
   - Preserve response status code, headers, and body through Undici handler callbacks.
   - Report missing routes through the Undici handler error path.

4. Preserve HTTP semantics:
   - Preserve method, path, query string, headers, request body, response status, response headers, and response body.
   - Support common fetch request bodies including buffered/string bodies and stream-like bodies where Undici provides them.
   - Preserve response streaming without unnecessary full-response buffering where the current Broker response body is streaming.

5. Support cancellation:
   - Handle AbortSignal/client cancellation where exposed by Undici dispatch options and fetch inputs.
   - Propagate cancellation to request body/response handling where feasible.
   - Ensure aborts surface as actionable errors and do not leave dangling streams.

6. Add tests and examples sufficient for the new API:
   - Add focused tests mirroring existing `test/agent.test.js` coverage for fetch/Dispatcher behavior.
   - Add end-to-end coverage through Host, Guest, Broker, Dispatcher, and `createFetch()` using existing Host behavior only.
   - Update package export tests for the new package and public APIs.
   - Validate streaming request/response behavior where feasible.

## Non-Functional Requirements

- Keep the new common package runtime-neutral and browser-friendly.
- Keep Undici as a Node guest dependency only.
- Avoid adding browser guest implementation in this track.
- Preserve existing Node Agent behavior and tests.
- Preserve existing Host behavior and avoid host-side implementation changes.
- Keep public API small and aligned with Verser2 Host/Guest/Broker terminology.
- Follow the repository's strict TypeScript, CommonJS, npm workspace, and Biome conventions.
- Maintain at least 95% meaningful coverage for changed behavior or record why coverage cannot be measured.

## Acceptance Criteria

- `createVerserBroker(...).createDispatcher()` returns an Undici-compatible Dispatcher.
- `createVerserBroker(...).createFetch()` returns a fetch-compatible function preconfigured for Verser routing.
- Undici `fetch(url, { dispatcher })` can call a routed guest service by advertised hostname without DNS resolution.
- The `createFetch()` helper can call the same routed guest service without manually passing a dispatcher for each request.
- Fetch requests preserve method, path, query, headers, and body through the Verser Broker route.
- Fetch responses preserve status, headers, and body.
- Missing advertised routes reject or error through the expected Undici/fetch path with clear context.
- Streaming request and response behavior is tested and works within the current Broker streaming model.
- Abort/cancellation behavior is implemented and covered by focused tests where feasible.
- `@signicode/verser2-guest-js-common` builds and exports the agreed runtime-neutral primitives/helpers.
- `@signicode/verser2-guest-node` depends on and reuses JS common where appropriate.
- Existing Agent, Broker, Guest, Host, package, and end-to-end tests continue to pass.
- `npm run build`, focused tests, `npm test`, and `npm run lint` pass before phase completion.

## Out of Scope

- Any Host-side implementation changes.
- Browser guest implementation.
- Replacing the existing `node:http` Agent compatibility path.
- HTTP/2 multiplexing changes beyond the existing Broker request behavior.
- CONNECT, upgrade, WebSocket, or advanced TLS target-domain semantics.
- HTTP/3 support.
- Public gateway policy, authentication, or authorization changes.

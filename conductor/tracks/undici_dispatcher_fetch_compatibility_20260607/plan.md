# Implementation Plan: Undici Dispatcher and Fetch Helper Compatibility

## Phase 1: JS Common Package Scaffold and Shared Primitives

- [x] Task: Confirm package boundaries and reusable foundations
    - [x] Review `@signicode/verser-common` for reusable route, header, error, and envelope primitives before adding new package-local code.
    - [x] Confirm `@signicode/verser2-guest-js-common` will contain no `node:*`, `node:http`, `node:http2`, `node:stream`, or `undici` imports.
    - [x] Record that Host-side implementation changes are out of scope for this track.
- [x] Task: Write failing package and export tests first
    - [x] Add or update package/workspace tests expecting `@signicode/verser2-guest-js-common` to exist and export runtime-neutral primitives.
    - [x] Add tests expecting `@signicode/verser2-guest-node` to expose `createDispatcher()` and `createFetch()` through the Broker API.
    - [x] Run the narrowest package/export test command and confirm the new assertions fail for the expected reason.
- [x] Task: Create `@signicode/verser2-guest-js-common`
    - [x] Add package manifest, composite `tsconfig.json`, and `src/index.ts` entrypoint.
    - [x] Add root TypeScript project reference for the new workspace package.
    - [x] Update package-lock/workspace metadata using npm when required.
- [x] Task: Implement runtime-neutral shared primitives
    - [x] Add route types and route resolution helpers for advertised domains.
    - [x] Add common broker request/response types parameterized by body type.
    - [x] Add header normalization helpers suitable for Dispatcher/fetch inputs without Node-only dependencies.
    - [x] Add abstract dispatch/fetch-like base structure for future browser-compatible implementations.
    - [x] Add stream conversion helper types/utilities that remain runtime-neutral.
- [x] Task: Validate Phase 1
    - [x] Run `npm run build` or the narrowest reliable package build covering the new package.
    - [x] Run focused package/export tests.
    - [x] Run `npm run lint` if formatting/static checks are affected.
    - [x] Record coverage status or why coverage cannot be measured for scaffold-only shared primitives.
- [x] Task: Conductor - User Manual Verification 'Phase 1: JS Common Package Scaffold and Shared Primitives' (Protocol in workflow.md)

## Phase 2: Node Broker Dispatcher and Fetch Helper Tests

- [x] Task: Confirm affected Node guest API and test targets
    - [x] Review `packages/verser2-guest-node/src/index.ts` Broker interfaces and `Http2VerserBroker` implementation.
    - [x] Review existing `test/agent.test.js`, `test/end-to-end.test.js`, and `test/broker-routing.test.js` coverage for analogous Agent and Broker behavior.
    - [x] Confirm common package helpers from Phase 1 are reused where appropriate before writing Node-specific code.
- [x] Task: Write failing focused Dispatcher tests first
    - [x] Add tests proving `broker.createDispatcher()` returns an Undici-compatible dispatcher.
    - [x] Add tests proving Undici `fetch(url, { dispatcher })` routes to an advertised guest hostname without DNS resolution.
    - [x] Add tests for method, path, query string, headers, request body, response status, response headers, and response body preservation.
    - [x] Add a missing-route test expecting a clear Undici/fetch error path.
    - [x] Run the focused Dispatcher test command and confirm failures are for missing implementation.
- [x] Task: Write failing `createFetch()` tests first
    - [x] Add tests proving `broker.createFetch()` returns a fetch-compatible function.
    - [x] Add tests proving the returned fetch helper routes through the Broker without manually passing a dispatcher per request.
    - [x] Add tests proving explicit caller fetch options are preserved when the helper injects the dispatcher.
    - [x] Run the focused fetch-helper test command and confirm failures are for missing implementation.
- [x] Task: Write failing streaming and cancellation tests first
    - [x] Add focused streaming request body tests where Undici request body support allows streaming without full buffering.
    - [x] Add focused streaming response body tests proving response chunks are forwarded through the Dispatcher path.
    - [x] Add AbortSignal/cancellation tests for pending request or response handling where feasible.
    - [x] Run focused tests and confirm expected failures.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Node Broker Dispatcher and Fetch Helper Tests' (Protocol in workflow.md)

## Phase 3: Node Broker Dispatcher and Fetch Helper Implementation

- [x] Task: Add Node guest dependencies and public API types
    - [x] Add `undici` as a dependency of `@signicode/verser2-guest-node` only.
    - [x] Extend `VerserBroker` with `createDispatcher()` and `createFetch()`.
    - [x] Export any necessary public types while keeping Node-specific implementation details internal unless tests/API require otherwise.
- [x] Task: Implement `VerserBrokerDispatcher`
    - [x] Implement a Node-specific Dispatcher adapter over `broker.request(...)`.
    - [x] Parse Undici dispatch origin/path into routed Broker target, method, path, and headers.
    - [x] Reuse JS common route resolution and header normalization helpers where appropriate.
    - [x] Convert Undici request bodies into Node `Readable` inputs without unnecessary buffering where feasible.
    - [x] Forward Broker response status, headers, and streaming body through Undici handler callbacks.
    - [x] Map missing routes, Broker failures, stream failures, and protocol errors into the Undici handler error path with clear context.
- [x] Task: Implement `createFetch()` helper
    - [x] Return a fetch-compatible function backed by the Broker dispatcher.
    - [x] Preserve normal fetch call semantics and caller-supplied options while defaulting dispatcher routing through the Broker.
    - [x] Avoid global fetch mutation.
- [x] Task: Implement cancellation handling
    - [x] Wire AbortSignal/client cancellation into request body and response handling where Undici exposes it.
    - [x] Destroy or close involved streams on cancellation where safe.
    - [x] Ensure cancellation does not leave dangling request/response streams.
- [x] Task: Run focused implementation validation
    - [x] Run the focused Dispatcher/fetch-helper tests until they pass.
    - [x] Run existing Agent tests to confirm `createAgent()` behavior is unchanged.
    - [x] Run package/export tests to confirm public APIs and workspace exports.
    - [x] Record coverage status for changed behavior.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Node Broker Dispatcher and Fetch Helper Implementation' (Protocol in workflow.md)

## Phase 4: End-to-End Coverage, Documentation, and Final Validation

- [x] Task: Add end-to-end tests first
    - [x] Add Host/Guest/Broker/Dispatcher end-to-end tests using existing Host behavior only.
    - [x] Add Host/Guest/Broker/`createFetch()` end-to-end tests using existing Host behavior only.
    - [x] Confirm end-to-end tests fail before any remaining implementation or wiring fixes.
- [x] Task: Complete integration fixes
    - [x] Fix any Node guest, JS common, package, or test integration gaps found by end-to-end tests.
    - [x] Confirm no Host-side implementation files were changed.
    - [x] Confirm no browser guest implementation was added.
- [x] Task: Update documentation and examples
    - [x] Update relevant README or package documentation with `createDispatcher()` usage.
    - [x] Add a concise `createFetch()` example showing routed fetch without manually passing a dispatcher.
    - [x] Document limitations and out-of-scope behavior such as CONNECT, upgrade, WebSocket, target TLS semantics, and browser guest implementation.
- [x] Task: Perform deduplication and common-library review
    - [x] Review changed Node guest code for reusable route/header/stream logic that belongs in `@signicode/verser2-guest-js-common`.
    - [x] Move repeated or runtime-neutral code into JS common where appropriate.
    - [x] Record any intentionally Node-specific logic retained in `@signicode/verser2-guest-node`.
- [x] Task: Run final validation
    - [x] Run `npm run build`.
    - [x] Run focused Dispatcher/fetch-helper tests.
    - [x] Run `npm test`.
    - [x] Run `npm run lint`.
    - [x] Confirm or record 95% meaningful coverage status for changed behavior.
- [x] Task: Conductor - User Manual Verification 'Phase 4: End-to-End Coverage, Documentation, and Final Validation' (Protocol in workflow.md)

## Phase Checkpoints

- [x] Implementation checkpoint commit: `442b881`
- [x] Validation summary: `npm run build`, `node --test test/dispatcher.test.js`, `node --test test/agent.test.js`, `node --test test/end-to-end.test.js`, `node --test test/packages.test.js`, `npm test`, `npm run lint`, and `npm run test:coverage` passed. Overall line coverage: 95.65%.
- [x] Deduplication summary: runtime-neutral route resolution and header normalization were added to `@signicode/verser2-guest-js-common`; Undici and Node stream handling remain in `@signicode/verser2-guest-node` because they are runtime-specific.

# Implementation Plan: Undici Dispatcher and Fetch Helper Compatibility

## Phase 1: JS Common Package Scaffold and Shared Primitives

- [ ] Task: Confirm package boundaries and reusable foundations
    - [ ] Review `@signicode/verser-common` for reusable route, header, error, and envelope primitives before adding new package-local code.
    - [ ] Confirm `@signicode/verser2-guest-js-common` will contain no `node:*`, `node:http`, `node:http2`, `node:stream`, or `undici` imports.
    - [ ] Record that Host-side implementation changes are out of scope for this track.
- [ ] Task: Write failing package and export tests first
    - [ ] Add or update package/workspace tests expecting `@signicode/verser2-guest-js-common` to exist and export runtime-neutral primitives.
    - [ ] Add tests expecting `@signicode/verser2-guest-node` to expose `createDispatcher()` and `createFetch()` through the Broker API.
    - [ ] Run the narrowest package/export test command and confirm the new assertions fail for the expected reason.
- [ ] Task: Create `@signicode/verser2-guest-js-common`
    - [ ] Add package manifest, composite `tsconfig.json`, and `src/index.ts` entrypoint.
    - [ ] Add root TypeScript project reference for the new workspace package.
    - [ ] Update package-lock/workspace metadata using npm when required.
- [ ] Task: Implement runtime-neutral shared primitives
    - [ ] Add route types and route resolution helpers for advertised domains.
    - [ ] Add common broker request/response types parameterized by body type.
    - [ ] Add header normalization helpers suitable for Dispatcher/fetch inputs without Node-only dependencies.
    - [ ] Add abstract dispatch/fetch-like base structure for future browser-compatible implementations.
    - [ ] Add stream conversion helper types/utilities that remain runtime-neutral.
- [ ] Task: Validate Phase 1
    - [ ] Run `npm run build` or the narrowest reliable package build covering the new package.
    - [ ] Run focused package/export tests.
    - [ ] Run `npm run lint` if formatting/static checks are affected.
    - [ ] Record coverage status or why coverage cannot be measured for scaffold-only shared primitives.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: JS Common Package Scaffold and Shared Primitives' (Protocol in workflow.md)

## Phase 2: Node Broker Dispatcher and Fetch Helper Tests

- [ ] Task: Confirm affected Node guest API and test targets
    - [ ] Review `packages/verser2-guest-node/src/index.ts` Broker interfaces and `Http2VerserBroker` implementation.
    - [ ] Review existing `test/agent.test.js`, `test/end-to-end.test.js`, and `test/broker-routing.test.js` coverage for analogous Agent and Broker behavior.
    - [ ] Confirm common package helpers from Phase 1 are reused where appropriate before writing Node-specific code.
- [ ] Task: Write failing focused Dispatcher tests first
    - [ ] Add tests proving `broker.createDispatcher()` returns an Undici-compatible dispatcher.
    - [ ] Add tests proving Undici `fetch(url, { dispatcher })` routes to an advertised guest hostname without DNS resolution.
    - [ ] Add tests for method, path, query string, headers, request body, response status, response headers, and response body preservation.
    - [ ] Add a missing-route test expecting a clear Undici/fetch error path.
    - [ ] Run the focused Dispatcher test command and confirm failures are for missing implementation.
- [ ] Task: Write failing `createFetch()` tests first
    - [ ] Add tests proving `broker.createFetch()` returns a fetch-compatible function.
    - [ ] Add tests proving the returned fetch helper routes through the Broker without manually passing a dispatcher per request.
    - [ ] Add tests proving explicit caller fetch options are preserved when the helper injects the dispatcher.
    - [ ] Run the focused fetch-helper test command and confirm failures are for missing implementation.
- [ ] Task: Write failing streaming and cancellation tests first
    - [ ] Add focused streaming request body tests where Undici request body support allows streaming without full buffering.
    - [ ] Add focused streaming response body tests proving response chunks are forwarded through the Dispatcher path.
    - [ ] Add AbortSignal/cancellation tests for pending request or response handling where feasible.
    - [ ] Run focused tests and confirm expected failures.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Node Broker Dispatcher and Fetch Helper Tests' (Protocol in workflow.md)

## Phase 3: Node Broker Dispatcher and Fetch Helper Implementation

- [ ] Task: Add Node guest dependencies and public API types
    - [ ] Add `undici` as a dependency of `@signicode/verser2-guest-node` only.
    - [ ] Extend `VerserBroker` with `createDispatcher()` and `createFetch()`.
    - [ ] Export any necessary public types while keeping Node-specific implementation details internal unless tests/API require otherwise.
- [ ] Task: Implement `VerserBrokerDispatcher`
    - [ ] Implement a Node-specific Dispatcher adapter over `broker.request(...)`.
    - [ ] Parse Undici dispatch origin/path into routed Broker target, method, path, and headers.
    - [ ] Reuse JS common route resolution and header normalization helpers where appropriate.
    - [ ] Convert Undici request bodies into Node `Readable` inputs without unnecessary buffering where feasible.
    - [ ] Forward Broker response status, headers, and streaming body through Undici handler callbacks.
    - [ ] Map missing routes, Broker failures, stream failures, and protocol errors into the Undici handler error path with clear context.
- [ ] Task: Implement `createFetch()` helper
    - [ ] Return a fetch-compatible function backed by the Broker dispatcher.
    - [ ] Preserve normal fetch call semantics and caller-supplied options while defaulting dispatcher routing through the Broker.
    - [ ] Avoid global fetch mutation.
- [ ] Task: Implement cancellation handling
    - [ ] Wire AbortSignal/client cancellation into request body and response handling where Undici exposes it.
    - [ ] Destroy or close involved streams on cancellation where safe.
    - [ ] Ensure cancellation does not leave dangling request/response streams.
- [ ] Task: Run focused implementation validation
    - [ ] Run the focused Dispatcher/fetch-helper tests until they pass.
    - [ ] Run existing Agent tests to confirm `createAgent()` behavior is unchanged.
    - [ ] Run package/export tests to confirm public APIs and workspace exports.
    - [ ] Record coverage status for changed behavior.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Node Broker Dispatcher and Fetch Helper Implementation' (Protocol in workflow.md)

## Phase 4: End-to-End Coverage, Documentation, and Final Validation

- [ ] Task: Add end-to-end tests first
    - [ ] Add Host/Guest/Broker/Dispatcher end-to-end tests using existing Host behavior only.
    - [ ] Add Host/Guest/Broker/`createFetch()` end-to-end tests using existing Host behavior only.
    - [ ] Confirm end-to-end tests fail before any remaining implementation or wiring fixes.
- [ ] Task: Complete integration fixes
    - [ ] Fix any Node guest, JS common, package, or test integration gaps found by end-to-end tests.
    - [ ] Confirm no Host-side implementation files were changed.
    - [ ] Confirm no browser guest implementation was added.
- [ ] Task: Update documentation and examples
    - [ ] Update relevant README or package documentation with `createDispatcher()` usage.
    - [ ] Add a concise `createFetch()` example showing routed fetch without manually passing a dispatcher.
    - [ ] Document limitations and out-of-scope behavior such as CONNECT, upgrade, WebSocket, target TLS semantics, and browser guest implementation.
- [ ] Task: Perform deduplication and common-library review
    - [ ] Review changed Node guest code for reusable route/header/stream logic that belongs in `@signicode/verser2-guest-js-common`.
    - [ ] Move repeated or runtime-neutral code into JS common where appropriate.
    - [ ] Record any intentionally Node-specific logic retained in `@signicode/verser2-guest-node`.
- [ ] Task: Run final validation
    - [ ] Run `npm run build`.
    - [ ] Run focused Dispatcher/fetch-helper tests.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Confirm or record 95% meaningful coverage status for changed behavior.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: End-to-End Coverage, Documentation, and Final Validation' (Protocol in workflow.md)

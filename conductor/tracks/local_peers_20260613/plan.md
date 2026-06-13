# Implementation Plan: In-Process Local Host Peers

## Phase 1: Track setup, architecture discovery, and failing local-peer coverage

- [x] Task: Create the review branch, planning commit, and PR for the complete local-peer TO-BE state
    - [x] Create a dedicated track branch before implementation changes.
    - [x] Commit the approved Conductor planning artifacts on the track branch so a PR can be created.
    - [x] Create a GitHub PR with a title and body describing the final in-process local Host peer capability, not only the planning artifacts.
- [x] Task: Confirm existing reusable Host, Guest, Broker, and common foundations
    - [x] Review `packages/verser-common` for reusable route registration, routed request/response envelope, header validation, lifecycle, error, route-control, and stream helper contracts.
    - [x] Review `packages/verser2-host/src/lib/node-http2-verser-host.ts` for registration, route advertisement, lease acquisition, lifecycle, cleanup, and H2 request routing behavior that should become transport-neutral or locally adaptable.
    - [x] Review `packages/verser2-guest-node/src/lib/http2-verser-node-guest.ts`, `minimal-http.ts`, and related tests for handler dispatch behavior to short-wire for local Guests where practical.
    - [x] Review `packages/verser2-guest-node/src/lib/http2-verser-broker.ts`, `broker-agent.ts`, `broker-dispatcher.ts`, and related tests for Broker request and route-table behavior to reuse or adapt for local Brokers where practical.
    - [x] Record which code is reused, adapted, moved to common, or intentionally left package-local because it is transport- or runtime-specific.

    Architecture discovery notes:
    - Reuse `@signicode/verser-common` route registration/lookup helpers, routed envelope types, header validation/serialization helpers, lifecycle event names, `VerserError` helpers, serialized error response helpers, registration/control-frame helpers, NDJSON helpers, and Broker request/body normalization helpers.
    - Adapt Host internals around peer registration, duplicate peer ID checks, guest route table state, Broker route advertisements, lifecycle emission, lease/request target checks, and cleanup so local and H2 peers share observable semantics.
    - Keep H2-specific TLS server/client setup, certificate reload, session/stream lifecycle, `/verser/*` stream dispatch, H2 protocol headers, binary envelope-over-lease streams, and `NGHTTP2_CANCEL` handling inside the H2 adapter.
    - Reuse or extract Node Guest dispatch pieces from `Http2VerserNodeGuest.dispatchRoutedRequest`, `MinimalIncomingMessage`, and `MinimalServerResponse`; local streaming support may require adapting these pieces instead of relying on the existing buffered direct-dispatch path.
    - Reuse Broker route-table semantics (`getRoutes`, `waitForRoute`, route-control full-table replacement) and keep Agent/Dispatcher/fetch compatibility through the existing `BrokerRequestRouter` shape.
    - Consider extracting Broker route waiter logic from `Http2VerserBroker`, and consider normalizing both H2 and local Broker requests through `createCommonBrokerRequest` where compatible.
    - Extend focused coverage primarily in `test/host.test.js`, `test/broker-routing.test.js`, `test/guest-node.test.js`, `test/agent.test.js`, and `test/dispatcher.test.js`; add common tests only if new common helpers are introduced.
- [x] Task: Write failing local registration, lifecycle, and authorization tests first
    - [x] Add tests proving local Guest registration populates Host routes.
    - [x] Add tests proving local Guest close/detach retracts routes and advertises route removal.
    - [x] Add tests proving local Broker receives full route table updates and route waiters resolve.
    - [x] Add tests proving duplicate peer IDs are rejected across local and H2 peers.
    - [x] Add tests proving Host lifecycle events are emitted coherently for local registration, route advertisement, request start/completion, errors, disconnection, and close where applicable.
    - [x] Add tests proving local Guest and local Broker registration invoke the existing `authorizeRegistration` callback.
    - [x] Add tests proving authorization context metadata is Host-owned, includes local registration identity such as `local: true` and `authorized: true`, and does not include caller-supplied certificate data.
    - [x] Add tests proving local registration is rejected when the callback returns `{ action: 'close' }`.
    - [x] Add regression tests proving H2 authorization metadata remains derived from the TLS socket and is not made caller-controlled.
    - [x] Confirm the tests fail for the expected missing local-peer API or behavior.

    Validation note: `npm run build && node --test test/host.test.js test/broker-routing.test.js` failed as expected because the intended local peer API does not exist yet (`host.attachLocalGuest is not a function` / `host.attachLocalBroker is not a function`). Existing H2 tests in the focused run continued to pass.
- [x] Task: Write failing local routing, streaming, API, and error-parity tests first
    - [x] Add tests proving local Broker to local Guest routing preserves method, path, headers, status, response headers, request body, and response body.
    - [x] Add tests proving local Broker to H2 Guest routing preserves request and response semantics.
    - [x] Add tests proving H2 Broker to local Guest routing preserves request and response semantics.
    - [x] Add tests proving request bodies stream through local routing without mandatory buffering.
    - [x] Add tests proving response bodies stream through local routing without mandatory buffering.
    - [x] Add tests proving backpressure/cancellation behavior is reasonable for local stream bridges.
    - [x] Add tests for the intended Host local peer public API surface.
    - [x] Add tests for Node request-listener or `http.Server` local Guest attachment ergonomics where exposed.
    - [x] Add tests for local Broker route snapshots, route waiters, and request ergonomics where exposed.
    - [x] Add tests for Agent, Dispatcher, or fetch compatibility if the track exposes local Broker wrappers through `@signicode/verser2-guest-node`.
    - [x] Add tests proving missing target, disconnected target, duplicate registration, lease timeout, local handler failure, stream error, and cancellation behavior match H2 semantics as closely as possible.
    - [x] Confirm the tests fail for the expected missing local routing, API, and error behavior.
- [~] Task: Conductor - User Manual Verification 'Phase 1: Track setup, architecture discovery, and failing local-peer coverage' (Protocol in workflow.md)
    - [x] Commit and push the Phase 1 checkpoint branch before requesting manual validation so the PR is current.
    - [ ] Request user manual validation after the pushed checkpoint is available.

    Phase 1 checkpoint commit: `6a8a01a`

## Phase 2: Local Host peer implementation, streaming routing, and public API integration

- [ ] Task: Implement transport-neutral Host peer registration and route state
    - [ ] Introduce or refactor internal Host peer state so local peers and H2 peers share duplicate ID checks, registration storage, route table updates, and cleanup semantics.
    - [ ] Keep the existing H2 `/verser/register`, `/verser/guest/control`, `/verser/guest/lease`, and `/verser/request` behavior compatible.
    - [ ] Add Host local attachment primitives for local Guest and local Broker registration handles.
    - [ ] Ensure local handles expose deterministic close/detach behavior.
    - [ ] Make local Brokers receive route-control updates with the same full route-table replacement semantics as H2 Brokers.
    - [ ] Ensure local Guest registration and detachment advertise additions and removals to all Brokers, local and H2.
    - [ ] Preserve `getRoutedDomains()` behavior for both local and H2 Guests.
- [ ] Task: Implement local registration authorization
    - [ ] Reuse the existing Host `authorizeRegistration` callback for local peers.
    - [ ] Build local authorization context inside Host code, not from caller-provided metadata.
    - [ ] Use `certificate: undefined` and metadata indicating local trusted transport state, such as `local: true` and `authorized: true`.
    - [ ] Map callback rejection to the same style of invalid-registration error and lifecycle error behavior as H2 registration.
    - [ ] Preserve H2 authorization context behavior from TLS socket state.
- [ ] Task: Implement local Guest dispatch by short-wiring existing Guest behavior where practical
    - [ ] Reuse or adapt Node Guest minimal HTTP request/response handling for local Guest request listeners.
    - [ ] Avoid using the buffered `dispatchRoutedRequest()` path as the primary local routing implementation.
    - [ ] Bridge Host-routed request streams into local Guest handlers and stream local responses back to the requester.
    - [ ] Preserve local handler failure behavior before and after headers start.
- [ ] Task: Implement local Broker request routing and H2/local interop
    - [ ] Provide a local Broker `request()` primitive that sends requests through Host target checks and routing state.
    - [ ] Preserve request IDs, source IDs, target IDs, methods, paths, validated headers, lease/acquisition timeout semantics where applicable, and response streaming.
    - [ ] Reuse existing Broker route-table/waiter logic where practical.
    - [ ] Allow H2 Broker requests to acquire and dispatch to local Guest targets.
    - [ ] Allow local Broker requests to dispatch to H2 Guest lease streams.
    - [ ] Preserve existing H2 lease cleanup and cancellation behavior.
    - [ ] Prevent local peer cleanup from closing unrelated H2 sessions or streams.
- [ ] Task: Implement public API exports and Node-facing convenience wrappers
    - [ ] Add Host package types for local Guest attachment options, local Broker attachment options, local handles, local route control, request, and response shapes as needed.
    - [ ] Export only stable public APIs from package entrypoints.
    - [ ] Keep transport-specific or runtime-specific internals private.
    - [ ] Reuse guest-node request listener extraction and minimal HTTP behavior for local Guest attachment where appropriate.
    - [ ] Reuse guest-node Broker route/request helpers for local Broker wrappers where practical.
    - [ ] Keep `undici`-dependent wrappers in `@signicode/verser2-guest-node`, not in `@signicode/verser2-host`.
    - [ ] Ensure declaration generation succeeds for new public types.
- [ ] Task: Validate Phase 2 narrowly
    - [ ] Run focused Host tests for local registration, route advertisement, duplicate ID handling, lifecycle, authorization, routing, streaming, and error behavior.
    - [ ] Run focused package API tests for Host and guest-node surfaces.
    - [ ] Run focused existing H2 Host/Guest/Broker tests touched by registration and routing refactors to prove compatibility.
    - [ ] Run package build for affected packages to verify generated declarations.
    - [ ] Run lint for affected packages.
    - [ ] Record coverage status for changed registration, routing, streaming, authorization, and API behavior.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Local Host peer implementation, streaming routing, and public API integration' (Protocol in workflow.md)
    - [ ] Commit and push the Phase 2 checkpoint branch before requesting manual validation so the PR is current.
    - [ ] Request user manual validation after the pushed checkpoint is available.

## Phase 3: Documentation, compatibility hardening, and final validation

- [ ] Task: Write or update failing documentation/package-surface tests first
    - [ ] Update docs tests to expect local peer documentation in relevant user docs or package READMEs.
    - [ ] Update package import/consumer tests if new public exports need source, staging, tarball, or GitHub-package coverage.
    - [ ] Confirm tests fail before documentation/package-surface updates where applicable.
- [ ] Task: Complete error parity, lifecycle polish, and compatibility hardening
    - [ ] Normalize local-peer errors through existing Verser error codes and serialized error behavior where possible.
    - [ ] Ensure request-started, request-completed, error, registered, disconnected, route-advertised, and closed events are coherent for local and H2 peers.
    - [ ] Ensure local close/detach fails pending requests or waiters with actionable errors.
    - [ ] Confirm H2 behavior remains unchanged unless the spec explicitly requires an alignment fix.
    - [ ] Address any review findings from Phase 2 manual verification.
- [ ] Task: Update documentation and examples
    - [ ] Document the local Host-side Guest/Broker attachment API.
    - [ ] Document local authorization metadata and the fact that it is Host-owned and not caller-tamperable.
    - [ ] Document supported local/H2 routing combinations.
    - [ ] Document streaming behavior, lifecycle, close/detach behavior, and error boundaries.
    - [ ] Continue documenting that Verser2 is not a complete public gateway and does not implement per-request Broker target authorization.
- [ ] Task: Final deduplication and compatibility review
    - [ ] Re-scan `@signicode/verser-common` and affected packages for repeated protocol, route-control, header, lifecycle, stream, and error logic introduced during the track.
    - [ ] Move reusable code into common libraries where appropriate.
    - [ ] Confirm Host package dependencies remain appropriate and runtime-specific dependencies stay in runtime packages.
    - [ ] Confirm docs, tests, and code agree on feature scope and non-goals.
- [ ] Task: Run final validation
    - [ ] Run the narrowest complete validation set that proves local peer registration, authorization, routing, streaming, interop, API exports, and docs.
    - [ ] Run `npm run build` for affected TypeScript packages or the full repo if package boundaries changed.
    - [ ] Run `npm run lint`.
    - [ ] Run `npm run test` before final phase completion unless a narrower documented command fully covers all changed behavior.
    - [ ] Confirm 95% meaningful coverage for changed behavior or record why exact measurement is not emitted by the current runner.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Documentation, compatibility hardening, and final validation' (Protocol in workflow.md)
    - [ ] Commit and push the Phase 3 checkpoint branch before requesting manual validation so the PR is current.
    - [ ] Request user manual validation after the pushed checkpoint is available.

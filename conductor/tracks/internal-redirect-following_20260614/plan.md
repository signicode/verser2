# Implementation Plan: Broker Internal Redirect Following

## Phase 0: Track Branch and PR Setup

- [ ] Task: Create the Conductor review branch
    - [ ] Confirm current working tree status and avoid staging unrelated changes.
    - [ ] Create a dedicated branch for this track before implementation work.
    - [ ] Use a branch name based on the track id and redirect-following scope.
- [ ] Task: Create the track pull request review surface
    - [ ] Push the dedicated branch.
    - [ ] Create a GitHub pull request with a title and body describing the final TO-BE behavior: Brokers follow eligible internal 307/308 redirects for advertised routes by default with bounded replay and configurable limits.
    - [ ] Use a real multiline PR body file as required by `workflow.md`.
- [ ] Task: Conductor - User Manual Verification 'Phase 0: Track Branch and PR Setup' (Protocol in workflow.md)

## Phase 1: Redirect Design Inventory and Test Scaffolding

- [ ] Task: Confirm affected Broker request surfaces and route-table behavior
    - [ ] Review `packages/verser2-guest-node/src/lib/http2-verser-broker.ts` direct request flow.
    - [ ] Review `packages/verser2-guest-node/src/lib/broker-socket.ts` Agent-backed request flow.
    - [ ] Review `packages/verser2-guest-node/src/lib/broker-dispatcher.ts` and fetch wrapper behavior.
    - [ ] Review existing common helpers in `@signicode/verser-common`, especially route resolution, request body normalization, and error primitives.
    - [ ] Record whether redirect helpers should live in common or remain package-local for this phase.
- [ ] Task: Define the minimal redirect configuration and error shape
    - [ ] Identify existing Broker/Agent/Dispatcher option types that can carry redirect settings.
    - [ ] Specify default values: internal redirects enabled, replay buffer limit `16 KiB`, max internal redirects `3`.
    - [ ] Specify how callers configure max hops and replay buffer size consistently across direct Broker, Agent, and fetch/Dispatcher paths.
    - [ ] Specify the redirect-limit error code/context using existing `VerserError` conventions where possible.
- [ ] Task: Add failing focused tests for direct Broker request redirects
    - [ ] Test `307` internal redirect to an advertised route returns the final Guest response.
    - [ ] Test `308` internal redirect to an advertised route returns the final Guest response.
    - [ ] Test non-GET body replay sends the full body from the beginning to the redirected Guest.
    - [ ] Test body replay includes bytes that were already read before the redirect decision.
    - [ ] Test oversized buffered body returns the original `307`/`308` response unchanged.
    - [ ] Test unadvertised redirect host remains client-visible.
    - [ ] Test redirect loop or over-limit hops fails with a clear redirect-limit error.
    - [ ] Test configured max hop value is enforced.
- [ ] Task: Add failing integration coverage for Agent and fetch-style paths
    - [ ] Add or extend Agent tests to prove eligible internal redirects are followed by default.
    - [ ] Add or extend Dispatcher/fetch tests to prove eligible internal redirects are followed by default.
    - [ ] Add focused coverage that configuration is threaded into these surfaces where applicable.
- [ ] Task: Run automated review and fix loop before manual review
    - [ ] Run focused failing tests to confirm expected failures and no unrelated failures.
    - [ ] Review test quality and scope against the specification.
    - [ ] Fix test scaffolding issues before requesting manual verification.
- [ ] Task: Phase checkpoint before manual review
    - [ ] Run the narrowest validation suitable for the phase.
    - [ ] Commit the completed phase changes with a scoped phase summary.
    - [ ] Push the phase checkpoint branch before asking for manual verification.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Redirect Design Inventory and Test Scaffolding' (Protocol in workflow.md)

## Phase 2: Direct Broker Redirect Implementation

- [ ] Task: Implement bounded replay support for Broker requests
    - [ ] Buffer request body chunks only up to the configured internal redirect replay limit.
    - [ ] Preserve backpressure and avoid unbounded buffering.
    - [ ] Ensure replayed redirected requests receive the body from the beginning.
    - [ ] Ensure requests above the configured replay limit are not internally redirected and return the original response unchanged.
- [ ] Task: Implement internal redirect resolution and hop handling
    - [ ] Detect only `307` and `308` responses with a valid `Location` header.
    - [ ] Resolve `Location` hostnames only through exact advertised route-table matches.
    - [ ] Apply redirected path and query from `Location` while preserving the original method and headers.
    - [ ] Enforce default and configured maximum internal redirect hops.
    - [ ] Surface a clear redirect-limit error when the configured maximum is exceeded.
- [ ] Task: Wire direct Broker options and defaults
    - [ ] Add or update TypeScript option types for default-on internal redirect following.
    - [ ] Add configurable replay buffer size and max hop settings.
    - [ ] Keep any disabling or override options minimal and documented if introduced by the implementation shape.
- [ ] Task: Validate direct Broker request behavior narrowly
    - [ ] Run the focused Broker redirect tests and confirm they pass.
    - [ ] Run nearby routing/streaming tests affected by body replay logic.
    - [ ] Record coverage and any skipped validation in the phase notes.
- [ ] Task: Run automated review and fix loop before manual review
    - [ ] Run automated code review or equivalent self-review against redirect semantics, replay limits, route-table lookup, and error paths.
    - [ ] Fix review findings that are in scope before requesting manual verification.
    - [ ] Re-run focused validation after fixes.
- [ ] Task: Phase checkpoint before manual review
    - [ ] Run the narrowest validation suitable for the phase.
    - [ ] Commit the completed phase changes with a scoped phase summary.
    - [ ] Push the phase checkpoint branch before asking for manual verification.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Direct Broker Redirect Implementation' (Protocol in workflow.md)

## Phase 3: Agent, Dispatcher, Fetch, and Documentation Integration

- [ ] Task: Thread redirect behavior through Agent-backed requests
    - [ ] Update the Agent/Broker socket path to use the same redirect defaults and configurable limits.
    - [ ] Preserve Node `http.Agent` request/response streaming semantics.
    - [ ] Ensure client-visible fallback returns the original redirect response unchanged when internal following is not possible.
- [ ] Task: Thread redirect behavior through Dispatcher and fetch-style integrations
    - [ ] Update Dispatcher/fetch request conversion so redirect settings reach the Broker request layer.
    - [ ] Preserve Undici Dispatcher/fetch response streaming semantics from the final target.
    - [ ] Confirm unadvertised and oversized cases remain client-visible.
- [ ] Task: Update public docs and package guidance
    - [ ] Document default-on internal 307/308 redirects for advertised verser2 routes.
    - [ ] Document configurable max hops and replay buffer limit, including defaults of `3` and `16 KiB`.
    - [ ] Document that oversized request bodies return the original redirect response for the client to handle.
    - [ ] Keep Host/Guest/Broker terminology precise and avoid implying DNS or public gateway behavior.
- [ ] Task: Validate integrated behavior
    - [ ] Run focused Agent tests.
    - [ ] Run focused Dispatcher/fetch tests.
    - [ ] Run focused Broker routing tests.
    - [ ] Run `npm run build` if TypeScript public types changed.
    - [ ] Run `npm run lint` if source or docs changes require style validation.
    - [ ] Record coverage status and deduplication results.
- [ ] Task: Run automated review and fix loop before manual review
    - [ ] Run automated code review or equivalent self-review across direct Broker, Agent, Dispatcher/fetch, docs, and tests.
    - [ ] Fix in-scope review findings before requesting manual verification.
    - [ ] Re-run focused validation after fixes.
- [ ] Task: Phase checkpoint before manual review
    - [ ] Run the narrowest validation suitable for the phase.
    - [ ] Commit the completed phase changes with a scoped phase summary.
    - [ ] Push the phase checkpoint branch before asking for manual verification.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Agent, Dispatcher, Fetch, and Documentation Integration' (Protocol in workflow.md)

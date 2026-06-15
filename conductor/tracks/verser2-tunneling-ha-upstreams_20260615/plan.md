# Implementation Plan: Verser2 Host Federation, Upstreams, and HA Foundations

## Phase 1: Protocol and API Design Foundations

- [x] Task: Confirm affected packages, entrypoints, protocol behavior, and expected outcomes
    - [x] Inventory current Host registration, route advertisement, lease forwarding, TLS authorization, lifecycle, and Broker route-table code paths.
    - [x] Record source references for reusable common types/helpers before adding new protocol shapes.
    - [x] Confirm no changes are needed to `tech-stack.md` unless implementation requires a new runtime dependency.
- [x] Task: Write failing common protocol tests for federation metadata
    - [x] Add tests for Host IDs, upstream/federation handshake shapes, federated route metadata, hop counts, via chains, and loop-prevention validation.
    - [x] Add tests proving legacy Broker route-control frames remain backward compatible.
    - [x] Add tests for new structured error codes such as upstream unavailable, route loop, authorization denied, and unsafe retry where applicable.
- [x] Task: Implement shared protocol foundations in `@signicode/verser-common`
    - [x] Add runtime-neutral Host federation types, route metadata types, authorization context types, constants, and validation helpers.
    - [x] Extend TLS certificate identity helpers only as needed for safe certificate-chain authorization context.
    - [x] Export common APIs without coupling them to Node Host implementation details.
- [x] Task: Validate protocol foundation phase
    - [x] Run the narrowest common protocol tests.
    - [x] Run TypeScript build for affected packages if type exports changed.
    - [x] Record coverage applicability and common-library reuse notes.
- [x] Task: Push phase checkpoint for GitHub-visible manual verification
    - [x] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [x] Push the track branch to the remote branch before requesting manual verification.
    - [x] Record the pushed commit SHA in this plan.
        - Checkpoint commit: `3650cf4`.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Protocol and API Design Foundations' (Protocol in workflow.md)

### Phase 1 notes

- Affected package: `@signicode/verser-common`; public entrypoint `packages/verser-common/src/index.ts` now exports runtime-neutral Host federation protocol foundations.
- Source inventory references: Host registration/route advertisement/lease routing in `packages/verser2-host/src/lib/node-http2-verser-host.ts`; Broker route table in `packages/verser2-guest-node/src/lib/http2-verser-broker.ts`; reusable common route, registration, TLS identity, error, and envelope helpers in `packages/verser-common/src/lib/`.
- No new runtime dependency was added; `tech-stack.md` does not require a Phase 1 update.
- TDD failure confirmed with `npm run build --workspace=@signicode/verser-common && node --test test/common-protocol.test.js`: new federation helper/error-code tests failed before implementation because APIs/error codes were missing.
- Validation passed: `npm run build --workspace=@signicode/verser-common && node --test test/common-protocol.test.js`; `npm run lint`; `node --test --experimental-test-coverage test/common-protocol.test.js`.
- Coverage: changed federation helper behavior has meaningful focused assertions for success, malformed handshake metadata, malformed route metadata, loop/hop checks, legacy route-frame compatibility, and error-code recognition. The experimental Node coverage report is package-bundle-wide for `@signicode/verser-common` (`dist/index.js` 58.93%) because the focused protocol test loads the entire built common package; no repository threshold command is configured for per-helper coverage.
- Deduplication/common reuse: all new runtime-neutral federation protocol shapes and validators live in `@signicode/verser-common`; existing route registration validation, `VerserError`, TLS certificate identity shape, and legacy Broker route-control helper are reused/adapted. No package-local duplicate was added.
- Code review: `@oracle` found malformed wire metadata validation gaps; review-driven failing tests were added and the helpers now reject bad discriminants, non-boolean flags, invalid `viaHostIds`, invalid sources, and bad hop counts predictably with `VerserError` protocol errors.

## Phase 2: Host Route Registry and Local-First Resolution

- [x] Task: Write failing Host route-registry tests
    - [x] Test local Guest routes overriding imported upstream candidates for the same route identity.
    - [x] Test Hosts with no configured upstreams and Hosts with unavailable upstreams continue serving local routes correctly.
    - [x] Test multi-candidate route storage for future HA selection.
    - [x] Test route withdrawal when imported upstream routes disappear.
    - [x] Test loop suppression and hop-limit rejection.
- [x] Task: Refactor Host routing internals for route candidates
    - [x] Separate route registry/candidate resolution from connected peer storage.
    - [x] Preserve current local Guest, remote Guest lease, and local peer routing behavior.
    - [x] Keep public legacy route advertisements compatible for existing Brokers.
- [x] Task: Implement local-first route selection
    - [x] Prefer local candidates over imported upstream candidates when local availability exists.
    - [x] Preserve exact-hostname matching unless a later track changes route matching semantics.
    - [x] Emit clear lifecycle/error events for conflicts, loops, and route withdrawals.
- [x] Task: Validate Host route-registry phase
    - [x] Run focused Host and common protocol tests.
    - [x] Confirm existing Broker/Guest routing tests still pass for unchanged behavior.
    - [x] Record deduplication result and route conflict semantics.
- [x] Task: Push phase checkpoint for GitHub-visible manual verification
    - [x] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [x] Push the track branch to the remote branch before requesting manual verification.
    - [x] Record the pushed commit SHA in this plan.
        - Checkpoint commit: `353d41a`.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Host Route Registry and Local-First Resolution' (Protocol in workflow.md)

### Phase 2 notes

- Added Host route-candidate registry in `packages/verser2-host/src/lib/route-registry.ts`, separating route availability/candidate selection from connected peer storage.
- Local route projection remains the only legacy Broker-advertised route source until federated forwarding exists, so imported candidates are stored for later phases but not exposed as routable Broker routes yet.
- Local-first semantics: local candidates are ranked before imported candidates for the same route identity; imported candidate `source` is normalized to `upstream` from the current Host perspective.
- Imported route withdrawal is per upstream ID; looped and over-hop imported candidates are rejected with `route-loop` lifecycle errors.
- Validation passed: `npm run build --workspace=@signicode/verser-common && npm run build --workspace=@signicode/verser2-host && node --test test/host-route-registry.test.js test/host.test.js test/local-peers.test.js test/broker-routing.test.js`; `npm run lint`; `node --test --experimental-test-coverage test/host-route-registry.test.js`.
- Coverage: focused route-registry assertions cover no-upstream local behavior, local/imported candidate ordering, imported source normalization, imported withdrawal, legacy Broker suppression for imported candidates, and loop/hop rejection. Node experimental coverage is bundle-wide and not a per-helper threshold report.
- Deduplication/common reuse: Host registry reuses common federation route validation, Host IDs, loop/hop helpers, routed-domain validation, and `VerserError`; no duplicated common protocol validation was added.
- Code review: `@oracle` initially found blockers around imported route advertisement before forwarding, source normalization, and runtime/type seam mismatch. Follow-up review confirmed blockers fixed.

## Phase 3: Upstream Host Link Lifecycle and Authorization

- [ ] Task: Write failing upstream lifecycle and authorization tests
    - [ ] Test downstream Host connecting outbound to upstream Host over TLS HTTP/2.
    - [ ] Test upstream authorization callback accepts and rejects Host links based on declared Host ID and TLS identity.
    - [ ] Test mTLS Root CA -> Intermediate/Leaf CA -> client certificate trust where existing test utilities support it.
    - [ ] Test reconnect behavior, close behavior, and lifecycle event emission.
- [ ] Task: Implement upstream Host connection APIs
    - [ ] Add Host `hostId` and upstream configuration options.
    - [ ] Add dynamic connect/disconnect upstream methods if selected by API design.
    - [ ] Reuse existing TLS normalization where possible and centralize shared additions in common helpers.
- [ ] Task: Implement upstream handshake and authorization
    - [ ] Define versioned Host federation handshake over HTTP/2.
    - [ ] Populate authorization context with Host ID, upstream identity, TLS authorization state, and certificate identity details.
    - [ ] Reject unauthorized upstream links predictably with structured errors and lifecycle events.
- [ ] Task: Validate upstream lifecycle phase
    - [ ] Run focused TLS/configuration and Host lifecycle tests.
    - [ ] Run build for affected TypeScript packages.
    - [ ] Record coverage and certificate-chain limitations if any Node TLS details cannot be exposed safely.
- [ ] Task: Push phase checkpoint for GitHub-visible manual verification
    - [ ] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [ ] Push the track branch to the remote branch before requesting manual verification.
    - [ ] Record the pushed commit SHA in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Upstream Host Link Lifecycle and Authorization' (Protocol in workflow.md)

## Phase 4: Route Import and Export Across Hosts

- [ ] Task: Write failing route federation tests
    - [ ] Test downstream local Guest routes are exported to an upstream Host.
    - [ ] Test downstream Host imports upstream route advertisements.
    - [ ] Test manager -> hub -> runner topology route propagation without custom application code.
    - [ ] Test route withdrawal propagation when Guest, downstream Host, or upstream link disconnects.
- [ ] Task: Implement route export policy and upstream advertisements
    - [ ] Export selected local route candidates with origin Host ID, next-hop Host ID, hop count, and via chain.
    - [ ] Include hop distance in federated route state so downstream route selection can prefer the closest candidate.
    - [ ] Avoid exporting imported routes back to a visited Host.
    - [ ] Preserve existing full route-table replacement semantics for legacy Broker control streams.
- [ ] Task: Implement route import policy and registry integration
    - [ ] Import eligible upstream route candidates into the Host route registry.
    - [ ] Suppress looped, over-hop-limit, unauthorized, or conflicting routes.
    - [ ] Trigger Broker route updates when imported route availability changes.
- [ ] Task: Validate route federation phase
    - [ ] Run focused Host route, lifecycle, and Broker route advertisement tests.
    - [ ] Confirm legacy Brokers receive compatible route frames.
    - [ ] Record route import/export policy defaults and deduplication result.
- [ ] Task: Push phase checkpoint for GitHub-visible manual verification
    - [ ] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [ ] Push the track branch to the remote branch before requesting manual verification.
    - [ ] Record the pushed commit SHA in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Route Import and Export Across Hosts' (Protocol in workflow.md)

## Phase 5: Federated Request Forwarding

- [ ] Task: Write failing federated forwarding tests
    - [ ] Test Broker connected to upstream Host can reach Guest connected to downstream Host.
    - [ ] Test forwarded requests preserve method, path, headers, status, response headers, and binary bodies.
    - [ ] Test streaming request/response bodies without mandatory full buffering.
    - [ ] Test abort/cancellation propagation and upstream disconnect error mapping.
- [ ] Task: Implement upstream request forwarding path
    - [ ] Add next-hop dispatch for route candidates resolved to upstream Hosts.
    - [ ] Forward request metadata and body streams with backpressure-aware piping.
    - [ ] Forward response metadata and body streams back to the originating Broker stream.
- [ ] Task: Implement forwarding metadata, loop checks, and errors
    - [ ] Include source peer, source Host, target route, hop count, and via chain in forwarding metadata.
    - [ ] Enforce hop limits before opening next-hop streams.
    - [ ] Map upstream unavailable, authorization denial, route loss, and stream failure to structured Verser errors.
- [ ] Task: Validate federated forwarding phase
    - [ ] Run focused end-to-end federation tests.
    - [ ] Run existing end-to-end and broker-routing tests that prove compatibility.
    - [ ] Record streaming/backpressure validation and coverage results.
- [ ] Task: Push phase checkpoint for GitHub-visible manual verification
    - [ ] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [ ] Push the track branch to the remote branch before requesting manual verification.
    - [ ] Record the pushed commit SHA in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Federated Request Forwarding' (Protocol in workflow.md)

## Phase 6: HA Candidate Selection and Safe Retry

- [ ] Task: Write failing HA behavior tests
    - [ ] Test multiple route candidates for the same domain/target across Host nodes.
    - [ ] Test new-request failover to another healthy candidate when the selected upstream is unavailable before response headers.
    - [ ] Test non-replayable or active streaming requests are not transparently retried or migrated.
    - [ ] Test route-table updates after upstream loss and recovery.
- [ ] Task: Implement route candidate health and selection
    - [ ] Track upstream readiness based on session state, handshake success, authorization success, and route availability.
    - [ ] Select eligible route candidates with local-first behavior, hop-distance preference, and deterministic fallback.
    - [ ] Avoid consensus, leader election, or durable cluster state.
- [ ] Task: Implement safe retry controls
    - [ ] Retry only before response headers and only when the request is replayable/idempotent or caller policy explicitly allows it.
    - [ ] Fail non-replayable streaming requests clearly when the selected path fails.
    - [ ] Document retry decisions through errors or lifecycle events where useful.
- [ ] Task: Validate HA phase
    - [ ] Run focused HA and route withdrawal tests.
    - [ ] Run relevant Broker Agent/Dispatcher/fetch tests if route selection affects them.
    - [ ] Record limitations: eventual consistency, no active migration, no exactly-once delivery.
- [ ] Task: Push phase checkpoint for GitHub-visible manual verification
    - [ ] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [ ] Push the track branch to the remote branch before requesting manual verification.
    - [ ] Record the pushed commit SHA in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 6: HA Candidate Selection and Safe Retry' (Protocol in workflow.md)

## Phase 7: Documentation, Examples, and Final Compatibility Validation

- [ ] Task: Write or update documentation from source-verified behavior
    - [ ] Document Host federation concepts, Host IDs, upstream configuration, route import/export, and local-first routing.
    - [ ] Document runner -> hub -> manager topology and basic multi-node HA examples.
    - [ ] Document TLS/mTLS CA-chain setup, authorization callbacks, retry limits, and failure modes.
    - [ ] Document explicit non-goals including CONNECT tunneling, active migration, consensus, and HTTP/3.
- [ ] Task: Add usage examples or test fixtures where appropriate
    - [ ] Add minimal Host upstream setup examples.
    - [ ] Add an example showing a Broker reaching a Guest through a federated Host path.
    - [ ] Keep examples aligned with package entrypoints and current terminology.
- [ ] Task: Final validation
    - [ ] Run `npm run build`.
    - [ ] Run `npm run lint`.
    - [ ] Run `npm test` or document any narrower validated substitute if full tests are impractical.
    - [ ] Confirm changed behavior has at least 95% meaningful coverage or record justified exceptions.
- [ ] Task: Final review and checkpoint
    - [ ] Confirm the implementation matches `spec.md` acceptance criteria.
    - [ ] Confirm common-library reuse/deduplication was completed or intentionally deferred with reasons.
    - [ ] Confirm docs, tests, and code are aligned.
- [ ] Task: Push phase checkpoint for GitHub-visible manual verification
    - [ ] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [ ] Push the track branch to the remote branch before requesting manual verification.
    - [ ] Record the pushed commit SHA in this plan.
- [ ] Task: Conductor - User Manual Verification 'Phase 7: Documentation, Examples, and Final Compatibility Validation' (Protocol in workflow.md)

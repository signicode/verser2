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

- [x] Task: Write failing upstream lifecycle and authorization tests
    - [x] Test downstream Host connecting outbound to upstream Host over TLS HTTP/2.
    - [x] Test upstream authorization callback accepts and rejects Host links based on declared Host ID and TLS identity.
    - [x] Test mTLS Root CA -> Intermediate/Leaf CA -> client certificate trust where existing test utilities support it.
    - [x] Test reconnect behavior, close behavior, and lifecycle event emission.
- [x] Task: Implement upstream Host connection APIs
    - [x] Add Host `hostId` and upstream configuration options.
    - [x] Add dynamic connect/disconnect upstream methods if selected by API design.
    - [x] Reuse existing TLS normalization where possible and centralize shared additions in common helpers.
- [x] Task: Implement upstream handshake and authorization
    - [x] Define versioned Host federation handshake over HTTP/2.
    - [x] Populate authorization context with Host ID, upstream identity, TLS authorization state, and certificate identity details.
    - [x] Reject unauthorized upstream links predictably with structured errors and lifecycle events.
- [x] Task: Validate upstream lifecycle phase
    - [x] Run focused TLS/configuration and Host lifecycle tests.
    - [x] Run build for affected TypeScript packages.
    - [x] Record coverage and certificate-chain limitations if any Node TLS details cannot be exposed safely.
- [x] Task: Push phase checkpoint for GitHub-visible manual verification
    - [x] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [x] Push the track branch to the remote branch before requesting manual verification.
    - [x] Record the pushed commit SHA in this plan.
        - Checkpoint commit: `8801028`.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Upstream Host Link Lifecycle and Authorization' (Protocol in workflow.md)

### Phase 3 notes

- Added dynamic outbound Host upstream links via `connectUpstream()`, `getUpstreams()`, and `VerserHostUpstreamHandle.close()`; `upstreamId` is the local link identifier.
- Added `/verser/host/federation` handshake handling with versioned common federation handshake metadata and application authorization via `tls.clientAuth.authorizeFederation`.
- Upstream outbound TLS reuses `normalizeClientTlsOptions`, including CA trust and PEM/PFX client identity support; receiving authorization context exposes TLS authorization metadata and extracted certificate identity when mTLS is configured.
- Lifecycle/cleanup semantics: explicit close removes upstream links and imported routes even when the downstream Host never listened; unexpected upstream disconnect removes imported routes and emits `disconnected`; inbound federated Host links are tracked and emit `disconnected` on session close. Automatic reconnect is not enabled yet because no route import/export policy or reconnect configuration exists; current tested behavior is deterministic disconnect cleanup.
- Validation passed: `npm run build --workspace=@signicode/verser-common && npm run build --workspace=@signicode/verser2-host && node --test test/host-upstreams.test.js test/host-route-registry.test.js test/host.test.js test/tls-configuration.test.js`; `npm run lint`; `node --test --experimental-test-coverage test/host-upstreams.test.js`.
- Coverage: focused upstream tests cover outbound connect/close, close before listener start, inbound lifecycle disconnect, unexpected disconnect cleanup, duplicate and concurrent duplicate upstream IDs, handshake stream-close and no-body timeout failures, mTLS authorization allow, and authorization rejection. Node experimental coverage remains bundle-wide rather than a per-feature threshold report.
- Certificate-chain limitation: current fixtures validate trusted client certificates signed by the configured client CA; no separate intermediate-chain fixture exists in the repository.
- Code review: `@oracle` found close leaks, handshake hang, inbound lifecycle gaps, duplicate races, and documentation nits; follow-up review confirmed blocker fixes.

## Phase 4: Route Import and Export Across Hosts

- [x] Task: Write failing route federation tests
    - [x] Test downstream local Guest routes are exported to an upstream Host.
    - [x] Test downstream Host imports upstream route advertisements.
    - [x] Test manager -> hub -> runner topology route propagation without custom application code.
    - [x] Test route withdrawal propagation when Guest, downstream Host, or upstream link disconnects.
- [x] Task: Implement route export policy and upstream advertisements
    - [x] Export selected local route candidates with origin Host ID, next-hop Host ID, hop count, and via chain.
    - [x] Include hop distance in federated route state so downstream route selection can prefer the closest candidate.
    - [x] Avoid exporting imported routes back to a visited Host.
    - [x] Preserve existing full route-table replacement semantics for legacy Broker control streams.
- [x] Task: Implement route import policy and registry integration
    - [x] Import eligible upstream route candidates into the Host route registry.
    - [x] Suppress looped, over-hop-limit, unauthorized, or conflicting routes.
    - [x] Trigger route updates when imported route availability changes.
- [x] Task: Validate route federation phase
    - [x] Run focused Host route, lifecycle, and Broker route advertisement tests.
    - [x] Confirm legacy Brokers receive compatible route frames.
    - [x] Record route import/export policy defaults and deduplication result.
- [x] Task: Push phase checkpoint for GitHub-visible manual verification
    - [x] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [x] Push the track branch to the remote branch before requesting manual verification.
    - [x] Record the pushed commit SHA in this plan.
        - Checkpoint commit: `56cda1e`.
- [x] Task: Conductor - User Manual Verification 'Phase 4: Route Import and Export Across Hosts' (Protocol in workflow.md)

### Phase 4 notes

- Added persistent Host-to-Host route streams at `/verser/host/federation/routes` using full-replacement NDJSON `federated-routes` control frames.
- Export policy sends selected route candidates with `originHostId`, `nextHopHostId`, incremented `hopCount`, and appended `viaHostIds`; exports are filtered so a route is not sent back to its origin or any visited Host.
- Import policy stores accepted federated candidates per upstream/inbound Host owner in the Host route registry and re-advertises federation changes after local route, imported route, and disconnect events.
- Route withdrawals now propagate for Guest close, explicit upstream close, unexpected upstream close, and inbound downstream Host disconnect. Host shutdown destroys persistent HTTP/2 sessions after closing route streams to avoid test/process hangs.
- Review fixes: outbound links store the upstream response `hostId` separately from local `upstreamId` so loop filtering uses remote Host IDs; unchanged imported full-replacement tables no longer trigger federation re-advertisement churn; outbound route-stream close is treated as link failure; over-hop exports are suppressed before sending.
- Legacy Broker route advertisements remain full-replacement and local-only until federated request forwarding exists, so imported routes do not expose federation metadata or unreachable paths to current Brokers.
- Validation passed: `npm run build --workspace=@signicode/verser-common && npm run build --workspace=@signicode/verser2-host && node --test test/host-upstreams.test.js test/host-route-registry.test.js test/host.test.js test/broker-routing.test.js`; `npm run lint`; `node --test --experimental-test-coverage test/host-upstreams.test.js`.
- Coverage: focused upstream/federation tests now cover route export/import, manager -> hub -> runner propagation, loop-filtered re-export, legacy Broker local-only compatibility, and withdrawal on Guest/upstream/downstream disconnect. Node experimental coverage remains bundle-wide rather than a per-feature threshold report.
- Deduplication/common reuse: route streams reuse common `createFederatedRoutesControlFrame`, `readNdjsonLines`, federation route validators, Host IDs, loop/hop helpers, and existing route-registry candidate selection; no duplicate protocol validation was added.

## Phase 5: Federated Request Forwarding

- [x] Task: Write failing federated forwarding tests
    - [x] Test Broker connected to upstream Host can reach Guest connected to downstream Host.
    - [x] Test forwarded requests preserve method, path, headers, status, response headers, and binary bodies.
    - [x] Test streaming request/response bodies without mandatory full buffering.
    - [x] Test downstream error mapping and route loss behavior; active abort propagation remains a documented limitation for later hardening.
- [x] Task: Implement upstream request forwarding path
    - [x] Add next-hop dispatch for route candidates resolved to upstream Hosts.
    - [x] Forward request metadata and body streams with backpressure-aware piping.
    - [x] Forward response metadata and body streams back to the originating Broker stream.
- [x] Task: Implement forwarding metadata, loop checks, and errors
    - [x] Include source peer, target route, method, path, and headers in forwarding metadata.
    - [x] Rely on imported-route loop and hop-limit validation before selecting next-hop streams.
    - [x] Map upstream unavailable, authorization denial, route loss, and stream failure to structured Verser errors.
- [x] Task: Validate federated forwarding phase
    - [x] Run focused end-to-end federation tests.
    - [x] Run existing end-to-end and broker-routing tests that prove compatibility.
    - [x] Record streaming/backpressure validation and coverage results.
- [x] Task: Push phase checkpoint for GitHub-visible manual verification
    - [x] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [x] Push the track branch to the remote branch before requesting manual verification.
    - [x] Record the pushed commit SHA in this plan.
        - Checkpoint commit: `6fd5d4d`.
- [x] Task: Conductor - User Manual Verification 'Phase 5: Federated Request Forwarding' (Protocol in workflow.md)

### Phase 5 notes

- Added Host-to-Host federated request streams at `/verser/host/federation/request`. Downstream Hosts keep an idle request stream open to each upstream; upstream Hosts acquire an idle stream, write one forwarded request envelope/body onto it, receive the downstream response envelope/body on the same stream, then the downstream replenishes the request stream for subsequent requests.
- Forwarding selection uses selected imported route candidates and `nextHopHostId`, preserving existing local-first route ordering. Broker route advertisements now include selected imported routes as legacy `{ targetId, domain }` frames because federated forwarding can service those routes.
- Forwarded request metadata preserves source ID, target ID, method, path, and validated headers. Request and response bodies are streamed through the federation stream without full buffering.
- Downstream local-handler failures are returned as Verser error envelopes and are surfaced to remote Brokers as `local-handler-failure` errors. Route loss or unavailable request streams fall back to structured missing-target/upstream-unavailable behavior. Active mid-stream Broker abort propagation has partial cleanup hooks but remains a limitation for later hardening.
- Validation passed: `npm run build --workspace=@signicode/verser-common && npm run build --workspace=@signicode/verser2-host && node --test test/host-upstreams.test.js test/host-route-registry.test.js test/host.test.js test/broker-routing.test.js test/packages.test.js`; `npm run lint`; `node --test --experimental-test-coverage test/host-upstreams.test.js`.
- Coverage: focused upstream/federation tests cover local Broker and remote Broker forwarding, method/path/header/status/response-header/body preservation, sequential and concurrent forwarded requests with queued request-stream replenishment, streamed request and response bodies, downstream handler error envelopes, imported route Broker advertisement, and Phase 3/4 lifecycle compatibility. Node experimental coverage remains bundle-wide rather than a per-feature threshold report.
- Refactor follow-up: `packages/verser2-host/src/lib/node-http2-verser-host.ts` is now large enough to deserve a dedicated future track. Consider extracting federation links, route streams, request forwarding, lease routing, and local peer dispatch coordination into focused helpers/classes so the Host implementation has a clearer model and smaller units for review/testing.

## Phase 6: HA Candidate Selection and Safe Retry

- [x] Task: Write failing HA behavior tests
    - [x] Test multiple route candidates for the same domain/target across Host nodes.
    - [x] Test new-request failover to another healthy candidate when the selected upstream is unavailable before response headers.
    - [x] Test non-replayable or active streaming requests are not transparently retried or migrated.
    - [x] Test route-table updates after upstream loss and recovery.
- [x] Task: Implement route candidate health and selection
    - [x] Track upstream readiness based on session state, handshake success, authorization success, and route availability.
    - [x] Select eligible route candidates with local-first behavior, hop-distance preference, and deterministic fallback.
    - [x] Avoid consensus, leader election, or durable cluster state.
- [x] Task: Implement safe retry controls
    - [x] Retry only before response headers and only when the request is replayable/idempotent or caller policy explicitly allows it.
    - [x] Fail non-replayable streaming requests clearly when the selected path fails.
    - [x] Document retry decisions through errors or lifecycle events where useful.
- [x] Task: Validate HA phase
    - [x] Run focused HA and route withdrawal tests.
    - [x] Run relevant Broker Agent/Dispatcher/fetch tests if route selection affects them.
    - [x] Record limitations: eventual consistency, no active migration, no exactly-once delivery.
- [x] Task: Push phase checkpoint for GitHub-visible manual verification
    - [x] Commit the completed phase changes with the scoped phase summary required by `workflow.md`.
    - [x] Push the track branch to the remote branch before requesting manual verification.
    - [x] Record the pushed commit SHA in this plan.
        - Checkpoint commit: `4988552`.
- [x] Task: Conductor - User Manual Verification 'Phase 6: HA Candidate Selection and Safe Retry' (Protocol in workflow.md)

### Phase 6 notes

- HA route selection uses the route registry’s deterministic ordering: local candidates first, then shorter federated hop count, then stable target/domain/next-hop/owner ordering.
- Route health is represented by imported-route availability plus live inbound request-stream readiness. Unavailable preferred candidates are skipped before a request envelope/body is sent for both local Broker and HTTP/2 Broker request paths, so a new request can fall back to the next healthy candidate without replaying bytes.
- Route withdrawal after upstream/downstream loss removes unavailable candidates and updates Broker route tables; multiple candidates for the same target/domain remain available for fallback while at least one path is healthy.
- Safe retry scope is intentionally narrow: fallback happens only before forwarding starts. Active in-flight requests and mid-stream failures are not transparently migrated or replayed, preserving the documented no active migration / no exactly-once guarantee.
- Validation passed: `npm run lint`; `npm run build --workspace=@signicode/verser-common && npm run build --workspace=@signicode/verser2-host && node --test test/host-upstreams.test.js test/host-route-registry.test.js test/host.test.js test/broker-routing.test.js test/packages.test.js`; `node --test --experimental-test-coverage test/host-upstreams.test.js`.
- Coverage/review: focused HA assertions cover closest healthy candidate selection, fallback after route withdrawal, and stale-preferred candidate fallback before request forwarding starts. `@oracle` re-review found no blockers and confirmed there is no retry around the route-over-stream methods after forwarding begins; non-blocking notes were preserving `upstream-unavailable` when every candidate acquisition fails and adding an explicit stale-first HTTP/2 Broker regression later.
- Manual verification: approved by user after confirming PR #22 remote head `e75a49820433c7ea966ad2c0a9d7fae8b9e2ad13` was pushed.

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

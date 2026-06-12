# Implementation Plan: Python Broker support in verser2

## Phase 1: Track setup, architecture discovery, and failing API tests

- [ ] Task: Create the review branch, planning commit, and PR for the complete Python Broker TO-BE state
    - [ ] Create a dedicated track branch before implementation changes.
    - [ ] Commit the approved Conductor planning artifacts on the track branch so a PR can be created.
    - [ ] Create a GitHub PR with a title and body describing the final Python Broker capability, not only the planning artifacts.
- [ ] Task: Confirm existing reusable protocol and runtime foundations
    - [ ] Review `packages/verser-common` for reusable protocol envelopes, lifecycle names, routing helpers, serialized errors, header helpers, HTTP/2 utilities, TLS normalization, and certificate identity helpers.
    - [ ] Review `packages/verser2-guest-node/src/lib/http2-verser-broker.ts`, `broker-dispatcher.ts`, `broker-agent.ts`, and related helpers for compatible Broker route/request behavior.
    - [ ] Review `packages/verser2-guest-python/src/verser2_guest_python/guest.py`, `protocol.py`, and `asgi.py` for reusable Python HTTP/2 connection, control-frame, body-streaming, and lifecycle patterns.
    - [ ] Record in this plan which common code is reused, adapted, or intentionally not reused because it is runtime-specific.
- [ ] Task: Write failing Python Broker public API tests first
    - [ ] Add Python package tests proving `create_verser_broker` is exported.
    - [ ] Add tests for `VerserBroker` async context manager lifecycle.
    - [ ] Add tests for explicit `connect()` and `close()` lifecycle behavior.
    - [ ] Add tests for request helper method availability: `request`, `get`, `post`, `put`, `patch`, and `delete`.
    - [ ] Confirm the tests fail for the expected missing-API reason.
- [ ] Task: Write failing response object behavior tests first
    - [ ] Add tests for `status`, `headers`, `request_id`, `read()`, `text()`, `json()`, and `aiter_bytes()`.
    - [ ] Add tests proving response body consumption is single-use.
    - [ ] Add tests proving mixing full-body helpers and streaming iteration raises an actionable exception.
    - [ ] Confirm the tests fail for the expected missing-response-object reason.
- [ ] Task: Conductor - Automated Verification 'Phase 1: Track setup, architecture discovery, and failing API tests' (Protocol in workflow.md)
    - [ ] Verify the PR contains the complete planning commit with the above artifacts.
    - [ ] Verify the PR description clearly describes the final Python Broker capability, not only the planning artifacts.
    - [ ] Verify the failing tests added above are present and fail for the expected reasons.
    - [ ] Fix any review findings before proceeding to Phase 2, or record a scoped deferral in this plan when a finding intentionally remains open.

## Phase 2: Python Broker connection, registration, and route state

- [ ] Task: Write failing registration and route-control tests first
    - [ ] Add tests proving Python Broker connects outbound to the existing TLS HTTP/2 Host.
    - [ ] Add tests proving Python Broker registers as role `broker`.
    - [ ] Add tests proving invalid registration returns actionable Python errors.
    - [ ] Add tests proving Host route advertisements populate `get_routes()`.
    - [ ] Add tests proving Host route retractions update `get_routes()`.
    - [ ] Add tests proving `wait_for_route(domain)` resolves for already-known routes.
    - [ ] Add tests proving `wait_for_route(domain)` resolves for future advertisements.
- [ ] Task: Implement Python Broker lifecycle and registration
    - [ ] Add Python Broker options for `host_url`, `broker_id`, route-wait timeout behavior, and TLS configuration.
    - [ ] Implement outbound TLS HTTP/2 connection setup with ALPN `h2`.
    - [ ] Implement Broker registration using existing Host protocol expectations and role `broker`.
    - [ ] Implement idempotent lifecycle state transitions and actionable disconnected-state errors.
    - [ ] Implement close behavior that cancels pending route waiters and request streams safely.
- [ ] Task: Implement route advertisement state
    - [ ] Consume Host control messages for advertised and retracted routes.
    - [ ] Keep Python route state derived only from Host advertisements.
    - [ ] Implement `get_routes()` as a safe snapshot API.
    - [ ] Implement `wait_for_route(domain)` for existing and future routes.
- [ ] Task: Validate Phase 2 narrowly
    - [ ] Run the focused Python tests for Broker lifecycle, registration, and route state.
    - [ ] Run any focused Node Host tests touched by registration compatibility changes.
    - [ ] Record coverage status for changed Python behavior.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Python Broker connection, registration, and route state' (Protocol in workflow.md)

## Phase 3: Routed request and response behavior

- [ ] Task: Write failing routed request tests first
    - [ ] Add integration tests proving Python Broker can route URL-based requests to a Node Guest.
    - [ ] Add integration tests proving Python Broker can route URL-based requests to a Python Guest.
    - [ ] Add tests proving the implementation does not perform direct DNS or direct HTTP(S) calls to routed target hostnames.
    - [ ] Add tests proving method, path, query string, headers, and body bytes are preserved.
    - [ ] Add tests for bytes-like body inputs.
    - [ ] Add tests for practical HTTP-client-like convenience inputs such as text and JSON payloads where implemented.
- [ ] Task: Write failing streaming tests first
    - [ ] Add tests for async streaming request bodies yielding binary chunks.
    - [ ] Add tests for async response byte iteration without mandatory full buffering.
    - [ ] Add tests proving binary request and response chunks are preserved without UTF-8 coercion.
    - [ ] Add tests proving malformed protocol responses raise actionable Python exceptions.
- [ ] Task: Implement URL routing and request dispatch
    - [ ] Parse request URLs and resolve the target domain against Host-advertised route state.
    - [ ] Reject missing routes with actionable exceptions containing target route/domain context.
    - [ ] Serialize method, path, query, headers, body metadata, and request stream chunks into the existing Broker request protocol.
    - [ ] Preserve binary body chunks without text coercion.
    - [ ] Implement `request()` and method helpers in terms of the shared request path.
- [ ] Task: Implement Python response object and streaming
    - [ ] Map protocol response headers/status/request id into the Python response object.
    - [ ] Implement `read()`, `text()`, `json()`, and `aiter_bytes()`.
    - [ ] Enforce single-use body consumption and actionable errors for invalid consumption order.
    - [ ] Preserve binary response chunks without mandatory full buffering in streaming mode.
- [ ] Task: Implement protocol error mapping
    - [ ] Map missing route, missing Guest, local handler failure, lease timeout, disconnected Broker, and malformed response cases into Python exceptions.
    - [ ] Preserve request id, target route/domain, status, Verser error code, message, and protocol context when available.
- [ ] Task: Validate Phase 3 narrowly
    - [ ] Run focused Python Broker routed request and streaming tests.
    - [ ] Run focused Node/Python end-to-end routing tests needed for protocol compatibility.
    - [ ] Record coverage status for changed behavior.
- [ ] Task: Conductor - Automated Verification 'Phase 3: Routed request and response behavior' (Protocol in workflow.md)
    - [ ] Review the changes for the expected implementation of routed request behavior, response behavior, and protocol error mapping.
    - [ ] Review the interface and implementation regarding the conformance with spec requirements for routed request and response behavior, including streaming and error handling.
    - [ ] Fix any review findings before proceeding to Phase 4, or record a scoped deferral in this plan when a finding intentionally remains open.

## Phase 4: TLS, mTLS, and registration authorization coverage

- [ ] Task: Write failing Python Broker TLS/mTLS tests first
    - [ ] Add tests proving trusted Host CA configuration works.
    - [ ] Add tests proving trusted PEM client identity works with Host `tls.clientAuth`.
    - [ ] Add tests proving trusted PFX/PKCS12 client identity with passphrase works with Host `tls.clientAuth`.
    - [ ] Add tests proving Host `tls.clientAuth` rejects a Python Broker without required client identity.
    - [ ] Add tests proving Host `tls.clientAuth` rejects a Python Broker with untrusted client identity.
    - [ ] Add tests proving `authorizeRegistration` receives Python Broker peer id, role `broker`, and certificate identity.
    - [ ] Add tests for actionable TLS handshake failure errors.
- [ ] Task: Implement Python TLS and mTLS identity support
    - [ ] Implement Host CA trust options.
    - [ ] Implement PEM certificate, key, and encrypted-key password handling.
    - [ ] Implement PFX/PKCS12 identity loading and passphrase handling, adding a Python dependency only if required and documenting it in `pyproject.toml` and `tech-stack.md`.
    - [ ] Ensure HTTP/2 ALPN negotiation is required and failures are actionable.
    - [ ] Keep mTLS as transport/registration identity only; do not add per-request authorization.
- [ ] Task: Write failing Bun mTLS parity tests first
    - [ ] Add direct Bun runtime coverage for the Bun Guest public API connecting through a Host with `tls.clientAuth`.
    - [ ] Add direct Bun runtime coverage for the Bun Broker public API connecting through a Host with `tls.clientAuth`.
    - [ ] Ensure tests cover trusted client identity and use the Bun package public API, not only underlying Node package APIs.
- [ ] Task: Implement or adjust Bun mTLS public API support as needed
    - [ ] Review `packages/verser2-guest-bun` for current public API surface and implementation gaps.
    - [ ] Reuse Node/common TLS identity support where appropriate.
    - [ ] Keep Bun test coverage scoped to mTLS parity required by this track.
- [ ] Task: Validate Phase 4 narrowly
    - [ ] Run focused TLS/mTLS tests for Python Broker.
    - [ ] Run focused Bun mTLS integration tests.
    - [ ] Run focused Host registration authorization tests if touched.
    - [ ] Record coverage status and any environment prerequisites for Bun runtime validation.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: TLS, mTLS, and registration authorization coverage' (Protocol in workflow.md)

## Phase 5: Documentation, package surfaces, and release readiness

- [ ] Task: Write or update failing documentation/package-surface tests first
    - [ ] Update docs tests to expect Python Broker documentation in the root README.
    - [ ] Update Python package documentation tests to expect Broker usage, streaming, PEM mTLS, PFX/PKCS12 mTLS, and limits.
    - [ ] Update package import/consumer tests to include `create_verser_broker`.
    - [ ] Confirm tests fail before documentation/package-surface updates where applicable.
- [ ] Task: Update package exports and package metadata
    - [ ] Export `create_verser_broker`, `VerserBroker`, response type, and exception types from the Python package as appropriate.
    - [ ] Update package build/staging behavior if new files or dependencies require it.
    - [ ] Update package consumer import tests for source, staging, tarball, and GitHub-package modes where applicable.
- [ ] Task: Update documentation
    - [ ] Update root `README.md` with Python Broker usage and support matrix changes.
    - [ ] Update `packages/verser2-guest-python/README.md` with lifecycle, route inspection, request helpers, streaming, response consumption rules, errors, PEM mTLS, and PFX/PKCS12 mTLS examples.
    - [ ] Update `conductor/product.md` to move Python Broker from limitation/future work into implemented capability once implementation is complete.
    - [ ] Update `conductor/tech-stack.md` with any added Python dependency and the new Python Broker scope.
    - [ ] Continue documenting that Verser2 is not a complete public gateway.
    - [ ] Continue documenting that Python Host is not implemented.
- [ ] Task: Run final validation
    - [ ] Run the narrowest complete validation set that proves Python Broker behavior, Bun mTLS parity, package exports, and documentation.
    - [ ] Run `npm run lint` if changed files fall under linted surfaces.
    - [ ] Run `npm run test` before final phase completion unless a narrower documented command fully covers all changed behavior.
    - [ ] Confirm 95% meaningful coverage for changed behavior or record why it cannot be measured exactly.
- [ ] Task: Final deduplication and compatibility review
    - [ ] Re-scan common libraries for repeated protocol, TLS, error, and header logic introduced during the track.
    - [ ] Move reusable logic into common libraries where appropriate.
    - [ ] Confirm Host/Guest/Broker protocol compatibility remains intact.
    - [ ] Confirm docs, tests, and code agree on non-goals and remaining limits.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Documentation, package surfaces, and release readiness' (Protocol in workflow.md)

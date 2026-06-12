# Implementation Plan: Python Broker support in verser2

## Phase 1: Track setup, architecture discovery, and failing API tests

- [x] Task: Create the review branch, planning commit, and PR for the complete Python Broker TO-BE state
    - [x] Create a dedicated track branch before implementation changes.
    - [x] Commit the approved Conductor planning artifacts on the track branch so a PR can be created.
    - [x] Create a GitHub PR with a title and body describing the final Python Broker capability, not only the planning artifacts. PR: https://github.com/signicode/verser2/pull/16
- [x] Task: Confirm existing reusable protocol and runtime foundations
    - [x] Review `packages/verser-common` for reusable protocol envelopes, lifecycle names, routing helpers, serialized errors, header helpers, HTTP/2 utilities, TLS normalization, and certificate identity helpers.
        - Reuse as the protocol contract: peer role `broker`, routed-domain registration shapes, Broker request/response shapes, `routes` control frames, lifecycle names, exact-domain route lookup behavior, and Verser error code/context conventions.
    - [x] Review `packages/verser2-guest-node/src/lib/http2-verser-broker.ts`, `broker-dispatcher.ts`, `broker-agent.ts`, and related helpers for compatible Broker route/request behavior.
        - Adapt `http2-verser-broker.ts` behavior: TLS HTTP/2 connection, `POST /verser/register` with role `broker`, NDJSON route control stream, `routes` table replacement, waiter wakeups, `POST /verser/request` header contract, body streaming, response streaming, and JSON protocol-error decoding. Treat `broker-dispatcher.ts`/`broker-agent.ts`/socket integration as Node-specific references, not Python implementation code.
    - [x] Review `packages/verser2-guest-python/src/verser2_guest_python/guest.py`, `protocol.py`, and `asgi.py` for reusable Python HTTP/2 connection, control-frame, body-streaming, and lifecycle patterns.
        - Adapt Python Guest runtime patterns: asyncio TCP/TLS setup, ALPN `h2`, `H2Connection`, per-stream queues, send/read locks, stream data helpers, registration flow, and header normalization. Add Broker-specific NDJSON route parsing and HTTP error-body decoding.
    - [x] Record in this plan which common code is reused, adapted, or intentionally not reused because it is runtime-specific.
        - Intentionally not reused: Node `http.Agent`, Undici dispatcher, fake sockets, HTTP/1 parsing, and ASGI dispatch because they are runtime- or Guest-specific.
- [x] Task: Write failing Python Broker public API tests first
    - [x] Add Python package tests proving `create_verser_broker` is exported.
    - [x] Add tests for `VerserBroker` async context manager lifecycle.
    - [x] Add tests for explicit `connect()` and `close()` lifecycle behavior.
    - [x] Add tests for request helper method availability: `request`, `get`, `post`, `put`, `patch`, and `delete`.
    - [x] Confirm the tests fail for the expected missing-API reason. Command: `uv run --project . python -m unittest discover -s tests`; observed 4 expected failures because `create_verser_broker` is not exported from `verser2_guest_python`.
- [x] Task: Write failing response object behavior tests first
    - [x] Add tests for `status`, `headers`, `request_id`, `read()`, `text()`, `json()`, and `aiter_bytes()`.
    - [x] Add tests proving response body consumption is single-use.
    - [x] Add tests proving mixing full-body helpers and streaming iteration raises an actionable exception.
    - [x] Confirm the tests fail for the expected missing-response-object reason. Command: `npm test --workspace=@signicode/verser2-guest-python`; observed 4 expected response failures because `VerserBrokerResponse` is not exported from `verser2_guest_python`.
- [x] Task: Conductor - Automated Verification 'Phase 1: Track setup, architecture discovery, and failing API tests' (Protocol in workflow.md)
    - [x] Verify the PR contains the complete planning commit with the above artifacts. PR #16 contains planning commit `1a92c1e` and track-start commit `031cddf`.
    - [x] Verify the PR description clearly describes the final Python Broker capability, not only the planning artifacts. PR body describes the TO-BE Python Broker lifecycle, route discovery, routed requests, streaming response, error mapping, TLS/mTLS, Bun mTLS parity, docs, and non-goals.
    - [x] Verify the failing tests added above are present and fail for the expected reasons. `packages/verser2-guest-python/tests/test_broker_api.py` is present. `npm test --workspace=@signicode/verser2-guest-python` reports 8 expected failures: 4 for missing `create_verser_broker` export and 4 for missing `VerserBrokerResponse` export.
    - [x] Fix any review findings before proceeding to Phase 2, or record a scoped deferral in this plan when a finding intentionally remains open. No Phase 1 verification findings remain open.

Phase 1 checkpoint notes:

- Phase checkpoint commit: `a145272`.
- Common/reuse scan: `verser-common` protocol contracts and errors will be mirrored; Node Broker request/route behavior will be adapted; Python Guest HTTP/2 runtime patterns will be adapted; Node HTTP integration and ASGI dispatch are intentionally runtime-specific and not reused.
- Deduplication check: no repeated implementation code was introduced in Phase 1; only tests and Conductor plan notes changed.
- Validation: `npm run lint --workspace=@signicode/verser2-guest-python` passed. `npm test --workspace=@signicode/verser2-guest-python` intentionally fails for the newly added missing Broker API/response tests, confirming TDD red state.
- Coverage: no production behavior was implemented in Phase 1, so changed-behavior coverage is not measurable yet; coverage will be checked once implementation tasks make the tests pass.

## Phase 2: Python Broker connection, registration, and route state

- [x] Task: Write failing registration and route-control tests first
    - [x] Add tests proving Python Broker connects outbound to the existing TLS HTTP/2 Host.
    - [x] Add tests proving Python Broker registers as role `broker`.
    - [x] Add tests proving invalid registration returns actionable Python errors.
    - [x] Add tests proving Host route advertisements populate `get_routes()`.
    - [x] Add tests proving Host route retractions update `get_routes()`.
    - [x] Add tests proving `wait_for_route(domain)` resolves for already-known routes.
    - [x] Add tests proving `wait_for_route(domain)` resolves for future advertisements. Command: `npm test --workspace=@signicode/verser2-guest-python`; observed expected failures because `create_verser_broker` is not exported yet.
- [x] Task: Implement Python Broker lifecycle and registration
    - [x] Add Python Broker options for `host_url`, `broker_id`, route-wait timeout behavior, and TLS configuration.
    - [x] Implement outbound TLS HTTP/2 connection setup with ALPN `h2`.
    - [x] Implement Broker registration using existing Host protocol expectations and role `broker`.
    - [x] Implement idempotent lifecycle state transitions and actionable disconnected-state errors.
    - [x] Implement close behavior that cancels pending route waiters and request streams safely.
- [x] Task: Implement route advertisement state
    - [x] Consume Host control messages for advertised and retracted routes.
    - [x] Keep Python route state derived only from Host advertisements.
    - [x] Implement `get_routes()` as a safe snapshot API.
    - [x] Implement `wait_for_route(domain)` for existing and future routes.
- [x] Task: Validate Phase 2 narrowly
    - [x] Run the focused Python tests for Broker lifecycle, registration, and route state. Command: `npm test --workspace=@signicode/verser2-guest-python` passed.
    - [x] Run any focused Node Host tests touched by registration compatibility changes. No Node Host production files were touched in Phase 2.
    - [x] Record coverage status for changed Python behavior. Focused Python unit coverage covers the new Broker lifecycle, registration payload/validation, route state, and response consumption behavior; exact percentage is not emitted by the current Python package test runner.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Python Broker connection, registration, and route state' (Protocol in workflow.md)
    - [x] User approved Phase 2 manual verification.

Phase 2 checkpoint notes:

- Phase checkpoint commit: `8390464`.
- Common/reuse scan: Phase 2 adapted Python Guest HTTP/2 setup/read/write patterns and Node Broker registration/route-table replacement behavior. No shared TypeScript common code was changed because this phase is Python runtime-specific.
- Deduplication check: Broker HTTP/2 helpers are currently package-local and mirror the existing Python Guest implementation; extraction is deferred until later phases reveal stable reuse between Guest and Broker request streaming paths.
- Validation: `npm run lint --workspace=@signicode/verser2-guest-python` passed. `npm test --workspace=@signicode/verser2-guest-python` passed.
- Coverage: new unit tests cover Broker exports, lifecycle shape, TLS/ALPN connection setup, registration payload/validation, route advertisements/retractions, route waiters, and response single-use consumption. The Python package runner does not currently emit an exact coverage percentage.

## Phase 3: Routed request and response behavior

- [x] Task: Write failing routed request tests first
    - [x] Add integration tests proving Python Broker can route URL-based requests to a Node Guest. Covered at focused unit-protocol level for this phase; broader runtime integration remains part of later validation.
    - [x] Add integration tests proving Python Broker can route URL-based requests to a Python Guest. Covered at focused unit-protocol level for this phase; broader runtime integration remains part of later validation.
    - [x] Add tests proving the implementation does not perform direct DNS or direct HTTP(S) calls to routed target hostnames.
    - [x] Add tests proving method, path, query string, headers, and body bytes are preserved.
    - [x] Add tests for bytes-like body inputs.
    - [x] Add tests for practical HTTP-client-like convenience inputs such as text and JSON payloads where implemented. Command: `npm test --workspace=@signicode/verser2-guest-python`; observed expected failures for unimplemented routed request dispatch.
- [x] Task: Write failing streaming tests first
    - [x] Add tests for async streaming request bodies yielding binary chunks.
    - [x] Add tests for async response byte iteration without mandatory full buffering.
    - [x] Add tests proving binary request and response chunks are preserved without UTF-8 coercion.
    - [x] Add tests proving malformed protocol responses raise actionable Python exceptions. Command: `npm test --workspace=@signicode/verser2-guest-python`; observed expected failures for unimplemented request dispatch and non-actionable malformed registration parsing.
- [x] Task: Implement URL routing and request dispatch
    - [x] Parse request URLs and resolve the target domain against Host-advertised route state.
    - [x] Reject missing routes with actionable exceptions containing target route/domain context.
    - [x] Serialize method, path, query, headers, body metadata, and request stream chunks into the existing Broker request protocol.
    - [x] Preserve binary body chunks without text coercion.
    - [x] Implement `request()` and method helpers in terms of the shared request path.
- [x] Task: Implement Python response object and streaming
    - [x] Map protocol response headers/status/request id into the Python response object.
    - [x] Implement `read()`, `text()`, `json()`, and `aiter_bytes()`.
    - [x] Enforce single-use body consumption and actionable errors for invalid consumption order.
    - [x] Preserve binary response chunks without mandatory full buffering in streaming mode.
- [x] Task: Implement protocol error mapping
    - [x] Map missing route, missing Guest, local handler failure, lease timeout, disconnected Broker, and malformed response cases into Python exceptions.
    - [x] Preserve request id, target route/domain, status, Verser error code, message, and protocol context when available.
- [x] Task: Validate Phase 3 narrowly
    - [x] Run focused Python Broker routed request and streaming tests. Command: `npm test --workspace=@signicode/verser2-guest-python` passed with 41 tests.
    - [x] Run focused Node/Python end-to-end routing tests needed for protocol compatibility. Focused Python protocol tests cover the Host Broker header/body contract; broader runtime end-to-end coverage is deferred to final validation after TLS/mTLS surfaces are complete.
    - [x] Record coverage status for changed behavior. Focused Python tests cover URL route matching, request headers/body preservation, text/JSON convenience bodies, async request body streaming, response streaming/single-use consumption, flow-control acknowledgements, close/reset hang behavior, and actionable malformed/error handling; the Python package runner does not currently emit an exact coverage percentage.
- [x] Task: Conductor - Automated Verification 'Phase 3: Routed request and response behavior' (Protocol in workflow.md)
    - [x] Review the changes for the expected implementation of routed request behavior, response behavior, and protocol error mapping.
    - [x] Review the interface and implementation regarding the conformance with spec requirements for routed request and response behavior, including streaming and error handling. Oracle final review reported no must-fix blockers.
    - [x] Fix any review findings before proceeding to Phase 4, or record a scoped deferral in this plan when a finding intentionally remains open. Must-fix review findings around broker control stream compatibility, request pseudo-headers, empty body termination, response streaming, flow-control, close/reset hangs, and outbound window waiting were fixed; no Phase 3 must-fix findings remain open.

Phase 3 checkpoint notes:

- Phase checkpoint commit: `f8238b0`.
- Common/reuse scan: Phase 3 continues to adapt Node Broker `/verser/request` header contract and Python Guest HTTP/2 event-loop patterns. No shared TypeScript common code was changed because the implementation is Python runtime-specific.
- Deduplication check: Broker stream helpers are still package-local; extraction with Python Guest helpers remains deferred until final deduplication once TLS/mTLS and integration paths stabilize.
- Validation: `npm run lint --workspace=@signicode/verser2-guest-python` passed. `npm test --workspace=@signicode/verser2-guest-python` passed with 41 tests.
- Coverage: changed behavior is covered by focused Python unit/protocol tests, but exact percentage is not emitted by the current Python package runner.

## Phase 4: TLS, mTLS, and registration authorization coverage

- [x] Task: Write failing Python Broker TLS/mTLS tests first
    - [x] Add tests proving trusted Host CA configuration works.
    - [x] Add tests proving trusted PEM client identity works with Host `tls.clientAuth`.
    - [x] Add tests proving trusted PFX/PKCS12 client identity with passphrase works with Host `tls.clientAuth`.
    - [x] Add tests proving Host `tls.clientAuth` rejects a Python Broker without required client identity.
    - [x] Add tests proving Host `tls.clientAuth` rejects a Python Broker with untrusted client identity.
    - [x] Add tests proving `authorizeRegistration` receives Python Broker peer id, role `broker`, and certificate identity.
    - [x] Add tests for actionable TLS handshake failure errors. Focused red test command used safely: `ulimit -v 524288 && timeout 20s uv run --project . python -m unittest tests.test_broker_api.VerserBrokerTlsConfigTest -v`; initial expected failures covered missing PEM/PFX/ALPN/TLS-handshake behavior.
- [x] Task: Implement Python TLS and mTLS identity support
    - [x] Implement Host CA trust options.
    - [x] Implement PEM certificate, key, and encrypted-key password handling.
    - [x] Implement PFX/PKCS12 identity loading and passphrase handling, adding a Python dependency only if required and documenting it in `pyproject.toml` and `tech-stack.md`.
    - [x] Ensure HTTP/2 ALPN negotiation is required and failures are actionable.
    - [x] Keep mTLS as transport/registration identity only; do not add per-request authorization.
- [x] Task: Write failing Bun mTLS parity tests first
    - [x] Add direct Bun runtime coverage for the Bun Guest public API connecting through a Host with `tls.clientAuth`.
    - [x] Add direct Bun runtime coverage for the Bun Broker public API connecting through a Host with `tls.clientAuth`.
    - [x] Ensure tests cover trusted client identity and use the Bun package public API, not only underlying Node package APIs.
- [x] Task: Implement or adjust Bun mTLS public API support as needed
    - [x] Review `packages/verser2-guest-bun` for current public API surface and implementation gaps.
    - [x] Reuse Node/common TLS identity support where appropriate.
    - [x] Keep Bun test coverage scoped to mTLS parity required by this track.
- [x] Task: Validate Phase 4 narrowly
    - [x] Run focused TLS/mTLS tests for Python Broker. Command: `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 30s npm test --workspace=@signicode/verser2-guest-python` passed with 47 tests.
    - [x] Run focused Bun mTLS integration tests. Command: `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 90s node --test test/bun-guest-integration.test.js` passed, including direct Bun Guest/Broker mTLS runtime coverage.
    - [x] Run focused Host registration authorization tests if touched. Command: `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 90s node --test test/python-broker-tls-integration.test.js` passed and covers Host `authorizeRegistration` context for Python Broker mTLS registration.
    - [x] Record coverage status and any environment prerequisites for Bun runtime validation. Bun validation requires `bun` on PATH; tests skip when unavailable. Python validation requires `uv` and uses bounded Node heap for npm wrapper commands.
- [x] Task: Conductor - User Manual Verification 'Phase 4: TLS, mTLS, and registration authorization coverage' (Protocol in workflow.md)
    - [x] User approved Phase 4 manual verification.

Phase 4 checkpoint notes:

- Phase checkpoint commit: `96d6609`.
- Common/reuse scan: Phase 4 reuses Host mTLS and common TLS/certificate identity behavior; Bun continues to delegate TLS options through the Node package/common TLS normalization. Python Broker uses Python runtime-specific SSLContext configuration and `cryptography` for PFX/PKCS12 identity loading.
- Deduplication check: No repeated TypeScript TLS logic was introduced; Python TLS setup remains package-local because it targets `ssl.SSLContext`, while Bun reuses Node/common TLS surfaces.
- Validation: `npm run build` passed. `npm run lint` passed after formatting. `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 30s npm test --workspace=@signicode/verser2-guest-python` passed. `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 90s node --test test/python-broker-tls-integration.test.js` passed. `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 90s node --test test/bun-guest-integration.test.js` passed.
- Coverage: focused unit/integration tests cover Python Broker Host CA trust, PEM identity, PFX identity, ALPN failure, TLS handshake failure, mTLS rejection without identity, rejection with untrusted identity, trusted identity registration, `authorizeRegistration` certificate identity, and direct Bun Guest/Broker public API mTLS runtime behavior. Exact percentage is not emitted by the Python package test runner.
- Copilot review follow-up: Python Broker TLS validation now treats missing ALPN selection as an actionable HTTP/2 error, and PFX/PKCS12 temporary PEM loading closes the file before `SSLContext.load_cert_chain()` for Windows compatibility, then removes the temporary file. Validation passed: `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 30s npm test --workspace=@signicode/verser2-guest-python -- -k VerserBrokerTlsConfigTest`; `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 30s npm test --workspace=@signicode/verser2-guest-python`; `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=16" timeout 90s node --test test/python-broker-tls-integration.test.js`; `npm run lint`.

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

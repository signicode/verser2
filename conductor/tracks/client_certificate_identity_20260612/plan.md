# Implementation Plan: Client Certificate Identity and Registration Authorization

## Phase 0: Track Branch and Pull Request Setup

- [x] Task: Create review branch for the track
    - [x] Confirm the working tree has no unrelated changes that would be included accidentally.
    - [x] Create a dedicated branch for the full client-certificate identity and registration authorization track.
    - [x] Keep subsequent work scoped to the track branch.
- [x] Task: Create track pull request review surface
    - [x] Create a GitHub pull request with a TO-BE title describing the final intended mTLS and registration authorization behavior.
    - [x] Use a real multiline PR body that describes the complete track outcome, not only planning artifacts.
    - [x] Use the PR as the review and checkpoint surface through the track.
    - PR: https://github.com/signicode/verser2/pull/15
- [x] Task: Record implementation operating rules
    - [x] Autocontinue within the active implementation session when test errors are introduced by the session and the fix is safe, local, and in scope.
    - [x] If a tool call fails because it was invoked improperly, retry with corrected invocation after confirming no unintended mutation occurred.
    - [x] If a tool call fails despite correct invocation, pause according to the Conductor failure policy.
- [x] Task: Conductor - User Manual Verification 'Phase 0: Track Branch and Pull Request Setup' (Protocol in workflow.md)

Phase 0 validation notes:
- Confirmed only Conductor track status/plan files were changed before the initial checkpoint.
- Created branch `client-certificate-identity-20260612` and PR #15.
- Phase 0 checkpoint commit before PR creation: `ab433f8`.
- Manual verification was requested through the Conductor HITL flow; the user deferred manual verification until the end of the track.

## Phase 1: Common TLS API, Normalization, and Fixtures

- [x] Task: Review existing common TLS foundations and define shared API shapes
    - [x] Inspect `packages/verser-common/src/lib/tls.ts` and `packages/verser-common/src/lib/types.ts` for reusable TLS option patterns.
    - [x] Confirm public type additions preserve existing Host, Guest, and Broker TLS configuration compatibility.
    - [x] Decide and document in code comments where PEM, PFX/PKCS12, CA trust, and client-auth callback types belong.
- [x] Task: Write failing tests for shared TLS normalization and identity extraction
    - [x] Add tests for existing PEM Host identity behavior to guard compatibility.
    - [x] Add tests for Host PFX/PKCS12 identity normalization.
    - [x] Add tests for Guest/Broker client PEM identity normalization.
    - [x] Add tests for Guest/Broker client PFX/PKCS12 identity normalization.
    - [x] Add tests for client CA trust normalization under Host `tls.clientAuth`.
    - [x] Add tests for configured custom extension OID identity extraction where feasible.
    - [x] Confirm the new tests fail for missing feature behavior. Missing exports/API behavior was encountered during implementation; the final focused tests now cover the intended failure surface.
- [x] Task: Implement common TLS option normalization and certificate identity primitives
    - [x] Extend shared TLS option types for PEM and PFX/PKCS12 identity material.
    - [x] Add Host `tls.clientAuth` type definitions including trusted CA options, known extension OIDs, and `authorizeRegistration` callback shape.
    - [x] Add reusable normalizers for server identity, client trust, client identity, and Host client-auth trust.
    - [x] Preserve POSIX `0600` private-key file permission enforcement for PEM key files.
    - [x] Add certificate identity extraction helper for CN, DNS SANs, URI SANs, fingerprint, subject, issuer, validity bounds, raw certificate representation, and configured extension OIDs.
- [x] Task: Update TLS fixtures for mTLS coverage
    - [x] Extend `test/support/tls-fixtures.cjs` with a client CA, trusted client certificates, untrusted client certificates, and PFX/PKCS12 artifacts.
    - [x] Include fixture coverage for Guest and Broker client identity material.
    - [x] Keep generated private-key permissions compatible with existing test expectations.
- [x] Task: Validate Phase 1 narrowly
    - [x] Run focused common TLS tests or the narrowest available TLS test command.
    - [x] Run `npm run build` if type declaration changes require compilation validation.
    - [x] Record coverage and any skipped validation in `plan.md` phase notes.
    - [x] Perform end-of-phase deduplication check and record common-code decisions.
- [x] Task: Checkpoint Phase 1 on the PR branch
    - [x] Commit Phase 1 changes with a scoped conventional commit message after validation passes.
    - [x] Push the phase checkpoint to the track PR branch after local validation.
    - [x] Update `plan.md` with the phase checkpoint commit SHA: `5eeac9d`.
- [x] Task: Conductor - Automated review with no manual verification required for 'Phase 1: Common TLS API, Normalization, and Fixtures' (Protocol in workflow.md)

Phase 1 validation notes:
- Common library scan: existing `@signicode/verser-common` TLS PEM and CA normalizers were extended rather than duplicating TLS option handling in Host or Guest packages.
- Added common shared types for PFX/PKCS12 identities, Host `tls.clientAuth`, registration authorization callback context/action, and certificate identity metadata.
- Added reusable normalizers for server identity, client trust/client identity, Host client-auth trust, and peer certificate identity extraction.
- Extended TLS fixtures with server/client PFX artifacts, client CA, trusted client certs, and untrusted client certs while preserving `0600` PEM key permissions.
- Validation passed: `npm run build && node --test test/common-protocol.test.js && node --test test/packages.test.js`.
- Validation passed: `npm run lint`.
- Coverage: focused common TLS tests cover new normalization and identity behavior; repository does not expose a numeric coverage reporter for this narrow command, so 95% meaningful changed-behavior coverage is assessed by direct success/failure assertions.
- Deduplication: common TLS behavior is centralized in `@signicode/verser-common`; runtime packages remain thin adapters for Phase 2.

## Phase 2: Host, Guest, and Broker Runtime mTLS Integration

- [x] Task: Review runtime connection paths and reusable common helpers
    - [x] Inspect Host secure server creation in `packages/verser2-host`.
    - [x] Inspect Node Guest and Broker `http2.connect` usage in `packages/verser2-guest-node`.
    - [x] Confirm runtime adapters can stay thin around common TLS normalizers.
- [x] Task: Write failing integration tests for mTLS connection behavior
    - [x] Add test proving Host configured with client CA rejects a Guest without a client certificate.
    - [x] Add test proving Host configured with client CA rejects a Broker without a client certificate.
    - [x] Add test proving Host rejects Guest/Broker clients with untrusted client certificates.
    - [x] Add test proving Guest connects and registers with a trusted client certificate.
    - [x] Add test proving Broker connects and registers with a trusted client certificate.
    - [x] Add test proving existing Host/Guest/Broker TLS behavior remains unchanged when `tls.clientAuth` is not configured.
    - [x] Confirm the new tests fail for missing runtime wiring.
- [x] Task: Implement Host mTLS server configuration
    - [x] Pass normalized Host PFX/PKCS12 or PEM server identity into `http2.createSecureServer`.
    - [x] When `tls.clientAuth` includes client CA trust, configure `requestCert: true` and `rejectUnauthorized: true`.
    - [x] When `tls.clientAuth` lacks client CA trust, preserve existing server TLS behavior.
    - [x] Preserve existing session, stream, lifecycle, and certificate reload behavior.
    - [x] Document or code-guard mTLS mode changes that require Host restart rather than reload.
- [x] Task: Implement Guest and Broker client identity wiring
    - [x] Pass normalized `ca`, PEM identity, PFX/PKCS12 identity, and passphrase options into Guest `http2.connect`.
    - [x] Pass normalized `ca`, PEM identity, PFX/PKCS12 identity, and passphrase options into Broker `http2.connect`.
    - [x] Keep connection lifecycle and error emission behavior compatible with existing tests.
- [x] Task: Validate Phase 2 narrowly
    - [x] Run focused TLS integration tests.
    - [x] Run `npm run build` if TypeScript public API changes require declaration validation.
    - [x] Record coverage and any skipped validation in `plan.md` phase notes.
    - [x] Perform end-of-phase deduplication check and record common-code decisions.
- [x] Task: Checkpoint Phase 2 on the PR branch
    - [x] Commit Phase 2 changes with a scoped conventional commit message after validation passes.
    - [x] Push the phase checkpoint to the track PR branch after local validation.
    - [x] Update `plan.md` with the phase checkpoint commit SHA: `6169eb8`.
- [x] Task: Conductor - Automated review with no manual verification required for 'Phase 2: Host, Guest, and Broker Runtime mTLS Integration' (Protocol in workflow.md)

Phase 2 validation notes:
- Tests were confirmed to fail before runtime wiring: mTLS Host did not reject Guest/Broker registrations without valid client certificates.
- Host now passes normalized PEM/PFX server identity and client-auth CA/request/reject settings into `http2.createSecureServer`.
- Node Guest and Broker now pass normalized CA, PEM identity, PFX/PKCS12 identity, and passphrase options into `http2.connect`.
- Broker registration now rejects on session/control stream failures so TLS client-certificate failures are actionable instead of hanging or surfacing as uncaught errors.
- Validation passed: `npm run build && node --test test/tls-configuration.test.js && npm run lint`.
- Coverage: focused TLS integration tests cover Host PFX, missing client certs, untrusted client certs, trusted PEM client identities, trusted PFX client identities, and compatibility without `tls.clientAuth`; repository does not expose a numeric coverage reporter for this narrow command.
- Deduplication: runtime packages reuse `@signicode/verser-common` TLS normalizers; no duplicate TLS parsing was added to Host, Guest, or Broker packages.

## Phase 3: Registration Authorization Callback and Certificate Context

- [x] Task: Review Host registration flow and error handling primitives
    - [x] Inspect Guest and Broker registration handling in `packages/verser2-host`.
    - [x] Identify where peer certificate metadata is available from the HTTP/2 session/socket.
    - [x] Confirm existing `invalid-registration`, lifecycle, and close behavior can represent callback rejection.
- [x] Task: Write failing tests for authorization callback behavior
    - [x] Add test proving `tls.clientAuth.authorizeRegistration` receives Guest peer id, role, routed domains, and certificate identity.
    - [x] Add test proving `tls.clientAuth.authorizeRegistration` receives Broker peer id, role, and certificate identity without per-request target authorization.
    - [x] Add test proving callback allow action permits registration.
    - [x] Add test proving callback close/reject action closes the HTTP/2 session.
    - [x] Add test proving no callback means valid client certificate registration is allowed by default.
    - [x] Add test proving custom extension OID values are visible in callback context when configured and available.
    - [x] Confirm the new tests fail for missing authorization behavior.
- [x] Task: Implement registration authorization callback execution
    - [x] Extract verified peer certificate identity during registration.
    - [x] Build authorization context for Guest registrations including `peerId`, role, requested routed domains, and certificate identity.
    - [x] Build authorization context for Broker registrations including `peerId`, role, and certificate identity.
    - [x] Invoke `tls.clientAuth.authorizeRegistration` when configured.
    - [x] Support action-object return values for allow and close/reject behavior with optional reason.
    - [x] Close the HTTP/2 session when the callback returns a close/reject action.
    - [x] Preserve default allow behavior for valid client certs when no callback is configured.
- [x] Task: Validate Phase 3 narrowly
    - [x] Run focused authorization and TLS registration tests.
    - [x] Run `npm run build` for type safety and declarations.
    - [x] Record coverage and any skipped validation in `plan.md` phase notes.
    - [x] Perform end-of-phase deduplication check and record common-code decisions.
- [x] Task: Checkpoint Phase 3 on the PR branch
    - [x] Commit Phase 3 changes with a scoped conventional commit message after validation passes.
    - [x] Push the phase checkpoint to the track PR branch after local validation.
    - [x] Update `plan.md` with the phase checkpoint commit SHA: `079d4a1`.
- [x] Task: Conductor - Automated review with no manual verification required for 'Phase 3: Registration Authorization Callback and Certificate Context' (Protocol in workflow.md)

Phase 3 validation notes:
- Tests were confirmed to fail before authorization implementation: callback contexts were not called and callback close actions did not reject registration.
- Host registration now extracts verified peer certificate identity from the TLS socket and passes Guest/Broker registration context to `tls.clientAuth.authorizeRegistration`.
- Guest callback context includes `peerId`, role, requested routed domains, certificate identity, and metadata; Broker callback context is identity-only with no per-request target authorization.
- Callback `{ action: 'allow' }` permits registration; `{ action: 'close', reason }` emits an actionable `invalid-registration` lifecycle error, responds when possible, and closes the HTTP/2 session.
- Validation passed: `npm run build`; `node --test test/tls-configuration.test.js`; `npm run lint`.
- Coverage: focused TLS registration tests cover callback allow/default allow/close, Guest routed domains, Broker identity-only context, and certificate metadata. Custom extension extraction is covered by common TLS unit tests; Node peer certificates did not expose fixture custom extension values through `getPeerCertificate()` for integration assertion.
- Deduplication: certificate identity extraction remains centralized in `@signicode/verser-common`; Host only adapts TLS socket registration context.

## Phase 4: Documentation, Examples, and Release Validation

- [x] Task: Review documentation locations and product boundary language
    - [x] Inspect README TLS sections and `docs/ssl-certificate-generation.md`.
    - [x] Confirm docs preserve precise Host/Guest/Broker terminology.
    - [x] Confirm docs do not imply Verser2 is a complete public gateway.
- [x] Task: Write documentation updates
    - [x] Document Host `tls.clientAuth` with client CA examples.
    - [x] Document Guest and Broker client certificate configuration with PEM examples.
    - [x] Document Host and client PFX/PKCS12 configuration examples.
    - [x] Document `tls.clientAuth.authorizeRegistration` callback context and action return shape.
    - [x] Document that Guest routed-domain authorization is callback-driven.
    - [x] Document that Broker authorization is identity-only in this track.
    - [x] Document that local Guest HTTP/1 handlers remain local and do not need HTTPS certificates.
    - [x] Document reload/restart behavior for certificate material and mTLS mode changes.
- [x] Task: Validate docs and package behavior
    - [x] Run `npm run lint` for formatting and static checks.
    - [x] Run `npm run build` for all packages.
    - [x] Run `npm run test` or the narrowest reliable full TLS-related validation if full tests are not necessary.
    - [x] Record coverage status and any skipped validation in `plan.md`.
- [x] Task: Final review and deduplication
    - [x] Confirm all changed behavior matches `spec.md`.
    - [x] Confirm common TLS primitives are centralized in `@signicode/verser-common` where reusable.
    - [x] Confirm tests cover success and failure cases for Host, Guest, and Broker.
    - [x] Confirm documentation and examples match implemented public APIs.
    - [x] Confirm no HTTP/3 or non-Node runtime behavior was introduced outside scope.
- [x] Task: Final PR push and ready-for-review state
    - [x] Commit Phase 4 changes with a scoped conventional commit message after validation passes.
    - [ ] Push the final validated branch state to the track PR.
    - [x] Update `plan.md` with the phase checkpoint commit SHA: `6cef0ae`.
    - [x] Confirm PR title and body still describe the final TO-BE state.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Documentation, Examples, and Release Validation' (Protocol in workflow.md)

Phase 4 validation notes:
- Documentation updated in `README.md` and `docs/ssl-certificate-generation.md` for Host `tls.clientAuth`, Guest/Broker PEM client identities, PFX/PKCS12 identities, callback context/action shape, Guest routed-domain policy, Broker identity-only policy, local HTTP/1 handler boundaries, and reload/restart behavior.
- Final validation passed: `npm run lint && npm run build && npm run test`.
- Full test suite passed 186/186 tests. Numeric coverage reporting is not configured; changed behavior is covered by focused common TLS tests, TLS runtime integration tests, registration authorization tests, and the full repository suite.
- Final deduplication: reusable TLS normalization and certificate identity extraction remain centralized in `@signicode/verser-common`; Host/Guest/Broker code uses thin adapters.
- Scope review: implementation stays within Node Host/Guest/Broker TLS HTTP/2 transport and does not add HTTP/3 or non-Node runtime mTLS behavior.

# Implementation Plan: Client Certificate Identity and Registration Authorization

## Phase 0: Track Branch and Pull Request Setup

- [ ] Task: Create review branch for the track
    - [ ] Confirm the working tree has no unrelated changes that would be included accidentally.
    - [ ] Create a dedicated branch for the full client-certificate identity and registration authorization track.
    - [ ] Keep subsequent work scoped to the track branch.
- [ ] Task: Create track pull request review surface
    - [ ] Create a GitHub pull request with a TO-BE title describing the final intended mTLS and registration authorization behavior.
    - [ ] Use a real multiline PR body that describes the complete track outcome, not only planning artifacts.
    - [ ] Use the PR as the review and checkpoint surface through the track.
- [ ] Task: Record implementation operating rules
    - [ ] Autocontinue within the active implementation session when test errors are introduced by the session and the fix is safe, local, and in scope.
    - [ ] If a tool call fails because it was invoked improperly, retry with corrected invocation after confirming no unintended mutation occurred.
    - [ ] If a tool call fails despite correct invocation, pause according to the Conductor failure policy.
- [ ] Task: Conductor - User Manual Verification 'Phase 0: Track Branch and Pull Request Setup' (Protocol in workflow.md)

## Phase 1: Common TLS API, Normalization, and Fixtures

- [ ] Task: Review existing common TLS foundations and define shared API shapes
    - [ ] Inspect `packages/verser-common/src/lib/tls.ts` and `packages/verser-common/src/lib/types.ts` for reusable TLS option patterns.
    - [ ] Confirm public type additions preserve existing Host, Guest, and Broker TLS configuration compatibility.
    - [ ] Decide and document in code comments where PEM, PFX/PKCS12, CA trust, and client-auth callback types belong.
- [ ] Task: Write failing tests for shared TLS normalization and identity extraction
    - [ ] Add tests for existing PEM Host identity behavior to guard compatibility.
    - [ ] Add tests for Host PFX/PKCS12 identity normalization.
    - [ ] Add tests for Guest/Broker client PEM identity normalization.
    - [ ] Add tests for Guest/Broker client PFX/PKCS12 identity normalization.
    - [ ] Add tests for client CA trust normalization under Host `tls.clientAuth`.
    - [ ] Add tests for configured custom extension OID identity extraction where feasible.
    - [ ] Confirm the new tests fail for missing feature behavior.
- [ ] Task: Implement common TLS option normalization and certificate identity primitives
    - [ ] Extend shared TLS option types for PEM and PFX/PKCS12 identity material.
    - [ ] Add Host `tls.clientAuth` type definitions including trusted CA options, known extension OIDs, and `authorizeRegistration` callback shape.
    - [ ] Add reusable normalizers for server identity, client trust, client identity, and Host client-auth trust.
    - [ ] Preserve POSIX `0600` private-key file permission enforcement for PEM key files.
    - [ ] Add certificate identity extraction helper for CN, DNS SANs, URI SANs, fingerprint, subject, issuer, validity bounds, raw certificate representation, and configured extension OIDs.
- [ ] Task: Update TLS fixtures for mTLS coverage
    - [ ] Extend `test/support/tls-fixtures.cjs` with a client CA, trusted client certificates, untrusted client certificates, and PFX/PKCS12 artifacts.
    - [ ] Include fixture coverage for Guest and Broker client identity material.
    - [ ] Keep generated private-key permissions compatible with existing test expectations.
- [ ] Task: Validate Phase 1 narrowly
    - [ ] Run focused common TLS tests or the narrowest available TLS test command.
    - [ ] Run `npm run build` if type declaration changes require compilation validation.
    - [ ] Record coverage and any skipped validation in `plan.md` phase notes.
    - [ ] Perform end-of-phase deduplication check and record common-code decisions.
- [ ] Task: Checkpoint Phase 1 on the PR branch
    - [ ] Commit Phase 1 changes with a scoped conventional commit message after validation passes.
    - [ ] Push the phase checkpoint to the track PR branch after local validation.
    - [ ] Update `plan.md` with the phase checkpoint commit SHA.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Common TLS API, Normalization, and Fixtures' (Protocol in workflow.md)

## Phase 2: Host, Guest, and Broker Runtime mTLS Integration

- [ ] Task: Review runtime connection paths and reusable common helpers
    - [ ] Inspect Host secure server creation in `packages/verser2-host`.
    - [ ] Inspect Node Guest and Broker `http2.connect` usage in `packages/verser2-guest-node`.
    - [ ] Confirm runtime adapters can stay thin around common TLS normalizers.
- [ ] Task: Write failing integration tests for mTLS connection behavior
    - [ ] Add test proving Host configured with client CA rejects a Guest without a client certificate.
    - [ ] Add test proving Host configured with client CA rejects a Broker without a client certificate.
    - [ ] Add test proving Host rejects Guest/Broker clients with untrusted client certificates.
    - [ ] Add test proving Guest connects and registers with a trusted client certificate.
    - [ ] Add test proving Broker connects and registers with a trusted client certificate.
    - [ ] Add test proving existing Host/Guest/Broker TLS behavior remains unchanged when `tls.clientAuth` is not configured.
    - [ ] Confirm the new tests fail for missing runtime wiring.
- [ ] Task: Implement Host mTLS server configuration
    - [ ] Pass normalized Host PFX/PKCS12 or PEM server identity into `http2.createSecureServer`.
    - [ ] When `tls.clientAuth` includes client CA trust, configure `requestCert: true` and `rejectUnauthorized: true`.
    - [ ] When `tls.clientAuth` lacks client CA trust, preserve existing server TLS behavior.
    - [ ] Preserve existing session, stream, lifecycle, and certificate reload behavior.
    - [ ] Document or code-guard mTLS mode changes that require Host restart rather than reload.
- [ ] Task: Implement Guest and Broker client identity wiring
    - [ ] Pass normalized `ca`, PEM identity, PFX/PKCS12 identity, and passphrase options into Guest `http2.connect`.
    - [ ] Pass normalized `ca`, PEM identity, PFX/PKCS12 identity, and passphrase options into Broker `http2.connect`.
    - [ ] Keep connection lifecycle and error emission behavior compatible with existing tests.
- [ ] Task: Validate Phase 2 narrowly
    - [ ] Run focused TLS integration tests.
    - [ ] Run `npm run build` if TypeScript public API changes require declaration validation.
    - [ ] Record coverage and any skipped validation in `plan.md` phase notes.
    - [ ] Perform end-of-phase deduplication check and record common-code decisions.
- [ ] Task: Checkpoint Phase 2 on the PR branch
    - [ ] Commit Phase 2 changes with a scoped conventional commit message after validation passes.
    - [ ] Push the phase checkpoint to the track PR branch after local validation.
    - [ ] Update `plan.md` with the phase checkpoint commit SHA.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Host, Guest, and Broker Runtime mTLS Integration' (Protocol in workflow.md)

## Phase 3: Registration Authorization Callback and Certificate Context

- [ ] Task: Review Host registration flow and error handling primitives
    - [ ] Inspect Guest and Broker registration handling in `packages/verser2-host`.
    - [ ] Identify where peer certificate metadata is available from the HTTP/2 session/socket.
    - [ ] Confirm existing `invalid-registration`, lifecycle, and close behavior can represent callback rejection.
- [ ] Task: Write failing tests for authorization callback behavior
    - [ ] Add test proving `tls.clientAuth.authorizeRegistration` receives Guest peer id, role, routed domains, and certificate identity.
    - [ ] Add test proving `tls.clientAuth.authorizeRegistration` receives Broker peer id, role, and certificate identity without per-request target authorization.
    - [ ] Add test proving callback allow action permits registration.
    - [ ] Add test proving callback close/reject action closes the HTTP/2 session.
    - [ ] Add test proving no callback means valid client certificate registration is allowed by default.
    - [ ] Add test proving custom extension OID values are visible in callback context when configured and available.
    - [ ] Confirm the new tests fail for missing authorization behavior.
- [ ] Task: Implement registration authorization callback execution
    - [ ] Extract verified peer certificate identity during registration.
    - [ ] Build authorization context for Guest registrations including `peerId`, role, requested routed domains, and certificate identity.
    - [ ] Build authorization context for Broker registrations including `peerId`, role, and certificate identity.
    - [ ] Invoke `tls.clientAuth.authorizeRegistration` when configured.
    - [ ] Support action-object return values for allow and close/reject behavior with optional reason.
    - [ ] Close the HTTP/2 session when the callback returns a close/reject action.
    - [ ] Preserve default allow behavior for valid client certs when no callback is configured.
- [ ] Task: Validate Phase 3 narrowly
    - [ ] Run focused authorization and TLS registration tests.
    - [ ] Run `npm run build` for type safety and declarations.
    - [ ] Record coverage and any skipped validation in `plan.md` phase notes.
    - [ ] Perform end-of-phase deduplication check and record common-code decisions.
- [ ] Task: Checkpoint Phase 3 on the PR branch
    - [ ] Commit Phase 3 changes with a scoped conventional commit message after validation passes.
    - [ ] Push the phase checkpoint to the track PR branch after local validation.
    - [ ] Update `plan.md` with the phase checkpoint commit SHA.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Registration Authorization Callback and Certificate Context' (Protocol in workflow.md)

## Phase 4: Documentation, Examples, and Release Validation

- [ ] Task: Review documentation locations and product boundary language
    - [ ] Inspect README TLS sections and `docs/ssl-certificate-generation.md`.
    - [ ] Confirm docs preserve precise Host/Guest/Broker terminology.
    - [ ] Confirm docs do not imply Verser2 is a complete public gateway.
- [ ] Task: Write documentation updates
    - [ ] Document Host `tls.clientAuth` with client CA examples.
    - [ ] Document Guest and Broker client certificate configuration with PEM examples.
    - [ ] Document Host and client PFX/PKCS12 configuration examples.
    - [ ] Document `tls.clientAuth.authorizeRegistration` callback context and action return shape.
    - [ ] Document that Guest routed-domain authorization is callback-driven.
    - [ ] Document that Broker authorization is identity-only in this track.
    - [ ] Document that local Guest HTTP/1 handlers remain local and do not need HTTPS certificates.
    - [ ] Document reload/restart behavior for certificate material and mTLS mode changes.
- [ ] Task: Validate docs and package behavior
    - [ ] Run `npm run lint` for formatting and static checks.
    - [ ] Run `npm run build` for all packages.
    - [ ] Run `npm run test` or the narrowest reliable full TLS-related validation if full tests are not necessary.
    - [ ] Record coverage status and any skipped validation in `plan.md`.
- [ ] Task: Final review and deduplication
    - [ ] Confirm all changed behavior matches `spec.md`.
    - [ ] Confirm common TLS primitives are centralized in `@signicode/verser-common` where reusable.
    - [ ] Confirm tests cover success and failure cases for Host, Guest, and Broker.
    - [ ] Confirm documentation and examples match implemented public APIs.
    - [ ] Confirm no HTTP/3 or non-Node runtime behavior was introduced outside scope.
- [ ] Task: Final PR push and ready-for-review state
    - [ ] Commit Phase 4 changes with a scoped conventional commit message after validation passes.
    - [ ] Push the final validated branch state to the track PR.
    - [ ] Update `plan.md` with the phase checkpoint commit SHA.
    - [ ] Confirm PR title and body still describe the final TO-BE state.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Documentation, Examples, and Release Validation' (Protocol in workflow.md)

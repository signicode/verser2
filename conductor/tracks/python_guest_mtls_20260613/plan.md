# Implementation Plan: Python Guest mTLS client identity

## Phase 1: Shared TLS helper and Python Guest parity

- [x] Task: Create a dedicated implementation branch.
    - Branch: `python-guest-mtls-shared-helper`.
- [x] Task: Add shared private Python TLS helper.
    - Added `_tls.py` for CA trust, ALPN `h2`, PEM identity, PFX/PKCS12 conversion, and ALPN validation.
    - Reused the helper from both `VerserGuest` and `VerserBroker`.
- [x] Task: Implement Python Guest mTLS client identity.
    - Added `tls_cert_file`, `tls_key_file`, `tls_key_password`, `tls_pfx_file`, and `tls_pfx_password` Guest options.
    - Wrapped Guest TLS handshake failures with actionable context.
- [x] Task: Add focused test coverage.
    - Added Python Guest unit coverage for CA trust, PEM identity, PFX identity, ALPN failure, and TLS handshake failure.
    - Added Node/Python integration coverage for trusted PEM/PFX Python Guest identity and untrusted identity rejection.
- [x] Task: Update documentation and roadmap references.
    - Updated Python package README, certificate docs, exposing docs, gateway example docs, codemaps, and roadmap.
- [x] Task: Validate narrowly.
    - [x] Run focused Python package tests. Command: `npm test --workspace=@signicode/verser2-guest-python` passed with 55 tests.
    - [x] Run focused Python Guest mTLS integration test. Command: `node --test test/python-guest-mtls-integration.test.js` passed with 3 tests.
    - [x] Run docs assertions. Command: `node --test test/python-guest-documentation.test.js` passed with 4 tests.
    - [x] Run lint. Command: `npm run lint` passed.

Phase notes:

- Common/reuse scan: Python TLS setup is runtime-specific, so the shared helper is private to `verser2_guest_python` rather than `@signicode/verser-common`.
- Deduplication result: Broker PFX/SSLContext setup was moved behind the shared private helper; Broker's compatibility method remains as a thin delegate for existing tests/internal callers.
- Coverage: focused unit and integration tests cover Guest CA trust, PEM identity, PFX identity, ALPN failure, TLS handshake failure, trusted mTLS registration, and untrusted client rejection. The Python package runner does not emit exact percentage coverage.

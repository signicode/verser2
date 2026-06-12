# Specification: Client Certificate Identity and Registration Authorization

## Overview

Introduce client-side certificate support for the Verser2 remote TLS HTTP/2 transport. The feature adds optional mutual TLS behavior when the Host is configured with a trusted client CA, allows Guest and Broker clients to present PEM or PFX/PKCS12 client identities, extracts structured certificate identity metadata, and exposes an extensible Host-side registration authorization callback under `tls.clientAuth`.

This track keeps existing deployments compatible: when the Host is not configured with client certificate trust, client certificates are not requested or enforced and existing Guest/Broker registration behavior remains unchanged.

## Goals

- Support client certificate authentication for Node Guest and Broker connections to the Host.
- Support PEM and PFX/PKCS12 certificate material for both Host server identity and Guest/Broker client identity.
- Require verified client certificates when the Host configures a client CA.
- Ignore client certificates when the Host does not configure client CA trust.
- Extract structured client certificate identity metadata for authorization and future scope work.
- Add a Host registration authorization callback under `tls.clientAuth`.
- Allow Guest routed domain authorization through callback context.
- Allow Broker identity authorization initially, without implementing request-target authorization in this track.
- Preserve existing HTTP method, path, header, body, status, response, streaming, lifecycle, and routing behavior unless registration is rejected by certificate policy.

## Functional Requirements

### Host TLS Configuration

- Extend Host TLS options to support PFX/PKCS12 server identity in addition to existing PEM `cert`/`key` and `certFile`/`keyFile` options.
- Add `tls.clientAuth` Host configuration for client certificate trust and registration authorization.
- `tls.clientAuth` MUST support trusted client CA material via inline and file-based configuration.
- If `tls.clientAuth` includes a trusted client CA, the Host MUST request and require a valid client certificate during TLS handshake.
- If `tls.clientAuth` does not include a trusted client CA, the Host MUST preserve current behavior and ignore any client certificate behavior.
- Existing `reloadTlsCertificate()` behavior MUST remain compatible. The implementation and documentation MUST distinguish reloadable certificate material from mTLS mode changes that require Host restart if applicable.

### Guest and Broker TLS Configuration

- Extend Node Guest and Broker TLS options to support presenting client identity using:
  - inline PEM `cert`/`key`,
  - file-based PEM `certFile`/`keyFile`,
  - inline or file-based PFX/PKCS12 material,
  - passphrase where supported by Node TLS.
- Preserve existing Host trust configuration through `ca` and `caFile`.
- Continue enforcing private-key file permission safety for PEM key files on supported platforms.
- Ensure Guest and Broker connection setup passes normalized TLS identity options to `http2.connect`.

### Certificate Identity Extraction

- On Host registration, derive a structured certificate identity object from the verified peer certificate when one is available.
- The identity object MUST include at least:
  - common name / CN when present,
  - DNS SAN entries,
  - URI SAN entries,
  - SHA-256 fingerprint,
  - subject summary,
  - issuer summary,
  - validity bounds,
  - raw certificate material or a safe representation suitable for advanced policy code,
  - configured custom extension OID values.
- CN identifies the connecting node/client identity.
- DNS SANs, URI SANs, CN fallback, and configured custom extensions are all valid inputs for future scope policy.
- Custom extension support in this track is limited to exposing configured known OIDs; defining a first-party Verser extension format is out of scope.

### Registration Authorization Callback

- Add `tls.clientAuth.authorizeRegistration` to Host options.
- The callback MUST receive registration context including:
  - peer id,
  - role (`guest` or `broker`),
  - requested routed domains for Guests when present,
  - certificate identity metadata when a verified certificate is present,
  - enough registration metadata for future scope authorization.
- The callback MUST support an action-object return value, such as allowing or closing the session with an optional reason.
- If the callback rejects/closes a cert-backed registration, the Host MUST close the associated HTTP/2 session.
- If a valid client certificate is verified and no callback is configured, registration MUST be allowed by default.
- Guest routed domain authorization is delegated to the callback.
- Broker authorization in this track is identity-only at registration time; per-request Broker authorization is out of scope.

### Errors and Lifecycle

- Registration rejection due to certificate authorization MUST produce actionable error/lifecycle information where possible.
- TLS handshake failures caused by missing or untrusted client certificates may occur before registration and should be documented as transport failures.
- Error behavior should use existing Verser error primitives where practical and preserve protocol compatibility for non-mTLS deployments.

### Tests

- Add focused tests for common TLS option normalization, including PEM and PFX/PKCS12 combinations.
- Add integration tests proving Host rejects Guest/Broker clients without a cert when client CA trust is configured.
- Add integration tests proving Host rejects untrusted client certs.
- Add integration tests proving Guest and Broker can connect with trusted client certificates.
- Add tests for `tls.clientAuth.authorizeRegistration` allow and close/reject paths.
- Add tests proving Guest routed domains are visible to the callback.
- Add tests proving Broker callback context includes identity but does not implement request-target authorization.
- Add tests for configured custom extension OID exposure where feasible.
- Preserve or update existing TLS tests to prove backward compatibility when client auth is not configured.

### Documentation

- Update README TLS documentation with mTLS client certificate examples.
- Update `docs/ssl-certificate-generation.md` with client CA, client cert, and PFX/PKCS12 examples.
- Clearly document that local Guest HTTP/1 handlers still do not need HTTPS certificates and do not call `listen()`.
- Clearly document that mTLS authenticates the transport and supports registration policy, but Verser2 remains not a complete public gateway.
- Document the difference between Guest routed-domain callback authorization and Broker identity-only authorization in this track.

## Non-Functional Requirements

- Preserve existing public behavior unless users opt into `tls.clientAuth` with client CA trust.
- Keep shared TLS types, normalization helpers, and certificate identity extraction in `@signicode/verser-common` when reusable.
- Keep package-specific code as thin adapters around common TLS primitives.
- Maintain strict TypeScript type safety and package declaration output.
- Maintain at least 95% meaningful coverage for changed behavior.
- Avoid introducing HTTP/3, browser, Bun, Rust, Go, or Java guest implementations in this track.

## Acceptance Criteria

- Existing Host/Guest/Broker TLS tests continue to pass without requiring client certificates.
- A Host configured with `tls.clientAuth` and a client CA rejects Guest and Broker connections without valid client certificates.
- A Node Guest and Broker can successfully connect and register using trusted client certificate material.
- PEM and PFX/PKCS12 configuration paths are supported according to the public types and tests.
- `tls.clientAuth.authorizeRegistration` receives structured certificate identity metadata and can allow or close a registration.
- Rejected registration through the callback closes the HTTP/2 session.
- Guest requested routed domains are available to the callback.
- Broker callback context is identity-only for this track.
- Documentation describes setup, security boundaries, and compatibility behavior.
- Narrow validation commands for changed packages pass.

## Out of Scope

- First-party Verser certificate extension format design.
- Broker per-request authorization or target-domain enforcement.
- Complete public gateway authentication/authorization policy.
- Non-Node runtime mTLS implementation unless required to keep tests/docs consistent.
- HTTP/3 or alternative transport support.
- General certificate lifecycle automation beyond documented reload/restart behavior.

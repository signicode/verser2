# Unauthorized Client Handler Outcomes

## Decisions & Rationale

- Added `tls.clientAuth.unauthorizedClientHandler` as the sole opt-in for a bounded response to clients without a valid certificate; strict mTLS remains the default.
- Unauthorized sessions are isolated before Verser routing, may consume one stream only, silently close reserved protocol paths, and never become peers or emit lifecycle events.
- Shared types, TLS normalization, constants, and header validation live in `@signicode/verser-common`; HTTP/2 session handling remains Host-specific in `unauthorized-client.ts`.

## Outcomes & Results

- Implemented bounded request/response handling, deadlines, GOAWAY, session closure, and deterministic certificate-presence classification.
- Added Host TLS coverage for missing, untrusted, and trusted certificates; limits, timeouts, malformed handler output, reserved paths, stream refusal, and lifecycle isolation.
- Documented the API, TLS boundary, limits, errors, and reconnect behavior.

## Verification Summary

- `npm test` and `npm run lint` passed.
- Focused TLS configuration tests passed (42/42).
- Final Reviewer and Oracle assessments accepted the implementation for production.

## Constraints

- The callback is one-shot and declarative; it does not expose raw HTTP/2 objects or promote a session to normal protocol access.
- The handler is HTTP/2-only and cannot respond to failures that occur before an HTTP/2 request exists.

## Risks & Open Items

- Non-blocking hardening opportunities: direct tests for throwing handlers, invalid status/body results, and Host shutdown with an idle or blocked unauthorized session.

## Follow-ups

- Add the deferred hardening cases only if they become useful regression coverage.

## PR / Base Branch

- PR: [#60](https://github.com/signicode/verser2/pull/60)
- Base branch: `main`

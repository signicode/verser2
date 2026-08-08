# Unauthorized Client Handler

## Overview

Add an opt-in Host callback for the first HTTP/2 request on a TLS session whose client certificate is absent or not valid for configured client trust. The callback supports an application-defined external protocol on the Host port while preventing that session from accessing the Verser protocol.

## Functional Requirements

- Preserve current strict mTLS behavior by default. When no unauthorized-client handler is configured, client authentication remains requested and TLS rejects clients without a valid certificate.
- Add `tls.clientAuth.unauthorizedClientHandler` as the sole opt-in for this behavior. Do not expose a public `rejectUnauthorized: false` switch for it.
- Require configured client trust material (`ca` or `caFile`) when the handler is enabled.
- When the handler is enabled, configure TLS internally to request a client certificate while allowing the TLS session to complete so an HTTP/2 response can be produced.
- Treat a session as authorized only when Node TLS reports authorization and a real peer certificate is present. Do not rely on TLS authorization status alone.
- Keep normal Host routing exclusive to authorized sessions. Unauthenticated sessions must not reach registration, Guest control or lease paths, Broker request or WebSocket paths, federation paths, registration authorization callbacks, or federation authorization callbacks.
- Claim the first stream on every unauthorized session synchronously. If its path is reserved for Verser or federation protocol, silently refuse it and close the session without invoking the unauthorized-client handler.
- For a non-reserved first request on an unauthorized session, invoke the handler exactly once. Do not serve any concurrent or subsequent streams on that session.
- Expose a bounded, buffered request context rather than raw Node HTTP/2 stream or session objects. It includes the method, path, ordinary request headers with pseudo-headers removed, a byte-preserving `Buffer` body, and an `AbortSignal`.
- Let the handler return a declarative response with status code, optional headers, and optional `string` or `Buffer` body. An absent result closes the session without a response. Do not provide an allow/continue outcome.
- Validate handler-produced status codes and headers, control HTTP/2 pseudo-headers and content length in the Host, and bound response bodies before writing them.
- Provide documented safe defaults and optional configuration for request body size, response body size, and request/handler timeout.
- Start the one-shot deadline when first-stream headers arrive. Return a generic bounded HTTP error where possible for oversize requests, request timeout, handler timeout, callback exceptions, and invalid handler results; then close the session.
- After claiming the first eligible stream, send GOAWAY, refuse concurrent or later streams without parsing or responding to them, write the selected response, then close the session with a hard-close fallback.
- Track unauthorized sessions only as needed for Host shutdown. They must not become registered peers or produce Host lifecycle events.

## Compatibility and Documentation

- Document that handler mode is optionally client-authenticated TLS with strict Host protocol gating, not transport-level strict mTLS.
- Document that malformed TLS, certificate-handshake failures that prevent HTTP/2, ALPN failures, and sessions that send no request cannot receive a callback response.
- Document the callback contract, limits, one-request session lifetime, reserved-path behavior, error behavior, and reconnect requirement for a client that later presents a valid certificate.
- Keep established strict-mTLS tests and public documentation accurate.

## Acceptance Criteria

- Existing configurations retain strict TLS-handshake rejection unless the new handler is configured.
- Enabling the handler without client trust material fails Host configuration validation.
- A missing or untrusted client certificate can receive exactly one handler-produced HTTP/2 response for a non-reserved first request.
- A valid client certificate continues through existing Host behavior unchanged.
- A reserved first request from an unauthorized session is silently refused, closes that session, and never reaches the callback or normal protocol handlers.
- Concurrent and subsequent streams on an unauthorized session are refused; the callback is never invoked more than once.
- Oversized, incomplete, timed-out, invalid, and throwing callback cases have bounded, documented failure behavior and close the session.
- Tests cover TLS authorization classification, including resumed-session certificate absence, request and response limits, timeouts, shutdown, and lifecycle isolation.
- Public types and Host TLS documentation describe the feature without calling it enrollment.

## Out of Scope

- A configurable path or route table for unauthorized clients.
- Raw HTTP/2 stream or session access in the callback.
- Any callback result that authorizes, registers, or otherwise promotes the current session to Verser protocol access.
- Application protocol validation, rate limiting, certificate issuance, CSR processing, or other policy inside the callback.
- HTTP/1 compatibility, HTTP/3 behavior, generic upgrades, or changes to Guest, Broker, or federation protocol semantics.

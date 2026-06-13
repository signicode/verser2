# Specification: Python Broker support in verser2

## Overview

Add a Python-native async Broker to `@signicode/verser2-guest-python` so Python applications can initiate routed HTTP requests over an existing Verser2 Host. The Broker must use the existing Verser2 Host/Broker protocol path, preserve core HTTP semantics, and provide familiar async Python request/response ergonomics without introducing a Python Host or a public-gateway authorization layer.

Target API usage example:

```python
from verser2_guest_python import create_verser_broker

async with create_verser_broker(
    host_url="https://localhost:8443",
    broker_id="python-broker-a",
    tls_ca_file="/etc/verser/host-ca.crt",
    tls_cert_file="/etc/verser/python-broker-a.crt",
    tls_key_file="/etc/verser/python-broker-a.key",
) as broker:
    response = await broker.get("http://guest-a.local.test/health")
    print(response.status)
    print(await response.text())
```

## Goals

- Export `create_verser_broker` from `@signicode/verser2-guest-python`.
- Add a Python `VerserBroker` runtime object with async context-manager and explicit lifecycle support.
- Let Python applications make URL-oriented routed requests through a Verser2 Host to Host-advertised Guest routes.
- Preserve request method, path, query, headers, and binary body bytes.
- Preserve response status, headers, request id, and binary body bytes.
- Support request and response streaming without mandatory full buffering.
- Maintain protocol compatibility with the current Host, Node Guest, Node Broker, Bun Guest/Broker public APIs where present, and Python Guest implementations.
- Support TLS trust, PEM mTLS client identity, and PFX/PKCS12 mTLS client identity.
- Document Python Broker usage, streaming behavior, mTLS configuration, and current limits.

## Functional Requirements

### Python Broker API

- `verser2_guest_python` must export `create_verser_broker`.
- `create_verser_broker(...)` must create a `VerserBroker` object.
- `VerserBroker` must support async context-manager lifecycle:
  - `async with create_verser_broker(...) as broker:` connects on entry and closes on exit.
- `VerserBroker` must support explicit lifecycle:
  - `await broker.connect()`
  - `await broker.close()`
- `VerserBroker` must expose route inspection:
  - `broker.get_routes()`
  - `await broker.wait_for_route(domain)`
- `VerserBroker` must expose URL-oriented request helpers:
  - `await broker.request(method, url, ...)`
  - `await broker.get(url, ...)`
  - `await broker.post(url, ...)`
  - `await broker.put(url, ...)`
  - `await broker.patch(url, ...)`
  - `await broker.delete(url, ...)`
- URL routing must resolve only against Host-advertised Verser routes.
- Python Broker route state must come only from Host route advertisements.
- `wait_for_route(domain)` must resolve for already-known routes and for future advertisements.
- Route retractions from the Host must be reflected by `get_routes()`.

### Request Behavior

- Python Broker must send routed requests through the existing Host Broker protocol.
- Python Broker must not perform direct DNS lookup or direct HTTP(S) requests to the target hostname.
- Public request APIs should feel like a native async Python HTTP client while avoiding claims of full `requests`, `httpx`, or `aiohttp` compatibility.
- Requests must preserve:
  - method
  - URL path
  - query string
  - headers
  - request body bytes
  - binary data without UTF-8 coercion
- Request bodies must support bytes-like bodies.
- Request bodies must support async streaming bodies that yield binary chunks.
- Request APIs should also support practical HTTP-client-like convenience inputs where feasible, such as text or JSON payloads, without expanding the scope into a full client compatibility layer.
- Streaming request chunks must be forwarded through the Verser2 protocol without mandatory full buffering.

### Response Behavior

- Add a Python response object exposing:
  - `response.status`
  - `response.headers`
  - `response.request_id`
  - `await response.read()`
  - `await response.text()`
  - `await response.json()`
  - `response.aiter_bytes()`
- Response bodies must support async streaming.
- Consumers must be able to iterate response bytes asynchronously without mandatory full buffering.
- Binary response chunks must be preserved without UTF-8 coercion.
- Response consumption must be single-use and explicit:
  - calling `read()`, `text()`, or `json()` consumes the body for full-body access;
  - using `aiter_bytes()` consumes the body as a stream;
  - mixing streaming access after full-body access, or full-body access after streaming access, must fail with an actionable Python exception.

### Broker Registration and Route Control

- Python Broker must connect outbound to the existing Host over TLS HTTP/2.
- Python Broker must register as role `broker`.
- Python Broker must consume Host route advertisements.
- Python Broker must maintain route state compatible with Node Broker behavior.
- Host route advertisement and retraction behavior must remain the source of truth for Python Broker route state.

### TLS and mTLS

- Python Broker must support Host CA trust.
- Python Broker must support PEM client identity:
  - `tls_cert_file`
  - `tls_key_file`
  - `tls_key_password`
- Python Broker must support PFX/PKCS12 client identity with passphrase support.
- Python Broker must negotiate HTTP/2 via ALPN.
- Python Broker must work with Hosts configured with `tls.clientAuth`.
- mTLS must remain transport/registration identity only.
- Broker per-request authorization is not part of this track.

### Error Behavior

- Protocol, lifecycle, TLS, and routing failures must raise Python exceptions with actionable context.
- Errors must preserve, where available:
  - request id
  - target route/domain
  - status
  - Verser error code
  - message
  - protocol context
- Covered error cases must include:
  - disconnected Broker
  - missing route
  - missing Guest
  - local handler failure
  - lease timeout
  - invalid registration
  - TLS handshake failure
  - malformed protocol response
  - invalid response-body consumption order

### Bun mTLS Parity Coverage

- Add direct Bun mTLS runtime coverage as part of this track.
- The test must prove a Bun Guest and Bun Broker can connect through a Host configured with `tls.clientAuth` using trusted client identity.
- The test must cover the Bun package public API, not only an underlying Node package API.

### Documentation

- Update root `README.md`.
- Update `packages/verser2-guest-python/README.md`.
- Update `conductor/product.md`.
- Update `conductor/tech-stack.md`.
- Document:
  - Python Broker usage;
  - route discovery and waiting;
  - request helpers;
  - request streaming;
  - response streaming and single-use body consumption;
  - PEM mTLS usage;
  - PFX/PKCS12 mTLS usage;
  - actionable error behavior;
  - remaining limits.
- Documentation must continue to state that Verser2 is not a complete public gateway.
- Documentation must continue to state that Python Host is not implemented.

## Non-Functional Requirements

- Preserve protocol compatibility with existing Host, Node Guest, Node Broker, Bun Guest/Broker public APIs where present, and Python Guest behavior.
- Preserve normal HTTP method, path, query, header, body, status, and response-body semantics.
- Keep reusable protocol-neutral logic in shared/common code where appropriate instead of duplicating behavior.
- Keep Python APIs idiomatic for async applications.
- Maintain at least 95% meaningful test coverage for changed behavior per Conductor workflow.
- Use the narrowest reliable validation commands during implementation.

## Acceptance Criteria

- `@signicode/verser2-guest-python` exports `create_verser_broker`.
- Python Broker can connect to an existing Verser2 Host.
- Python Broker does not use direct DNS queries for routed target hostnames.
- Python Broker does not use direct HTTP(S) calls to routed target hostnames.
- Python Broker registers as role `broker`.
- Python Broker receives Host route advertisements.
- `broker.get_routes()` reflects Host-advertised routes and route retractions.
- `broker.wait_for_route(domain)` works for existing and future routes.
- Python Broker can make URL-based routed requests to a Node Guest.
- Python Broker can make URL-based routed requests to a Python Guest.
- Request method, path, query, headers, and body are preserved.
- Bytes-like, async streaming, and practical HTTP-client-like body inputs are supported as scoped above.
- Response status, headers, request id, and body are preserved.
- Request and response streaming are supported.
- Mixing response full-body helpers with streaming iteration fails with an actionable exception.
- Binary bodies are preserved without UTF-8 coercion.
- Python Broker maps protocol errors to actionable Python exceptions.
- Python Broker works with Host `tls.clientAuth` using trusted PEM client identity.
- Python Broker works with Host `tls.clientAuth` using trusted PFX/PKCS12 client identity.
- Host `tls.clientAuth` rejects Python Broker without required client identity.
- Host `tls.clientAuth` rejects Python Broker with untrusted client identity.
- Host `authorizeRegistration` receives Python Broker peer id, role `broker`, and certificate identity.
- Direct Bun mTLS runtime test coverage exists for Bun Guest and Bun Broker public APIs.
- Documentation accurately describes Python Broker capabilities and remaining limits.

## Out of Scope

- Python Host.
- Broker per-request authorization.
- Public gateway authentication/authorization policy.
- HTTP/3.
- WebSockets.
- CONNECT.
- HTTP upgrades.
- Trailers.
- Full `requests` compatibility.
- Full `httpx` compatibility.
- Full `aiohttp` compatibility.
- Retry, cookie, redirect, or middleware systems.
- Replacing the existing Host/Guest/Broker protocol.

# packages/verser2-guest-python/src/verser2_guest_python/

## Responsibility

Implements the Python ASGI Guest and async Broker for the Verser2 TLS HTTP/2
protocol.

## Design

- `guest.py`: outbound Guest peer, registration, lease stream pool, direct ASGI
  dispatch helper, TLS/mTLS client identity, and ASGI response/error envelope
  generation.
- `broker.py`: outbound Broker peer, route control stream consumption, URL
  hostname route matching, request helpers, TLS/mTLS client identity, and
  one-shot response body readers.
- `asgi.py`: ASGI 3 scope construction and buffered direct-dispatch machinery.
- `protocol.py`: binary envelope constants, encode/decode helpers, and header
  normalization shared by Guest and Broker.
- `_tls.py`: private shared SSLContext helper for Host CA trust, ALPN `h2`, PEM
  client certificates, PFX/PKCS12 conversion, and ALPN validation.
- `__init__.py`: public API barrel for factories, classes, and package constant.

## Flow

1. Guest: `create_verser_guest()` → `VerserGuest.connect()` opens TLS with ALPN
   `h2`, registers as `guest`, opens control/lease streams, then dispatches each
   leased request to `app(scope, receive, send)`.
2. Broker: `create_verser_broker()` → `VerserBroker.connect()` registers as
   `broker`, consumes route frames, routes request URLs by exact hostname, sends
   request streams, and exposes `VerserBrokerResponse` body helpers.
3. Protocol helpers encode/decode routed request/response/error envelopes so
   Python peers interoperate with the TypeScript Host.

## Integration

- Depends on `h2`, `asyncio`, `ssl`, and `cryptography` for PFX loading.
- Interoperates with `@signicode/verser2-host` over the same protocol paths as
  Node/Bun peers.
- Covered by Python package tests and Node/Python integration tests.

# @signicode/verser2-guest-python

Python package for verser2 providing Guest and Broker implementations.

This package connects outbound to an existing verser2 Host over TLS HTTP/2.
It is recognized by the repository's npm workspace tooling through
`package.json` and by Python packaging tooling through `pyproject.toml`.

## Public API

- `VERSER2_GUEST_PYTHON_PACKAGE_NAME`
- `VerserGuest` / `create_verser_guest` — Python ASGI Guest
- `VerserBroker` / `create_verser_broker` — Python Broker
- `VerserBrokerResponse` — Broker response type
- `VwsAsgiConnection` and `build_websocket_scope` — ASGI VWS/1 websocket
  helper types used by the live Python Guest path
- `dispatch_asgi_websocket` — test helper for exercising a synthetic ASGI
  websocket lifecycle; applications should use `VerserGuest` instead
- `guest.revoke_routes(domains)` — revoke advertised route domains via
  `POST /verser/guest/revoke`; returns `dict` with `"status"` (`"ack"`, `"partial"`, or `"error"`)
- `broker.on_route_change(listener)` — register a listener for route lifecycle
  events (`"added"`, `"removed"`, `"changed"`, `"degraded"`) with payload keys
  `type`, `targetId`, `domain`, `reason`, `generation`; returns unsubscribe callable

## Commands

```sh
npm run build --workspace=@signicode/verser2-guest-python
npm run test --workspace=@signicode/verser2-guest-python
npm run lint --workspace=@signicode/verser2-guest-python
```

The package commands use `uv run --project .` so Python dependencies such as
`h2` are resolved in an isolated project environment.

## Python Guest usage

The Guest serves an ASGI 3 app without opening an inbound listening port.

```py
import asyncio
from verser2_guest_python import create_verser_guest


async def app(scope, receive, send):
    assert scope["type"] == "http"
    body = b""
    while True:
        event = await receive()
        body += event.get("body", b"")
        if not event.get("more_body", False):
            break
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": body})


async def main():
    guest = create_verser_guest(
        host_url="https://localhost:8443",
        guest_id="python-guest-a",
        app=app,
        routed_domains=["python-guest-a.local.test"],
        tls_ca_file="/etc/verser/ca.crt",
        # For mTLS Hosts, present a client identity as PEM:
        # tls_cert_file="/etc/verser/client.crt",
        # tls_key_file="/etc/verser/client.key",
        # Or as PFX/PKCS12:
        # tls_pfx_file="/etc/verser/client.p12",
        # tls_pfx_password="...",
    )
    await guest.connect()
    await asyncio.Event().wait()


asyncio.run(main())
```

**Domain note:** Unlike Node and Bun Guests, the Python Guest does **not**
default the route domain to the Guest ID. You must provide `routed_domains`
explicitly.

### FastAPI-compatible apps

FastAPI and Starlette applications work because the Guest calls the standard
ASGI 3 interface. FastAPI is not a core runtime dependency.

```py
from fastapi import FastAPI
from verser2_guest_python import create_verser_guest

app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True}


guest = create_verser_guest(
    host_url="https://localhost:8443",
    guest_id="fastapi-guest",
    app=app,
    routed_domains=["fastapi-guest.local.test"],
    tls_ca_file="/etc/verser/ca.crt",
)
```

## Python ASGI WebSockets

The Python Guest maps dedicated VWS/1 leases to ASGI websocket scopes:

```py
async def app(scope, receive, send):
    if scope["type"] == "websocket":
        await receive()  # websocket.connect
        await send({"type": "websocket.accept"})
        event = await receive()
        if event["type"] == "websocket.receive":
            await send({"type": "websocket.send", "text": "echo"})
        return
```

This is explicit framing over the existing TLS HTTP/2 transport, not generic
HTTP upgrade forwarding. Python Host, fetch, Agent, and Dispatcher APIs are not
implemented.

## Python Broker usage

The Python Broker connects outbound, registers as `broker`, and sends requests
to advertised Guest routes.

```py
import asyncio
from verser2_guest_python import create_verser_broker


async def main():
    broker = create_verser_broker(
        host_url="https://localhost:8443",
        broker_id="broker-a",
        tls_ca_file="/etc/verser/ca.crt",
    )
    await broker.connect()
    await broker.wait_for_route("python-guest-a.local.test")

    response = await broker.get("http://python-guest-a.local.test/health")
    print(await response.text())


asyncio.run(main())
```

The Broker supports `request`, `get`, `post`, `put`, `patch`, and `delete`
helpers. `VerserBrokerResponse` exposes `status`, `headers`, `request_id`,
`read()`, `text()`, `json()`, and `aiter_bytes(chunk_size=8192)`. Response
bodies are one-shot.

### TLS for Python Broker

```py
broker = create_verser_broker(
    host_url="https://localhost:8443",
    broker_id="broker-a",
    tls_ca_file="/etc/verser/ca.crt",
    tls_cert_file="/etc/verser/client.crt",
    tls_key_file="/etc/verser/client.key",
    # PFX/PKCS12 also supported:
    # tls_pfx_file="/etc/verser/client.p12",
    # tls_pfx_password="...",
)
```

Python Guests support the same `tls_ca_file`, PEM client identity, and
PFX/PKCS12 client identity options. PFX/PKCS12 support uses the package's
`cryptography` dependency.

## Streaming behavior

- Guest: routed request body chunks from the Host/Broker lease stream are
  delivered as ASGI `http.request` events with `more_body` continuation flags.
- Guest: ASGI `http.response.start` is converted to the Verser response
  envelope before response bytes are written.
- Guest: ASGI `http.response.body` events are written back to the Host lease
  stream; `more_body: false` ends the response side of the lease.
- Direct `dispatch_routed_request(...)` calls are batch-only — they buffer the
  ASGI response and enforce `max_response_bytes` before joining chunks. Use
  leased Host/Broker routing for streaming.
- Guest app exceptions before response start are returned as Verser
  `local-handler-failure` error envelopes with Guest, request, and path context.
- Broker response bodies are one-shot; `read()`, `text()`, and `json()` consume
  the body.

## Avoid non-terminating async streams

Verser Python transports use async read loops and async body iteration. Any
custom async stream, test double, or request-body async iterable must eventually
signal completion:

- `asyncio` stream readers should return `b""` for EOF.
- Async request-body iterables should stop iteration when the body is complete.
- Test mocks should not leave `reader.read()` as a bare `AsyncMock`, because
  each awaited call can produce another truthy mock object forever.

Use an explicit EOF:

```py
reader = AsyncMock()
reader.read = AsyncMock(return_value=b"")
```

or a finite sequence:

```py
reader.read = AsyncMock(side_effect=[b"first-frame", b""])
```

### Python Guest route revocation

A connected Python Guest can revoke one or more of its advertised routes:

```py
result = await guest.revoke_routes(["python-guest-a.local.test"])
# result == {"status": "ack"}  or  {"status": "partial", "failedDomains": [...]}
```

The request is sent to `POST /verser/guest/revoke`. The Host responds with
`"ack"` (all domains revoked), `"partial"` (some failed), or `"error"` (entire
request rejected). Raises `RuntimeError` if the Guest is not connected or
*domains* is empty.

### Python Broker route lifecycle observation

Brokers can observe route changes reactively:

```py
def on_change(event: dict):
    print(event["type"], event["domain"], event.get("reason"))

unsubscribe = broker.on_route_change(on_change)
# Later, to stop observing:
unsubscribe()
```

The internal route table (`get_routes()`) is updated before listeners fire. See
the [Lifecycle and errors docs](../../docs/lifecycle-and-errors.md) for event
types, reasons, and degraded-route behavior.

## Known limits

- The first implementation focuses on Python Guest and Broker behavior.
- Python Host, Python-side fetch helper APIs, and Python-side Agent/Dispatcher
  are not implemented.
- HTTP/3, complete application authentication, public gateway policy,
  per-request Broker target authorization, generic upgrades, CONNECT/RFC8441,
  trailers, Python Host/fetch/Agent/Dispatcher, and advanced ASGI lifespan
  behavior are not implemented.
- The HTTP transport is intentionally minimal: one outbound TLS HTTP/2 session
  with a replenished pool of one-use HTTP Guest lease streams. Long-lived VWS/1
  WebSocket leases are dedicated streams and are not one-use request leases.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Exposing HTTP](../../docs/exposing-http.md)
- [Docs: Making requests](../../docs/making-requests.md)

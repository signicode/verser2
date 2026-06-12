# @signicode/verser2-guest-python

Python ASGI Guest package for Verser2.

This package connects outbound to an existing Verser2 Host over TLS HTTP/2 and
serves an ASGI 3 app without opening an inbound listening port. It is recognized
by the repository's npm workspace tooling through `package.json` and by Python
packaging tooling through `pyproject.toml`.

## Commands

```sh
npm run build --workspace=@signicode/verser2-guest-python
npm run test --workspace=@signicode/verser2-guest-python
npm run lint --workspace=@signicode/verser2-guest-python
```

The package commands use `uv run --project .` so Python dependencies such as
`h2` are resolved in an isolated project environment.

## Basic usage

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
    )
    await guest.connect()
    await asyncio.Event().wait()


asyncio.run(main())
```

## FastAPI-compatible apps

FastAPI-compatible and Starlette-compatible applications can be passed anywhere
an ASGI 3 callable is accepted. FastAPI is not a core runtime dependency; install
it in the consuming application when needed.

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

## Streaming behavior

- Routed request body chunks from the Host/Broker lease stream are delivered as
  ASGI `http.request` events with `more_body` continuation flags.
- ASGI `http.response.start` is converted to the Verser response envelope before
  response bytes are written.
- ASGI `http.response.body` events are written back to the Host lease stream;
  `more_body: false` ends the response side of the lease.
- Direct `dispatch_routed_request(...)` calls are batch-only convenience dispatches;
  they buffer the ASGI response and enforce `max_response_bytes` before joining
  chunks. Use leased Host/Broker routing for streaming response bodies.
- In leased routing, HTTP/2 request-body flow-control credit is returned only
  after the ASGI app consumes the corresponding `http.request` event.
- App exceptions before response start are returned as Verser
  `local-handler-failure` error envelopes with Guest, request, and path context.

## Avoid non-terminating async streams

Verser Python transports use async read loops and async body iteration. Any
custom async stream, test double, or request-body async iterable must eventually
signal completion:

- `asyncio` stream readers should return `b""` for EOF.
- Async request-body iterables should stop iteration when the body is complete.
- Test mocks should not leave `reader.read()` as a bare `AsyncMock`, because each
  awaited call can produce another truthy mock object forever.

For tests, use an explicit EOF:

```py
reader = AsyncMock()
reader.read = AsyncMock(return_value=b"")
```

or a finite sequence:

```py
reader.read = AsyncMock(side_effect=[b"first-frame", b""])
```

If a stream never reaches EOF or never stops yielding chunks, the transport loop
will keep waiting for more data and can consume unbounded memory in tests or in
the application process.

## Known limits

- The first implementation focuses on Python Guest behavior only.
- Python Host, full Python Broker, and Python-side fetch helper APIs are deferred.
- HTTP/3, authentication, authorization, public gateway policy, WebSockets,
  upgrades, trailers, and advanced ASGI lifespan behavior are not implemented.
- The transport is intentionally minimal: one outbound TLS HTTP/2 session with a
  replenished pool of one-use Guest lease streams.

## Scope

- Guest behavior connects outbound to an existing Verser2 Host.
- The local application interface targets ASGI 3: `app(scope, receive, send)`.
- Python Host, full Python Broker, HTTP/3, authentication, authorization, and
  public gateway policy are out of scope for this package.

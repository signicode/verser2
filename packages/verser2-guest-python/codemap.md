# packages/verser2-guest-python/

## Responsibility

Hybrid npm/Python package (`@signicode/verser2-guest-python` / `verser2-guest-python`) providing the **Python Guest** and **Python Broker** implementations. The Guest registers as role `"guest"` with a Verser Host and dispatches routed requests to a local ASGI 3 application. The Broker registers as role `"broker"` and sends HTTP requests (GET, POST, PUT, PATCH, DELETE) to advertised Guest routes through the Host.

Key differences from Node/Bun Guests:
- Uses ASGI 3 protocol instead of Node `http.Server` / Bun `fetch` handler.
- Does **not** default the route domain to the Guest ID — `routed_domains` must be provided explicitly.
- Python Host, Python-side fetch/Agent/Dispatcher APIs are not implemented.

## Design/Patterns

- **Outbound TLS HTTP/2 peers** — Both `VerserGuest` and `VerserBroker` connect outbound to the Host via a single TLS TCP socket with ALPN `h2`. No inbound listening ports.
- **`h2` library** — Uses `python-h2` (`h2.connection.H2Connection`) for HTTP/2 framing. The Python `asyncio` stream transport feeds raw bytes into `H2Connection.receive_data()` and sends `H2Connection.data_to_send()` bytes out.
- **Verser envelope protocol** (`protocol.py`) — Lease stream messages carry a 6-byte header (`[version:1][type:1][metadata_length_be:4]`) followed by JSON metadata and optional body. Envelope types: request (1), response (2), error (3).
- **ASGI 3 adapter** (`asgi.py`) — Converts Verser request metadata into ASGI 3 scope dicts (`asgi.version="3.0"`, `asgi.spec_version="2.5"`). Drives `receive`/`send` callables. Buffered direct dispatch via `dispatch_routed_request()`; streaming dispatch via lease stream `receive`/`send` coroutines.
- **Lease stream model** (Guest) — One-use HTTP/2 streams over `/verser/guest/lease`. The Guest maintains `min_waiting_streams` lease streams; after a lease is consumed (one request dispatched), a replacement lease stream is started. Completed lease tasks are pruned automatically.
- **Route control frames** (Broker) — The Host pushes JSON route tables over the control stream. `_handle_control_frame()` replaces the Broker's route state entirely on each `"routes"` frame. `wait_for_route()` uses `asyncio.Future` to await a specific domain.
- **Broker request helpers** — `request()` maps to POST to `/verser/request` with Verser metadata in `x-verser-*` HPACK headers. Convenience methods: `get()`, `post()`, `put()`, `patch()`, `delete()`. Body forms: raw bytes/chunks, `json`, `text`.
- **TLS client identity** — Guest and Broker support PEM (`tls_cert_file`/`tls_key_file`/`tls_key_password`) and PFX/PKCS12 (`tls_pfx_file`/`tls_pfx_password`) client certificates via a shared private Python TLS helper. PFX is converted to a temporary PEM file before loading into `SSLContext.load_cert_chain()`.
- **Response body one-shot** — `VerserBrokerResponse` enforces single-use body access. `read()`, `text()`, `json()` buffer the full body; `aiter_bytes(chunk_size)` yields streaming chunks. Calling more than once raises `RuntimeError`.
- **Async context manager** — `VerserBroker` supports `async with broker:` to auto-connect and auto-close.
- **VWS/1 WebSocket leases** — Dedicated `/verser/guest/websocket-lease` streams
  map explicit framed WebSocket messages to ASGI websocket scopes. They are
  separate from HTTP envelope leases. `VerserBroker.websocket()` opens the same
  VWS/1 protocol through advertised direct or federated routes. Generic upgrades
  and Python Host/fetch/Agent/Dispatcher APIs are unsupported.
- **npm workspace bridge** — `package.json` declares `"main": "dist/index.js"` for npm workspace tooling. The `scripts/build.mjs` writes a minimal JS entrypoint that exports package name constants. Actual Python logic lives under `src/verser2_guest_python/`.

## Data & Control Flow

**Guest lifecycle:**
```
VerserGuest(**options)
  └─ .attach(app, domain?)  → sets self.app, updates self.routed_domains
  └─ await .connect()
       ├─ asyncio.open_connection(host, port, ssl=SSLContext(ALPN h2, PEM|PFX identity))
       ├─ H2Connection.initiate_connection() + flush
       ├─ _register()  → POST /verser/register {peerId, role:"guest", routedDomains}
       ├─ _open_control_stream()  → POST /verser/guest/control
       └─ _start_lease_task() × min_waiting_streams
            └─ POST /verser/guest/lease → wait for 200 → _dispatch_leased_request_stream()
                 ├─ decode envelope header → build ASGI scope
                 ├─ asyncio.create_task(run_app)
                 │    └─ app(scope, receive, send)
                 │         ├─ receive() → http.request events from lease stream DataReceived
                 │         └─ send() → http.response.start → encode_envelope("response") to stream
                 │              → http.response.body → raw bytes to stream, end_stream on last
                 └─ on completion → _start_lease_task() (replenish)
  └─ await .close() → cancel tasks, close writer
```

**Broker lifecycle:**
```
VerserBroker(**options)
  └─ await .connect()
       ├─ asyncio.open_connection(host, port, ssl=SSLContext(ALPN h2, PEM|PFX identity))
       ├─ validate ALPN == "h2"
       ├─ H2Connection.initiate_connection() + flush
       ├─ _register()  → POST /verser/register {peerId, role:"broker"}
       │    └─ parse registration response JSON, extract initial routes
       └─ _consume_control_stream()  → readlines from registration stream
            └─ _handle_control_frame({"type":"routes","routes":[...]})
                 └─ replaces self._routes, resolves route waiters
  └─ await .request(method, url, ...)
       ├─ match hostname against self._routes (exact equality)
       ├─ POST /verser/request with x-verser-{request-id,source-id,target-id,method,path,headers}
       └─ _send_body() → chunks on stream, end_stream on last
       └─ _collect_response() → ResponseReceived → VerserBrokerResponse(streaming body async iterable)
  └─ await .close() → cancel tasks, fail pending streams, close writer
```

**Envelope encoding/decoding:**
```
encode_envelope(type, metadata) → [version:1][type:1][len:4][json_metadata...]
decode_envelope(buffer)         → (type_str, metadata_dict, remainder_body)
```

## Integration

- **npm workspace** — `package.json` referenced via root `"workspaces": ["packages/*"]`. `npm run build/test/lint --workspace=@signicode/verser2-guest-python` delegates to `scripts/build.mjs` / `uv run` commands.
- **npm dist bridge** — `dist/index.js` exports `VERSER2_GUEST_PYTHON_PACKAGE_NAME` and `PYTHON_DISTRIBUTION_NAME` for JS tooling (consumer tests, version policy, package staging).
- **Host connection** — Both Guest and Broker connect to the Host via TCP+TLS on the configured `host_url`. Uses Verser protocol endpoints: `/verser/register`, `/verser/guest/control`, `/verser/guest/lease`, `/verser/guest/websocket-lease`, `/verser/request`.
- **Tests** — Python `unittest` tests under `tests/` (`test_asgi_guest.py`,
  `test_broker_api.py`, `test_websocket_asgi.py`, `test_scaffold.py`) run via
  `uv run --project . python -m unittest discover -s tests`. Mock transports
  (FakeReader, FakeConn) avoid real TLS/network.
- **CI** — `.github/workflows/package-publish.yml` runs `npm run build` (which builds Python dist via `scripts/build.mjs`) and includes the Python package in staging, consumer validation, and tarball testing.
- **Documentation** — Referenced from root README, docs/exposing-http.md (Python Guest section), docs/making-requests.md (Python Broker section), and package-specific README.md.

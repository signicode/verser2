# packages/verser2-guest-node/src/lib/

## Responsibility

Contains the complete Node.js Guest and Broker implementation.  Every file
in this directory is part of the HTTP/2 transport, handler dispatch, or
Broker routing stack.

**Files:**

| File | Role |
|------|------|
| `types.ts` | All public type definitions (`VerserNodeGuestOptions`, `VerserNodeGuest`, `VerserBrokerOptions`, `VerserBroker`, `VerserBrokerRequest`, `VerserBrokerResponse`, `NodeRequestListener`, etc.) and internal interfaces (`BrokerRequestRouter`). |
| `http2-verser-node-guest.ts` | `Http2VerserNodeGuest` — Guest implementation: connect, register, maintain lease pool, dispatch requests via `MinimalIncomingMessage`/`MinimalServerResponse`. |
| `http2-verser-broker.ts` | `Http2VerserBroker` — Broker implementation: connect, register, receive route frames, forward requests, expose Agent/Dispatcher/Fetch factories. |
| `minimal-http.ts` | `MinimalIncomingMessage` (extends `PassThrough`) and `MinimalServerResponse` (extends `EventEmitter`) — lightweight HTTP/1 request/response surface for local handlers. |
| `broker-agent.ts` | `VerserBrokerAgent` (extends `http.Agent`) — resolves target hostname from route table and bridges via `VerserBrokerSocket`. |
| `broker-socket.ts` | `VerserBrokerSocket` (extends `Duplex`) — captures HTTP/1 request bytes, parses headers/body, forwards through the Broker, and pipes the response back as raw HTTP. |
| `broker-dispatcher.ts` | `VerserBrokerDispatcher` (extends `Dispatcher`) — Undici-compatible dispatcher that routes through the Broker. |
| `dispatch-controller.ts` | `VerserDispatchController` — manages abort/pause/resume state for dispatcher request/response flow. |
| `chunked-body-decoder.ts` | `ChunkedBodyDecoder` — state-machine decoder for `Transfer-Encoding: chunked` used by the Broker socket. |
| `header-utils.ts` | `parseContentLength()`, `normalizeRequestHeaders()`, `toRawHeaderList()` — HTTP header helpers. |
| `error-utils.ts` | `toVerserError()` — wraps unknown errors into `VerserError`. |
| `http2-client-utils.ts` | `requestJson()` — sends JSON payload over HTTP/2 and parses the registration response. |
| `utils.ts` | `toBrokerRequestBody()` — converts Undici body types to Broker body format; `serializeHttpResponseHead()` — serializes HTTP/1.1 status line + headers to Buffer; iterable detection helpers. |
| `constants.ts` | `VERSER2_GUEST_NODE_PACKAGE_NAME` string constant. |

## Design / Patterns

- **Session lifecycle** — Both Guest and Broker follow: `create` → `connect()`
  → `register()` → `close()`.  At most one session per instance.
- **Lease-stream pool (Guest)** — Pre-opened HTTP/2 streams in `waiting` state.
  The Host acquires a waiting lease to dispatch a request.  After handling,
  the lease is closed and a replacement is opened.  States: `opening` (stream
  opened, awaiting 200), `waiting` (ready for dispatch), `active` (dispatching).
- **Dual dispatch path (Guest)** — `dispatchLeasedRequest()` streams the
  response directly through the lease stream; `dispatchRoutedRequest()` buffers
  the full response for direct/test use.
- **Broker routing hierarchy** — `request()` is the core primitive.  `createAgent()`
  wraps it behind `http.Agent` (HTTP/1 compatibility).  `createDispatcher()` wraps
  it behind Undici `Dispatcher`.  `createFetch()` wraps `createDispatcher()` behind
  the `fetch` API.
- **Socket bridge** — `VerserBrokerSocket` (extending `Duplex`) captures raw
  HTTP/1 request bytes, parses the header/body boundary, forwards through the
  Broker, and writes the HTTP/1 response back.  Supports `Content-Length` and
  `Transfer-Encoding: chunked`.
- **Controlled backpressure** — The dispatcher and socket both support pause/resume
  of response body streams via `VerserDispatchController`.

## Data & Control Flow

### Guest: Connect → Register → Serve
```
createVerserNodeGuest(options)
  │
  └── new Http2VerserNodeGuest(options)
        │
        ├── connect()
        │     ├── http2.connect(hostUrl, tls)
        │     ├── await once(session, 'connect')
        │     ├── register()
        │     │     └── requestJson(session, { peerId, role, routedDomains })
        │     ├── openControlStream(session)
        │     └── maintainLeasePool()
        │
        ├── attach(server|listener, domain?)
        │     └── store domain + handler
        │
        └── dispatch path (two variants):
              │
              ├── dispatchRoutedRequest() ─► MinimalIncomingMessage
              │     └── MinimalServerResponse (buffered) → toDispatchResponse()
              │
              └── handleLeaseStream() ─► readLeaseRequestMetadataFromStream()
                    └── dispatchLeasedRequest()
                          ├── MinimalIncomingMessage(lease.stream as body source)
                          ├── MinimalServerResponse(lease.stream as output)
                          ├── listener(req, res)
                          └── encodeVerserEnvelope(res) → lease.stream
```

### Broker: Connect → Register → Route
```
createVerserBroker(options)
  │
  └── new Http2VerserBroker(options)
        │
        ├── connect()
        │     ├── session.request(POST /verser/register)
        │     ├── readNdjsonLines(stream) → handleControlFrame
        │     │     └── update routes, resolve waiters
        │     └── stream.end(JSON.stringify({ peerId, role: 'broker' }))
        │
        ├── request(req) ──────────────────────────► POST /verser/request
        │     ├── headers: targetId, method, path, headers (JSON)
        │     ├── body: stream | Buffer[]
        │     └── resolve(response stream)
        │
        ├── createAgent() ─► VerserBrokerAgent ─► VerserBrokerSocket
        │     └── socket intercepts HTTP/1 bytes → forwardRequest() → request()
        │
        ├── createDispatcher() ─► VerserBrokerDispatcher
        │     └── dispatchAsync() → resolveRouteForUrl() → request()
        │
        └── createFetch() ─► undiciFetch(dispatcher)
```

### Socket bridge (Agent → Broker)
```
http.ClientRequest
  │
  └── VerserBrokerSocket (Duplex)
        │
        ├── _write() buffers bytes → consumeRequestBytes()
        │     ├── finds \r\n\r\n header terminator
        │     ├── parses Content-Length / chunked
        │     ├── creates PassThrough body stream
        │     └── forwardRequestOnce()
        │
        ├── forwardRequest() → broker.request({ targetId, method, path, headers, body })
        │     └── serializeHttpResponseHead() → push() to socket
        │     └── response.body.pipe(createResponseSink())
        │
        └── _read() drains pending response write callback
```

## Integration Points

- **`@signicode/verser-common`** — protocol types, route resolution (`resolveRouteForUrl`),
  envelope encoding/validation (`encodeVerserEnvelope`, `createRoutedRequestEnvelope`,
  `readLeaseRequestMetadataFromStream`, `validateVerserHeaders`, `flattenVerserHeaders`),
  TLS normalization (`normalizeClientTlsOptions`), lifecycle constants (`VERSER_LIFECYCLE_EVENTS`).
- **`@signicode/verser2-guest-js-common`** — `normalizeHeaders`, `appendQueryString`
  used by `VerserBrokerDispatcher`.
- **`undici`** — `Dispatcher` (extended by `VerserBrokerDispatcher`), `fetch` (wrapped
  by `createFetch()`).
- **Node.js HTTP/2** — `http2.connect`, `ClientHttp2Session`, `ClientHttp2Stream`,
  pseudo-headers; used for all Host communication.
- **Node.js HTTP** — `http.Agent`, `http.ClientRequest`, `http.STATUS_CODES`;
  used by the Agent bridge and the `attach()` API.
- **`@signicode/verser2-guest-bun`** — wraps the Node Guest/Broker for Bun runtimes.

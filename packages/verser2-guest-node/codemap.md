# packages/verser2-guest-node/

## Responsibility

Implements the **Node.js Guest and Broker** for Verser2 outbound Host routing.
This package provides the full HTTP/2 transport layer — the Guest connects
outbound to a Host over TLS HTTP/2, registers as role `guest`, maintains a
lease-stream pool, and dispatches incoming routed requests to a local HTTP
handler **without calling `server.listen()`**.  The Broker connects outbound
to a Host as role `broker`, receives route-control frames, and forwards
requests to advertised Guest targets.

Key factory functions exported at the package level:
- `createVerserNodeGuest(options)` — creates a new Node Guest.
- `createVerserBroker(options)` — creates a new Broker.

## Design / Patterns

- **Outbound-only connection** — Both Guest and Broker establish outbound TLS
  HTTP/2 connections to the Host.  No inbound port is opened.
- **Lease-stream pool (Guest)** — The Guest maintains a pool of pre-opened
  HTTP/2 streams (`lease streams`) that the Host uses to dispatch incoming
  requests.  Pool size is bounded by `minWaitingStreams` / `maxOpenStreams`.
  Leases transition through states: `opening` → `waiting` → `active`.
- **Control stream (Guest)** — A dedicated HTTP/2 stream (`/verser/guest/control`)
  stays open for future coordination; currently carries no data.
- **Route-control frames (Broker)** — The Broker receives NDJSON route-control
  frames (`{ type: 'routes', routes: [...] }`) on the registration stream and
  maintains a local route table.  `waitForRoute(domain)` defers resolution
  until a route is advertised.
- **Minimal HTTP/1 surface** — `MinimalIncomingMessage` (extends `PassThrough`)
  and `MinimalServerResponse` (extends `EventEmitter`) provide a familiar
  Node.js HTTP request/response API without full `IncomingMessage`/`ServerResponse`
  semantics (no socket access, trailers, upgrade, or informational responses).
- **Three Broker routing interfaces** — `request()` for direct target dispatch;
  `createAgent()` for an `http.Agent` that resolves via route table; `createDispatcher()`
  for an Undici `Dispatcher`; `createFetch()` for a `fetch` wrapper.
- **Transfer-Encoding: chunked decoder** — `ChunkedBodyDecoder` handles
  chunked transfer encoding in the Broker socket path.
- **Single active session** — Both Guest and Broker maintain at most one HTTP/2
  session at any time.

- **VWS/1 WebSocket transport** — `guest.attachWebSocket()` /
  `attachNativeWebSocket()` and `broker.webSocket()` / `nativeWebSocket()` use
  explicit framed messages over dedicated TLS HTTP/2 streams. Host federation
  forwards the versioned stream hop by hop. Generic upgrade, CONNECT/RFC8441,
  L4, Agent, and Dispatcher forwarding are not implemented.

## Data & Control Flow

### Guest (inbound request)
```
Host ──► TLS HTTP/2 ──► Guest
                              │
                              ├── register(peerId, role='guest', routedDomains)
                              │
                              ├── open control stream (/verser/guest/control)
                              │
                              └── maintain lease pool
                                      │
                                      ├── openLeaseStream()
                                      │       └── stream: POST /verser/guest/lease
                                      │
                                      └── handleLeaseStream()
                                              │
                                              ├── readLeaseRequestMetadataFromStream()
                                              ├── dispatchLeasedRequest()
                                              │       │
                                              │       ├── MinimalIncomingMessage
                                              │       ├── MinimalServerResponse
                                              │       ├── listener(request, response)
                                              │       │
                                              │       └── encodeVerserEnvelope(response)
                                              │               └── write to lease stream
                                              │
                                              └── repair pool (maintainLeasePool)
```

### Broker (outbound request)
```
Broker ──► register(peerId, role='broker')
              │
              ├── receive route-control frames (NDJSON)
              │       └── handleControlFrame() → update local routes
              │
              └── request(VerserBrokerRequest)
                      │
                      ├── session.request(POST /verser/request, headers)
                      │       ├── x-verser-target-id
                      │       ├── x-verser-method / x-verser-path
                      │       └── x-verser-headers (JSON)
                      │
                      └── resolve(stream) → VerserBrokerResponse { body: Readable }

Alternative paths:
    createAgent()        → http.Agent → VerserBrokerSocket → forward to Guest
    createDispatcher()   → Undici Dispatcher → VerserDispatchController
    createFetch()        → Undici fetch with dispatcher
```

## Integration Points

- **`@signicode/verser-common`** — protocol types, route resolution,
  envelope encoding/validation, TLS normalization, lifecycle constants.
- **`@signicode/verser2-guest-js-common`** — shared helpers (`normalizeHeaders`,
  `appendQueryString`), used by the broker dispatcher.
- **`undici`** — `Dispatcher` and `fetch`; the Broker's `createDispatcher()` /
  `createFetch()` return undici-based interfaces.
- **Node.js built-ins** — `http2`, `http`, `stream`, `events`.
- **`@signicode/verser2-guest-bun`** — consumes the Node Guest/Broker transport,
  wrapping it with Bun-specific handler conventions.

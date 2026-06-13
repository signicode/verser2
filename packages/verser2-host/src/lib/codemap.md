# packages/verser2-host/src/lib/

## Responsibility

Implementation modules for the `@signicode/verser2-host` package. Contains the Host TLS HTTP/2 server implementation, HTTP/2 stream I/O helpers, type definitions, packaging constants, and error-wrapping utilities.

## Design / Patterns

### Module inventory

| File | Responsibility | Key exports |
|---|---|---|
| `node-http2-verser-host.ts` | Core Host server logic. Implements `VerserHost`. | `NodeHttp2VerserHost` class (`@internal`). Handles: session tracking, path routing (`/verser/register`, `/verser/guest/control`, `/verser/guest/lease`, `/verser/request`), peer registration with optional mTLS auth, Guest lease pool management (idle pool + queued acquisitions with timeout), Broker request→lease routing with pipe-through, route advertisement on change, lifecycle event emission, graceful shutdown. |
| `http2-io.ts` | HTTP/2 stream write helpers. | `writeJsonLine()` — writes NDJSON to stream (responds 200 + `application/json` if headers not yet sent). `sendError()` — writes 502 + JSON error body. |
| `types.ts` | Host-specific type definitions. | `VerserHostOptions` (port, host, tls), `VerserHostRegistrationRequest` (re-export alias), `VerserHostLifecycleEvent` (name, peerId, role, reason, error), `VerserHost` interface (running, address, start, close, reloadTlsCertificate, getRoutedDomains, onLifecycle). |
| `utils.ts` | Host error wrapping. | `toVerserError()` — wraps unknown errors into `VerserError` (preserves already-VerserError instances by duck-typing on `code` + `name`). |
| `constants.ts` | Packaging constant. | `VERSER2_HOST_PACKAGE_NAME` (`'@signicode/verser2-host'`). |

### Key patterns in `node-http2-verser-host.ts`

- **Event-driven architecture** — the server uses Node `EventEmitter` for lifecycle events (`onLifecycle`/`emitLifecycle`). Internal state is managed with `Map`s and `Set`s.
- **Stateful peer/lease maps** — `peers` (peerId → RegisteredPeer), `sessions` (Set of sessions), `idleLeases` (guestId → lease[]), `activeLeases` (guestId:leaseId → lease), `queuedLeaseAcquisitions` (guestId → acquisition[]), `guestRegistrations` (guestId → RoutedDomainRegistration[]).
- **Lease pool with priority** — `addIdleLease()` checks `queuedLeaseAcquisitions` first; if a request is waiting, the new lease is immediately assigned. Otherwise it joins the idle pool.
- **Lease acquisition with timeout** — `acquireLease()` returns a `Promise` that either resolves with an idle lease or rejects after `timeoutMs` via `setTimeout`. Timeouts are cleared when leases become available.
- **Stream piping for body forwarding** — Broker request stream is piped into the Guest lease stream (`stream.pipe(lease.stream)`). Guest response is piped back to the Broker (`lease.stream.pipe(stream)`). No buffering of large payloads.
- **Cancellation propagation** — if the Broker stream is aborted/closed/errored, the lease stream is cancelled (`NGHTTP2_CANCEL`). Similarly, lease stream errors propagate back.
- **Graceful cleanup paths** — all maps are cleared in `close()`. `removeSessionPeers()` handles individual disconnect. `closeGuestLeases()`, `failQueuedLeaseAcquisitions()` ensure no dangling promises or streams.

## Data & Control Flow

### Peer registration
1. Incoming stream on `/verser/register` → `handleStream()` reads full body via `readStreamText()` → `parseRegistrationRequest()` validates → `authorizeRegistration()` calls optional mTLS callback.
2. If allowed: peer stored in `peers` map. Guest routes stored in `guestRegistrations`. Broker control stream stored as `peer.controlStream`.
3. Registration response sent: Brokers get NDJSON with full route table; Guests get JSON `{ status: 'registered' }`.
4. `advertiseRoutes()` called for Guest registration → all Brokers receive updated route control frame.

### Broker request forwarding
1. Incoming stream on `/verser/request` → `routeBrokerRequest()` extracts targetId, requestId, lease timeout from headers.
2. `tryAcquireLease()` checks idle pool → if available, immediately assigned. If not, `acquireLease()` queues the request with a timeout promise.
3. `routeBrokerRequestOverLease()`:
   a. Writes request envelope (prefix + metadata) to lease stream via `encodeVerserEnvelope()`.
   b. Pipes Broker request body to lease stream (`stream.pipe(lease.stream)`).
   c. Reads response envelope from lease stream via `readLeaseResponseMetadataFromStream()`.
   d. Responds to Broker with status code + headers from response envelope.
   e. Pipes lease stream (response body) back to Broker stream.
4. Completion/failure: `finish` event marks the lease `completed`. Lease is not returned to pool (single-use per request).

### Session disconnect
1. Session `close` → `removeSessionPeers()` iterates all peers, deletes matching entries, removes Guest routes, closes leases, fails queued acquisitions.
2. If a Guest disconnected, `advertiseRoutes()` is called to notify Brokers of the removed routes.

## Integration Points

- **Depends on** — `@signicode/verser-common` (17+ imports from the lib modules: envelope, registration, TLS, headers, routing, lifecycle, errors, NDJSON, protocol-headers). All common types and helpers come from the common package.
- **Called by** — `src/index.ts` which instantiates `NodeHttp2VerserHost` in `createVerserHost()`.
- **`http2-io.ts` used by** — `node-http2-verser-host.ts` for stream writing and error responses.
- **`types.ts` used by** — `src/index.ts` (type exports) and `node-http2-verser-host.ts` (implementation).
- **`utils.ts` used by** — `node-http2-verser-host.ts` for error wrapping in stream handlers and event emission.
- **No Runtime Dependencies** — the Host depends only on `@signicode/verser-common` and Node.js built-ins (`node:http2`, `node:events`, `node:stream/consumers`, `node:tls`, `node:net`).

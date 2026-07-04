# packages/verser2-host/src/lib/

## Responsibility

Implementation modules for the `@signicode/verser2-host` package. Contains the Host TLS HTTP/2 server implementation, local Host peer helpers, HTTP/2 stream I/O helpers, type definitions, packaging constants, and error-wrapping utilities.

## Design / Patterns

### Module inventory

| File | Responsibility | Key exports |
|---|---|---|
| `node-http2-verser-host.ts` | Core Host server orchestration. Implements `VerserHost`. | `NodeHttp2VerserHost` class (`@internal`). Handles: session tracking, path routing (`/verser/register`, `/verser/guest/control`, `/verser/guest/lease`, `/verser/request`), peer registration with optional mTLS auth, route advertisement on change, lifecycle event emission, graceful shutdown. Delegates lease pool management to `lease-pool.ts`, degraded-route timer to `degraded-route-cleanup.ts`, Broker request routing to `broker-routing.ts`, and federation stream/lifecycle helpers to `federation.ts`. |
| `lease-pool.ts` | Guest lease stream pool management. | `LeasePool` class, `GuestLeaseStream` interface. Manages idle/active lease maps, queued acquisitions with timeout, lease removal, and close/failure cleanup. Imported by `node-http2-verser-host.ts` (ownership) and `broker-routing.ts` (type usage). |
| `degraded-route-cleanup.ts` | Degraded route expiration timer. | `DegradedRouteCleanup` class, `DegradedRouteCleanupCallbacks` interface. Starts/stops a periodic timer; on each tick calls `removeExpiredDegradedRoutes()`, emits lifecycle events, and auto-stops when no degraded routes remain. Callbacks passed from Host to avoid circular dependency. |
| `broker-routing.ts` | Broker request dispatch and routing. | `routeBrokerRequest()`, `routeLocalBrokerRequest()`, `routeLocalRequest()`, `PeerInfo`, `BrokerRoutingCallbacks`. Handles H2 Broker→Guest lease routing, local Broker→local Guest dispatch, federated fallback/acquisition, cancellation propagation, and structured error preservation. |
| `federation.ts` | Federation and upstream-link helpers. | `sendUpstreamHandshake()`, `waitForUpstreamHandshakeResponse()`, `openUpstreamRouteStream()`, `openUpstreamRequestStream()`, `handleFederatedRouteFrame()`, `forwardFederatedLifecycleEventsExcluding()`, `handleFederatedIncomingRequestStream()`, `writeFederatedRoutes()`, `FederationRequestStream`, `AcquiredFederatedRequestStream`. Handles upstream link handshake/timeout, federated route/request streams, lifecycle forwarding, and incoming federated request dispatch. |
| `local-peers.ts` | Local Host-side Guest/Broker helpers. | `createLocalBrokerState()`, `updateLocalBrokerRoutes()`, `waitForLocalBrokerRoute()`, `closeLocalBrokerState()`, `extractLocalGuestListener()`, `dispatchLocalGuestRequest()`, `toReadableBody()`. Provides minimal Node HTTP request/response shims, local route waiters, local response validation, and close/error propagation helpers. |
| `http2-io.ts` | HTTP/2 stream write helpers. | `writeJsonLine()` — writes NDJSON to stream (responds 200 + `application/json` if headers not yet sent). `sendError()` — writes 502 + JSON error body. |
| `types.ts` | Host-specific type definitions. | `VerserHostOptions` (port, host, tls), `VerserHostRegistrationRequest` (re-export alias), `VerserHostLifecycleEvent` (name, peerId, role, reason, error), local peer option/request/response/handle types, `VerserHost` interface (running, address, start, close, reloadTlsCertificate, getRoutedDomains, attachLocalGuest, attachLocalBroker, onLifecycle). |
| `utils.ts` | Host error wrapping. | `toVerserError()` — wraps unknown errors into `VerserError` (preserves already-VerserError instances by duck-typing on `code` + `name`). |
| `constants.ts` | Packaging constant. | `VERSER2_HOST_PACKAGE_NAME` (`'@signicode/verser2-host'`). |

### Key patterns

- **Event-driven architecture** — `NodeHttp2VerserHost` uses Node `EventEmitter` for lifecycle events (`onLifecycle`/`emitLifecycle`). Internal state is managed with `Map`s and `Set`s.
- **Stateful peer/lease maps** — `peers` (peerId → RegisteredPeer), `sessions` (Set of sessions), `guestRegistrations` (guestId → RoutedDomainRegistration[]). Lease maps (`idleLeases`, `activeLeases`, `queuedLeaseAcquisitions`) are encapsulated in `LeasePool`.
- **Local peer state** — local Guest/Broker state shares the `peers` map. Local Brokers keep a full route snapshot and waiter map; Host close and local handle close reject pending waiters and abort active local requests.
- **Lease pool with priority** (`lease-pool.ts`) — `addIdleLease()` checks queued acquisitions first; if a request is waiting, the new lease is immediately assigned. Otherwise it joins the idle pool.
- **Lease acquisition with timeout** (`lease-pool.ts`) — `acquireLease()` returns a `Promise` that either resolves with an idle lease or rejects after `timeoutMs` via `setTimeout`. Timeouts are cleared when leases become available.
- **Degraded route cleanup** (`degraded-route-cleanup.ts`) — periodic timer checks for expired degraded routes, removes them via route registry callbacks, emits lifecycle events, and auto-stops when none remain.
- **Broker request routing** (`broker-routing.ts`) — H2 Broker→Guest lease routing, local Broker→local Guest dispatch, federated fallback/acquisition, cancellation propagation, and structured error preservation.
- **Federation stream/lifecycle helpers** (`federation.ts`) — upstream handshake/timeout, federated route/request stream opening, route frame handling, lifecycle forwarding/tagging, and incoming federated request dispatch.
- **Stream piping for body forwarding** — Broker request stream is piped into the Guest lease stream (`stream.pipe(lease.stream)`). Guest response is piped back to the Broker (`lease.stream.pipe(stream)`). No buffering of large payloads.
- **Cancellation propagation** — if the Broker stream is aborted/closed/errored, the lease stream is cancelled (`NGHTTP2_CANCEL`). Similarly, lease stream errors propagate back.
- **Graceful cleanup paths** — all maps are cleared in `close()`. `removeSessionPeers()` handles individual disconnect. `LeasePool` methods (`closeGuestLeases()`, `failQueuedLeaseAcquisitions()`, `closeAllLeases()`, `failAllQueuedLeaseAcquisitions()`) ensure no dangling promises or streams.

## Data & Control Flow

### Peer registration
1. Incoming stream on `/verser/register` → `handleStream()` reads full body via `readStreamText()` → `parseRegistrationRequest()` validates → `authorizeRegistration()` calls optional mTLS callback.
2. If allowed: peer stored in `peers` map. Guest routes stored in `guestRegistrations`. Broker control stream stored as `peer.controlStream`.
3. Registration response sent: Brokers get NDJSON with full route table; Guests get JSON `{ status: 'registered' }`.
4. `advertiseRoutes()` called for Guest registration → all Brokers receive updated route control frame.

### Broker request forwarding (delegated to `broker-routing.ts`)
1. Incoming stream on `/verser/request` → `NodeHttp2VerserHost.routeBrokerRequest()` delegates to `routeBrokerRequest()` in `broker-routing.ts` which extracts targetId, requestId, lease timeout from headers.
2. `tryAcquireLease()` checks idle pool → if available, immediately assigned. If not, `acquireLease()` queues the request with a timeout promise.
3. `routeBrokerRequestOverLease()`:
   a. Writes request envelope (prefix + metadata) to lease stream via `encodeVerserEnvelope()`.
   b. Pipes Broker request body to lease stream (`stream.pipe(lease.stream)`).
   c. Reads response envelope from lease stream via `readLeaseResponseMetadataFromStream()`.
   d. Responds to Broker with status code + headers from response envelope.
   e. Pipes lease stream (response body) back to Broker stream.
4. Completion/failure: `finish` event marks the lease `completed`. Lease is not returned to pool (single-use per request).

### Local peer routing
1. `attachLocalGuest()` stores a local listener and routes in Host state; `attachLocalBroker()` stores a local route snapshot and waiter state.
2. Local Brokers call `request()` → Host validates target and headers → local targets dispatch through `dispatchLocalGuestRequest()`; H2 targets acquire a lease.
3. H2 Brokers targeting local Guests route through the same local dispatch path, with response bodies piped back to the HTTP/2 stream.
4. Local close/detach and Host close reject route waiters and abort active local dispatches with `disconnected-target`.

### Session disconnect
1. Session `close` → `removeSessionPeers()` iterates all peers, deletes matching entries, removes Guest routes, closes leases, fails queued acquisitions.
2. If a Guest disconnected, `advertiseRoutes()` is called to notify Brokers of the removed routes.

## Integration Points

- **Depends on** — `@signicode/verser-common` (17+ imports from the lib modules: envelope, registration, TLS, headers, routing, lifecycle, errors, NDJSON, protocol-headers). All common types and helpers come from the common package.
- **Called by** — `src/index.ts` which instantiates `NodeHttp2VerserHost` in `createVerserHost()`.
- **`lease-pool.ts` used by** — `node-http2-verser-host.ts` (lease pool ownership and delegation) and `broker-routing.ts` (type import of `GuestLeaseStream`).
- **`degraded-route-cleanup.ts` used by** — `node-http2-verser-host.ts` (timer start/stop delegation via `DegradedRouteCleanupCallbacks`).
- **`broker-routing.ts` used by** — `node-http2-verser-host.ts` (Broker request dispatch delegation via thin wrappers).
- **`federation.ts` used by** — `node-http2-verser-host.ts` (federation stream/lifecycle delegation), `broker-routing.ts` (type import of `FederationRequestStream`, `AcquiredFederatedRequestStream`).
- **`http2-io.ts` used by** — `node-http2-verser-host.ts` for stream writing and error responses.
- **`types.ts` used by** — `src/index.ts` (type exports) and `node-http2-verser-host.ts` (implementation).
- **`utils.ts` used by** — `node-http2-verser-host.ts` for error wrapping in stream handlers and event emission.
- **No Runtime Dependencies** — the Host depends only on `@signicode/verser-common` and Node.js built-ins (`node:http2`, `node:events`, `node:stream/consumers`, `node:tls`, `node:net`).

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
| `broker-routing.ts` | Broker request dispatch and routing. | `routeBrokerRequest()`, `routeLocalBrokerRequest()`, `routeLocalRequest()`, `evaluateFederationHop()`, `PeerInfo`, `BrokerRoutingCallbacks`. Handles H2 Broker→Guest lease routing, local Broker→local Guest dispatch, federated fallback/acquisition, hop-local route authorization (session-bound `x-verser-source-id` → persisted `brokerDomain`, per-candidate allow/deny with post-await revalidation), Host-to-Host `sourceId` replacement, cancellation propagation, and structured error preservation. |
| `federation.ts` | Federation and upstream-link helpers. | `sendUpstreamHandshake()`, `waitForUpstreamHandshakeResponse()`, `openUpstreamRouteStream()`, `openUpstreamRequestStream()`, `handleFederatedRouteFrame()`, `forwardFederatedLifecycleEventsExcluding()`, `handleFederatedIncomingRequestStream()`, `writeFederatedRoutes()`, `FederationRequestStream`, `AcquiredFederatedRequestStream`. Handles upstream link handshake/timeout, federated route/request streams, lifecycle forwarding, and incoming federated request dispatch. |
| `local-peers.ts` | Local Host-side Guest/Broker helpers. | `createLocalBrokerState()`, `updateLocalBrokerRoutes()`, `waitForLocalBrokerRoute()`, `closeLocalBrokerState()`, `extractLocalGuestListener()`, `dispatchLocalGuestRequest()`, `toReadableBody()`. Provides minimal Node HTTP request/response shims, local route waiters, local response validation, and close/error propagation helpers. |
| `http2-io.ts` | HTTP/2 stream write helpers. | `writeJsonLine()` — writes NDJSON to stream (responds 200 + `application/json` if headers not yet sent). `sendError()` — writes 502 + JSON error body. |
| `types.ts` | Host-specific type definitions. | `VerserHostOptions` (port, host, tls, routeAuthorizer, routeAuthorizationCacheTtlMs, routeAuthorizationNegativeCacheTtlMs), `VerserHostRegistrationRequest` (re-export alias), `VerserHostLifecycleEvent` (name, peerId, role, reason, error), local peer option/request/response/handle types (`VerserLocalBrokerOptions.brokerDomain`), `VerserHost` interface (running, address, start, close, reloadTlsCertificate, getRoutedDomains, revokeRouteAuthorization, attachLocalGuest, attachLocalBroker, onLifecycle). |
| `route-authorizer.ts` | Host-private hop-local federated route authorizer. | `FederatedRouteAuthorizer` class, `federatedRouteAuthorizationPairKey()`, `FederatedRouteAuthorizerOptions`. Normalized `{ previousAdvertisedDomain, nextSelectedDomain }` pair keys; allow and deny single-flight caches with independent lazy class TTLs plus per-decision `cacheTtlMs` overrides normalized once to a private `{ decision, ttlMs }` (`0` skips caching for that result, `Number.POSITIVE_INFINITY` caches until revoke/invalidation, malformed results/invalid TTLs reject without caching); explicit pair revoke clearing finite/infinite entries and pending state in both classes; generation-safe `invalidate()`. Created only when `routeAuthorizer` is configured; consulted by `broker-routing.ts` and the Host VWS paths after candidate resolution and before forwarding. |
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
1. Incoming stream on `/verser/register` → `handleStream()` reads full body via `readStreamText()` → `parseRegistrationRequest()` validates (role; broker-only normalized `brokerDomain`; rejects legacy `brokerHopDomain`) → `authorizeRegistration()` calls optional mTLS callback.
2. If allowed: peer stored in `peers` map with its normalized `brokerDomain` when supplied; with Host mTLS (`clientAuth.ca`/`caFile`) a Broker domain must exactly match a normalized DNS SAN on the peer certificate (`assertBrokerDomainCertificate()`, no wildcard/CN fallback). The legacy `brokerHopDomain` wire field and local option are rejected, not aliased. Guest routes stored in `guestRegistrations`. Broker control stream stored as `peer.controlStream`.
3. Registration response sent: Brokers get NDJSON with full route table; Guests get JSON `{ status: 'registered' }`.
4. `advertiseRoutes()` called for Guest registration → all Brokers receive updated route control frame. Guest (re-)registration also calls `invalidateRouteAuthorizations()`.

### Hop-local federation route authorization (forwarding enforcement)
1. When `routeAuthorizer` is configured, the Host's private `FederatedRouteAuthorizer` (`route-authorizer.ts`) is consulted after concrete federation candidate resolution and before federation stream acquisition, envelope/frame writes, body piping, VWS open forwarding, or bridging on: remote/local Broker HTTP egress (`broker-routing.ts`), incoming-federation HTTP dispatch, direct Broker VWS egress, and incoming/upstream federation VWS (`routeFederationVwsInternal`). Without the option, `authorizeFederatedHopPair` resolves `true` and behavior is unchanged.
2. First hop: the previous domain is the Broker's persisted normalized `brokerDomain`. Remote HTTP requests additionally bind `x-verser-source-id` to a Broker registered on the current HTTP/2 session (`resolveRemoteBrokerDomain`) before the stored domain is read; local Brokers use Host-owned persisted state. A Broker-selected federation request without a domain fails with `authorization-denied` (both remote and local).
3. Subsequent hops: the incoming resolved route/open domain is the previous hop (the hop baton; the empty incoming baton on a federated request is denied when configured). Forwarding never uses origin or hop history for authorization.
4. Explicit allow and deny results are cached per normalized pair with single-flight sharing under independently configured class TTLs (`routeAuthorizationCacheTtlMs` default 60000; `routeAuthorizationNegativeCacheTtlMs` default `floor(allow/10)`; `0` disables that class; lazy expiry, no timers) with per-decision `cacheTtlMs` overrides (`0` = no caching for that result, positive safe integer = finite override, `Number.POSITIVE_INFINITY` = cache until revoke/invalidation; the only infinite option — Host TTLs stay finite); callback errors and malformed results are never cached. `invalidateRouteAuthorizations()` (generation bump + clear both cache classes including infinite entries) fires on Guest (re-)registration, degradation, revocation (remote and local), expired-degraded removal, imported snapshot replacement/removal, direct imported-route removal, federation-link removal, and Host `close()`. After an awaited allow, the selected candidate is revalidated so a route lost during the decision cannot be forwarded.
5. Host-to-Host egress replaces identity: HTTP envelopes (`routeH2BrokerRequestOverFederationStream`, `routeLocalRequestOverFederationStream`) and forwarded VWS open frames (`createForwardedFederationVwsOpen`) carry the local Host's egress identity as `sourceId`, never the origin Broker.
6. Route binding: an authorized logical federation HTTP request stream and an accepted federated VWS connection keep their resolved route/authorization for their lifetime; TTL expiry, explicit revoke, and route lifecycle changes gate only new forwarding/open decisions. Physical HTTP/2 sessions stay multiplexed and are never route-bound.
7. `revokeRouteAuthorization(pair)` (public) removes one cached allow or deny and abandons its pending decision. `getRegisteredBrokerDomain(peerId)` returns the persisted normalized domain for a registered Broker.

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

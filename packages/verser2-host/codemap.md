# packages/verser2-host/

## Responsibility

TLS HTTP/2 server implementation of the Verser Host — accepts outbound connections from Guest and Broker peers, manages peer registration, maintains Guest lease pools, routes Broker requests to target Guests via lease streams, and advertises route changes to connected Brokers.

## Design / Patterns

- **Node `http2.createSecureServer`** — the Host is a secure HTTP/2 server only. No HTTP/1, no plaintext, no HTTP/3. Connections are outbound-initiated (peers connect *to* the Host).
- **Four protocol paths** — `/verser/register` (registration), `/verser/guest/control` (Guest coordination), `/verser/guest/lease` (Guest request/response body streams), `/verser/request` (Broker request dispatch). Any other path is rejected.
- **Lease stream pool** — each Guest establishes one or more lease streams. The Host acquires an idle lease for each incoming Broker request. If none is available, the request is queued with a configurable timeout. Lease acquisition uses `parseLeaseAcquireTimeoutMs` (default 5000 ms).
- **Peer session tracking** — `Map<peerId, RegisteredPeer>` tracks all connected peers. Duplicate peer IDs rejected at registration. Sessions tracked in a `Set` for lifecycle cleanup on disconnect.
- **Route advertisement via NDJSON** — when a Guest registers or disconnects, `advertiseRoutes()` sends a `{ type: 'routes', routes: [...] }` NDJSON frame to all Broker control streams. Brokers replace their entire route table on each frame.
- **Registration authorization** — optional `tls.clientAuth.authorizeRegistration` callback receives `VerserRegistrationAuthorizationContext` (peer certificate identity, registration details, TLS auth state). Returning `{ action: 'close' }` rejects with 403 and closes the session.
- **TLS certificate reload** — `reloadTlsCertificate()` calls `server.setSecureContext()` for in-place certificate rotation without dropping existing connections.
- **Lifecycle event emitter** — `onLifecycle()` returns an unsubscribe function. Events: `connected`, `disconnected`, `registered`, `route-advertised`, `request-started`, `request-completed`, `error`, `closed`.

## Data & Control Flow

1. **Connection**: Peer opens TLS HTTP/2 session → `session` event → tracked in `sessions` Set → `connected` lifecycle event emitted.
2. **Registration**: Peer sends JSON body on `/verser/register` → `parseRegistrationRequest()` validates → `authorizeRegistration()` runs optional mTLS callback → `RegisteredPeer` stored in `peers` map → Guest routes stored in `guestRegistrations` → `advertiseRoutes()` notifies all Brokers → `200` response sent.
3. **Guest lease attach**: Guest opens stream on `/verser/guest/lease` with `x-verser-peer-id` + `x-verser-lease-id` headers → `attachGuestLeaseStream()` responds `200` → lease added to `idleLeases` pool → if a Broker request is queued for this Guest, the lease is immediately assigned.
4. **Broker request dispatch**: Broker opens stream on `/verser/request` with `x-verser-target-id`, `x-verser-request-id`, `x-verser-method`, `x-verser-path`, `x-verser-headers` → `routeBrokerRequest()` acquires a lease (idle pool first, then queue with timeout) → `routeBrokerRequestOverLease()` writes envelope prefix + metadata to lease stream, pipes Broker request body → reads response envelope from lease stream → responds to Broker with status code + headers → pipes lease response body back.
5. **Disconnect cleanup**: Session `close` event → `removeSessionPeers()` deletes peer from `peers`, removes Guest routes, closes all leases for that Guest, fails queued acquisitions, re-advertises routes if a Guest disconnected → `disconnected` event emitted.
6. **Host shutdown**: `close(reason)` → closes all control streams, closes all lease streams, fails all queued acquisitions, closes all sessions, closes server socket → `closed` event emitted.

## Integration Points

- **Depends on**: `@signicode/verser-common` (envelope encoding, registration parsing, TLS normalization, lifecycle events, header validation, stream reading, route control frames, error types). No external npm dependencies.
- **Consumed by**: Applications that create a Host via `createVerserHost(options)`. The `VerserHost` interface is the public API surface.
- **Internal modules**: `node-http2-verser-host.ts` (orchestration), `http2-io.ts` (stream write helpers), `types.ts` (options + interface types), `utils.ts` (error wrapping), `constants.ts` (package name).
- **Not provided**: Authentication, authorization, rate limiting, logging, metrics, WebSocket/upgrade/tunneling support. Applications integrate those layers themselves.

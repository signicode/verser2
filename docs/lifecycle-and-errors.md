# Lifecycle and errors

## Route lifecycle events

Route lifecycle events complement the snapshot-based `getRoutes()` API.
Brokers and local Broker handles can subscribe to observe per-route changes
reactively.

### Subscribing

```ts
// Node / Bun / local Broker
const unsubscribe = broker.onRouteChange((event) => {
  console.log(event.type, event.targetId, event.domain);
});
```

```py
# Python
def on_change(event):
    print(event["type"], event["targetId"], event["domain"])

unsubscribe = broker.on_route_change(on_change)
```

The unsubscribe function stops receiving events. The internal route snapshot
(`getRoutes()` / `get_routes()`) is updated **before** listeners fire, so
the listener can safely inspect the current route state.

### Event payload

```ts
{
  type: 'added' | 'removed' | 'changed' | 'degraded',
  targetId: string,     // Guest peer owning the route
  domain: string,       // the affected hostname
  reason?: string,      // why the change occurred
  generation?: {        // version/session metadata
    generationId: string,
    sessionId?: string,
  },
}
```

### Event types

| Type | Meaning |
|------|---------|
| `added` | Route was registered by a Guest. |
| `removed` | Route was revoked by the Guest, removed after degraded timeout, or a stale degraded route was dropped on reconnect. |
| `changed` | Route was restored from degraded state, or generation/session metadata changed. |
| `degraded` | Guest disconnected; route enters degraded/disconnected state. |

### Reasons

| Reason | Meaning |
|--------|---------|
| `registered` | Guest connected and advertised the route. |
| `revoked` | Guest explicitly revoked the route via `revokeRoutes()`. |
| `disconnected` | Guest connection dropped; route moved to degraded state. |
| `reconnected` | Stale degraded route dropped because the Guest reconnected without that domain. |
| `restored` | Route restored from degraded state (reconnect before timeout). |
| `timeout` | Degraded route exceeded the timeout and was removed. |
| `updated` | Route generation/session metadata changed. |

### Degraded/disconnected route flow

1. **Guest disconnect** — the Host does not immediately remove the route.
   Instead, the route enters a **degraded** state. Brokers receive a
   `degraded` lifecycle event. The route remains visible in `getRoutes()`
   so Brokers can still reference it, but requests to the disconnected
   Guest fail with a `missing-guest` error (the peer entry is removed from
   the active peer table even though the route record is preserved).

2. **Reconnect window** — if the same Guest reconnects (same Guest ID,
   possibly with the same routes) before the timeout expires, the routes
   are restored to active state. Brokers receive a `changed` event with
   `reason: 'restored'`.

3. **Timeout** — if the Guest does not reconnect within the configured
   window, the route is fully removed. Brokers receive a `removed` event
   with `reason: 'timeout'`.

The timeout is controlled by `degradedRouteTimeoutMs` on
`VerserHostOptions` and defaults to **5000 ms**.

### Guest revocation flow

When a Guest calls `revokeRoutes(domains)`:

1. The Guest sends a `POST /verser/guest/revoke` request to the Host with
   the domain list.
2. The Host processes the revocation, updates the route registry, and
   returns a response with status `ack`, `partial`, or `error`.
3. The Host broadcasts `removed` lifecycle events with `reason: 'revoked'`
   to all connected Brokers.
4. The Broker route snapshot is updated and listeners fire.

Local Host Guests call `revokeRoutes(domains)` synchronously and receive
`{ revoked: string[], notFound: string[] }`. The Host emits the same
lifecycle events for connected Brokers.

### Metadata optionality

The `reason` and `generation` fields in lifecycle events are **optional and
best-effort**. Events derived from a full-snapshot diff after a federated
route table sync or a local Broker reconnection may omit `reason` and/or
`generation` because the Host reconstructs the event from the snapshot state
rather than from the original trigger. Consumers should not depend on these
fields being present in every event.

### Comparison with snapshot API

| API | Purpose | When to use |
|-----|---------|-------------|
| `getRoutes()` / `get_routes()` | Current route table snapshot | Polling, initial state, or after reconnection |
| `waitForRoute()` / `wait_for_route()` | Block until a route appears | Startup coordination |
| `onRouteChange()` / `on_route_change()` | Reactive observation | Monitoring, logging, cache invalidation |

The snapshot API always returns the latest state. Lifecycle events provide
reactive observation but the snapshot is updated before listeners fire, so
a listener can safely inspect current state without ordering concerns.

## Lifecycle surfaces

Host and Node/Bun Guest instances expose lifecycle callbacks. Brokers expose
route state and request failures through their request APIs.

### Host lifecycle

```ts
const host = createVerserHost({
  port: 8443,
  tls: { certFile: '/etc/verser/host.crt', keyFile: '/etc/verser/host.key' },
});

const unsubscribe = host.onLifecycle((event) => {
  console.log('Host lifecycle event:', event.name);
});

await host.start();
unsubscribe();
```

`host.address` is available after `start()` and throws before the Host is
listening. Use `host.close()` for shutdown.

Host lifecycle events are emitted for local peers attached with
`attachLocalGuest()` and `attachLocalBroker()`, remote TLS HTTP/2 peers, and
upstream Host links. Local registrations, upstream Host registration and
disconnection, local Broker route advertisements, request start/completion,
errors, and Host close events use the Host lifecycle surface.

### Node and Bun Guest lifecycle

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

const unsubscribe = guest.onLifecycle((event) => {
  console.log('Guest lifecycle event:', event.name, event.reason);
});

guest.attach(localHttpServer, 'client-a.local.test');
await guest.connect();
```

Bun Guests use the same connection lifecycle through the Bun wrapper, but attach
Bun Fetch-style handlers or route tables instead of Node HTTP listeners.

### Broker route state

```ts
await broker.connect();
await broker.waitForRoute('client-a.local.test');
console.log(broker.getRoutes());
```

Node/Bun Brokers provide `getRoutes()` and `waitForRoute(domain)`. Python Brokers
provide `get_routes()` and `wait_for_route(domain)`. If waiting forever is not
acceptable, wrap the wait in an application timeout.
Local Broker handles returned by `host.attachLocalBroker()` provide
`getRoutes()`, `waitForRoute(domain)`, `request()`, `routedRequestCount`, and
`close()`.

### Python lifecycle

Python Guest and Broker APIs use explicit async lifecycle methods. Python Broker
also supports async context manager usage.

```py
guest = create_verser_guest(
    host_url="https://localhost:8443",
    guest_id="python-guest-a",
    app=app,
    routed_domains=["python-guest-a.local.test"],
    tls_ca_file="/etc/verser/ca.crt",
)

await guest.connect()
try:
    await asyncio.Event().wait()
finally:
    await guest.close()

async with create_verser_broker(
    host_url="https://localhost:8443",
    broker_id="broker-a",
    tls_ca_file="/etc/verser/ca.crt",
) as broker:
    await broker.wait_for_route("python-guest-a.local.test")
```

## Error handling pattern

Errors include context to help identify the source when available:

- peer ID (`guestId`, `brokerId`, or target ID)
- request method and path
- stream ID or request ID
- local close reason, when surfaced by the implementation
- timeout reason

```ts
try {
  const response = await broker.request({
    targetId: 'client-a',
    method: 'GET',
    path: '/health',
  });
  response.body.pipe(process.stdout);
} catch (error) {
  console.error('Request failed:', error);
}
```

## Common error scenarios

| Scenario                   | Behavior                                                     |
|----------------------------|--------------------------------------------------------------|
| Host unreachable           | Guest/Broker `connect()` fails                               |
| Duplicate peer ID          | Host rejects registration with a protocol error              |
| Route not advertised       | Broker route lookup or request fails                         |
| Guest handler throws       | Host returns a `local-handler-failure` error envelope        |
| TLS certificate expired    | HTTP/2 session setup fails                                   |
| Connection lost            | Requests fail until the application closes and reconnects    |
| Upstream link lost         | Imported routes are withdrawn; new requests fall back or fail |
| Lease acquire timeout      | Routed request fails with a timeout error                    |
| Response exceeds max bytes | Direct dispatch fails with a size-limit error                |
| Degraded route request     | Request to a disconnected Guest fails with `missing-guest` (peer removed from active table) |

## Error codes

Verser errors use machine-readable codes so applications can distinguish common
failure classes:

| Code | Meaning |
|------|---------|
| `missing-guest` | The Host has no registered Guest for the requested target ID. |
| `disconnected-target` | The selected Guest/Broker/session disconnected before the operation completed. |
| `timeout` | A lease, connection, or route wait exceeded its configured/application timeout. |
| `stream-failure` | An HTTP/2 stream failed, reset, or closed before the expected protocol exchange completed. |
| `protocol-error` | A peer sent malformed registration data, metadata, headers, or an unsupported protocol path. |
| `local-handler-failure` | A Guest-side handler or ASGI app failed before a successful response could be completed. |
| `invalid-registration` | A peer registration was rejected because the role, ID, routed domains, or duplicate state was invalid. |
| `certificate-verification-failure` | TLS certificate validation or pinning failed. |
| `upstream-unavailable` | No usable upstream Host request stream is available for a federated route. |
| `route-loop` | A federated route would revisit a Host or exceed the configured hop limit. |
| `authorization-denied` | An upstream federation authorization callback rejected the Host link. |
| `unsafe-retry` | Reserved for retry policy failures; active non-replayable streams are not retried transparently. |
| `revocation-failed` | A route revocation request was rejected by the Host or produced an invalid response. |

## Clean shutdown

Close Guests, Brokers, and the Host when shutting down:

```ts
await guest.close('shutdown');
await broker.close();
await host.close();
```

The optional Guest close reason is local lifecycle context for implementations
that surface close events; it is not a cross-runtime application close message.
Host certificate reload with `host.reloadTlsCertificate()` affects new TLS
handshakes; existing HTTP/2 sessions keep their current TLS state.

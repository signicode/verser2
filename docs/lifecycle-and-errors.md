# Lifecycle and errors

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
| Lease acquire timeout      | Routed request fails with a timeout error                    |
| Response exceeds max bytes | Direct dispatch fails with a size-limit error                |

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

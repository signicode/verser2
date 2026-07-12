# Making requests

A Broker sends requests to advertised Guest routes through the Host. Advertised
routes can be local to that Host or imported through Host federation.

## Broker versus public gateway

A Broker is a routing client; it does not listen for public HTTP traffic by
itself. If you want to expose a public API gateway, build an application-owned
HTTP server and call the Broker from that server.

The gateway application owns public TLS, authentication, authorization, rate
limits, observability, and fallback behavior. `verser2` provides the reverse
connectivity and routed request path from that gateway into connected Guests.

See [the tiny Bun gateway example](./examples/gateway.md) for a minimal public
listener that forwards to Node and Python Guests through a Broker.

## Local Broker

When the caller runs in the Host process, `host.attachLocalBroker()` returns a
local Broker handle with the same route-table primitives (`getRoutes()` and
`waitForRoute()`) and a raw `request()` API. The request and response shapes are
`VerserLocalBrokerRequest` and `VerserLocalBrokerResponse`.

```ts
const localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-a' });

await localBroker.waitForRoute('client-a.local.test');

const response = await localBroker.request({
  targetId: 'client-a',
  method: 'POST',
  path: '/jobs',
  headers: { 'content-type': 'application/json' },
  body: [Buffer.from('{"ok":true}')],
  leaseAcquireTimeoutMs: 5000,
});

console.log(response.statusCode, response.requestId);
response.body.pipe(process.stdout);
await localBroker.close();
```

Local Broker handles do not expose Agent, Dispatcher, or fetch wrappers from the
Host package. Use the raw `request()` primitive, or keep using the remote Node
Broker when those wrappers are required.

When a local Broker targets a remote HTTP/2 Guest, `leaseAcquireTimeoutMs`
controls how long the Host waits for an available Guest lease. It defaults to
the same 5000 ms used by remote Broker requests.

## Broker.request()

The Node and Bun Broker's `request()` method sends a single request:

```ts
const response = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/health',
});

console.log(response.statusCode);
response.body.pipe(process.stdout);
```

Direct Node/Bun Broker request bodies can be omitted, provided as `Buffer`
chunks, or streamed with a Node `Readable`:

```ts
const uploadResponse = await broker.request({
  targetId: 'client-a',
  method: 'POST',
  path: '/upload',
  body: nodeReadableStream,
});

uploadResponse.body.pipe(destination);
```

Node Broker request paths follow internal `307` and `308` redirects by default
when the response `Location` hostname exactly matches an advertised verser2
route. Redirect targets are resolved through the Broker route table, not DNS, and
the original method, headers, path/query semantics, and replayable request body
are preserved. This applies to direct `broker.request()`, Agent-backed
`node:http` requests, and Dispatcher/fetch requests that use the Node Broker.
The advertised redirect target can be a local route or an imported federated
route, including routes imported by a downstream Host from its upstream Host.

Redirect following is bounded. `maxInternalRedirects` defaults to `3`, and
`internalRedirectReplayBufferBytes` defaults to `16 KiB`:

```ts
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  maxInternalRedirects: 2,
  internalRedirectReplayBufferBytes: 32 * 1024,
});
```

If the request body exceeds the replay buffer limit, or if the `Location` header
is missing, invalid, or points to an unadvertised hostname, the original
`307`/`308` response remains client-visible for the caller to handle. Exceeding
the configured redirect count fails with a `protocol-error` that identifies the
internal redirect limit.

The `broker.createFetch()` helper defaults fetch redirect handling to `manual` so
client-visible fallback responses are not followed through DNS by Undici. When
using `fetch(url, { dispatcher: broker.createDispatcher() })` directly, pass
`redirect: 'manual'` if you need to observe those fallback `307`/`308` responses
unchanged.

## Agent

`createAgent()` returns a plain `http:` Agent that routes advertised hostnames
through the Broker without DNS resolution:

```ts
const agent = broker.createAgent();

http.get('http://client-a.local.test/health', { agent }, (response) => {
  response.pipe(process.stdout);
});
```

Non-advertised hostnames are rejected — there is no DNS fallback.

## Dispatcher (Undici)

`createDispatcher()` returns an Undici `Dispatcher` for use with `fetch`:

```ts
const dispatcher = broker.createDispatcher();

const response = await fetch('http://client-a.local.test/health', {
  dispatcher,
});
console.log(await response.text());
```

The Dispatcher rejects upgrade requests. It supports buffer, string, stream, and
iterable body forms.

It does not provide arbitrary WebSocket upgrade forwarding. Use the explicit
Node Broker `webSocket()` API for VWS/1 instead.

## Fetch helper

`createFetch()` wraps a fetch function pre-wired to the Broker dispatcher:

```ts
const routedFetch = broker.createFetch();

const response = await routedFetch('http://client-a.local.test/health');
console.log(await response.text());
```

## Python Broker

The Python Broker routes by URL hostname and provides `request()` plus
convenience helpers:

```py
response = await broker.request("GET", "http://python-guest-a.local.test/health")
print(response.status)

# Convenience methods
response = await broker.get("http://python-guest-a.local.test/health")
response = await broker.post("http://python-guest-a.local.test/data", body=b'{"key": "value"}')
```

Response objects expose `status`, `headers`, `request_id`, and body reading
helpers:

```py
# Read the full body
body = await response.read()
text = await response.text()
data = await response.json()

# Iterate in chunks
async for chunk in response.aiter_bytes(8192):
    process(chunk)
```

Response bodies are one-shot — they can be read once.

## Multiplexed requests

Multiple requests can be active concurrently over a single Broker connection:

```ts
await Promise.all([
  broker.request({ targetId: 'client-a', method: 'GET', path: '/health' }),
  broker.request({ targetId: 'client-a', method: 'GET', path: '/metrics' }),
  broker.request({ targetId: 'client-a', method: 'POST', path: '/jobs', body: [Buffer.from('payload')] }),
]);
```

Each Broker-to-Host request uses a separate HTTP/2 stream. The Guest leg uses
an assigned one-use lease stream for raw body bytes while the control stream
remains available for coordination.

## Observing route changes

Brokers can observe route lifecycle events reactively without polling:

```ts
// Node / Bun
const unsubscribe = broker.onRouteChange((event) => {
  console.log(event.type, event.domain, event.reason);
});

// Python
def on_change(event):
    print(event["type"], event["domain"], event.get("reason"))

unsubscribe = broker.on_route_change(on_change)
```

Event payloads contain `type` (`added`, `removed`, `changed`, `degraded`),
`targetId`, `domain`, and optional `reason` and `generation` metadata. The
route snapshot (`getRoutes()`) is updated before the listener fires.

The Broker is observational-only — there is no Broker-level revoke API. Route
revocation is a Guest operation (see [Routes — revocation](./routes.md#route-revocation)).

See the [Lifecycle and errors](./lifecycle-and-errors.md) doc for the full
event and degraded-route reference.

## Wait for route

Before sending requests, wait for the target route to be advertised:

```ts
await broker.waitForRoute('client-a.local.test');
```

This resolves when the Host sends a route-control frame that includes the
requested domain.

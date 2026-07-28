# HTTP and Fetch compatibility

Verser2 routes requests over its TLS HTTP/2 transport. Its Node, Bun, and
Python entrypoints are compatibility adapters, not a claim to implement every
HTTP server, Node `http`, ASGI, or Fetch behavior. Use the primary guides for
[exposing handlers](./exposing-http.md) and [making requests](./making-requests.md);
this page records the consumer-visible boundaries when an application expects
ordinary HTTP or Fetch semantics.

## Routed HTTP/2 behavior

- Routed responses remove HTTP/1 hop-by-hop fields and fields named by
  `Connection`. Do not rely on `Connection`, `Upgrade`, `Transfer-Encoding`,
  trailers, or connection-specific proxy fields reaching a caller.
- Routed request validation rejects `Connection`, `Upgrade`, and `Keep-Alive`.
  This is a narrower request-side boundary than response header forwarding.
- Verser2 does not synthesize `Date` or `Server` response headers. Set them in
  the handler when your application requires them.
- Direct Node/Bun `broker.request()` construction sends the headers supplied by
  its caller; unlike ordinary HTTP clients, it does not synthesize `Host` or
  `Content-Length`. Host routing still sets the downstream `Host` to the
  selected route domain; see [route-domain selection](./making-requests.md#route-domain-selection)
  for `X-Forwarded-Host`. The Agent and Dispatcher/fetch adapters have their
  own request adaptation.
- Route-aware Node Broker paths can follow routed `307` and `308` responses.
  A redirect is followed only when its `Location` hostname is an advertised
  route, using the Broker route table rather than DNS. Other redirects remain
  visible to the caller. See [internal redirects](./making-requests.md#brokerrequest)
  for replay and limit details.

## Node Guest and Broker adapters

Node Guest handlers receive minimal HTTP/1-style request and response objects,
not full Node `IncomingMessage` and `ServerResponse` instances. They provide
the common request fields, body stream, status, headers, and write/end methods,
but have no real socket, trailers, generic upgrades, or informational (1xx)
responses. An omitted `statusMessage` remains omitted; the adapter does not
supply the usual default reason phrase.

`createAgent()` supplies a transport-backed `Duplex`, not a network socket.
Its `setNoDelay()` and `setKeepAlive()` calls are no-ops, and `setTimeout()`
only registers the callback; these socket tuning calls do not tune the routed
HTTP/2 transport.

The Undici Dispatcher rejects generic upgrade requests. For WebSockets, use the
explicit VWS/1 APIs rather than an HTTP upgrade; see
[VWS/1 WebSockets](./websockets.md).

Direct Broker response `headers` is a last-value-wins compatibility map.
Use `headerPairs` when repeated or ordered fields matter; the full behavior is
described in [Making requests](./making-requests.md#brokerrequest).

## Python ASGI adapter

For routed HTTP requests, the Python Guest reports an ASGI scope with
`http_version` set to `'1.1'`, `scheme` set to `'http'`, and `client` and
`server` set to `None`. Its `raw_path` is reconstructed from the decoded path,
not retained as the original incoming raw bytes. Applications that depend on
the original wire form or peer address should not infer them from this scope.

Python Broker response bodies are one-shot. Choose one read operation or
`aiter_bytes()`; see [Python Broker](./making-requests.md#python-broker).

## Bun Fetch adapter

The Bun Guest and Broker expose Fetch-style `Request`, `Response`, and fetch
entrypoints, but generic HTTP upgrade forwarding is unsupported. Bun
`server.upgrade()` is the VWS/1 lease adapter, not a general `Bun.serve()`
upgrade path. See the [Bun Guest WebSocket boundary](./exposing-http.md#bun-guest)
and [VWS/1 WebSockets](./websockets.md).

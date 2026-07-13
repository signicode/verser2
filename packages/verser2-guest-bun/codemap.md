# packages/verser2-guest-bun/

## Responsibility

Provides the **Bun Guest and Broker** APIs for Verser2 outbound Host routing.
This is a thin wrapper over the Node Guest/Broker transport (`@signicode/verser2-guest-node`)
that adapts Bun-specific conventions:
- Bun Guest attaches a handler object with a `fetch` function and/or a `routes`
  table (supporting `:param`, wildcard `*`, and method-map routing) instead of
  a Node-style `(req, res)` listener.
- Bun Broker wraps the Node Broker and provides a `createFetch()` that returns
  a Web Fetch-style `fetch` function returning Web `Response` objects with
  `ReadableStream` bodies.

Key factory functions:
- `createVerserBunGuest(options)` — wraps a Node Guest with Bun handler adaptation.
- `createVerserBroker(options)` — wraps a Node Broker with Bun-adapted `createFetch()`.

## Design / Patterns

- **Delegation pattern** — `createVerserBunGuest()` creates a `Http2VerserNodeGuest`
  internally and delegates `connect()`, `close()`, `onLifecycle()` directly.
  Only `attach()` is overridden to convert the Bun-style handler via
  `createNodeStyleHandler()`.
- **Handler adapter** — `createNodeStyleHandler()` in `adapter.ts` bridges between
  Bun's `(request, server) → Response` convention and Node's `(req, res) → void`
  callback style.  The adapter creates a Web `Request` from the Node-style
  request data, runs it through the Bun handler (route table → `fetch` fallback),
  and writes the Web `Response` fields back to the Node-style response.
- **Route table matching** — `routes.ts` implements exact-path, `:param`,
  wildcard `*`, and per-method map matching, closely following Bun's built-in
  `Bun.serve()` routing semantics.
- **Web Fetch response** — The Broker's `createFetch()` converts the Node
  `Readable` response body into a Web `ReadableStream<Uint8Array>` through
  async iteration.
- **Bun WebSocket boundary** — Bun Guest `server.upgrade()` always returns
  `false`; Bun Guest WebSocket support is deferred. The Bun-facing Broker
  inherits Node's explicit VWS/1 `webSocket()` API, not generic upgrade support.
- **Single dependency chain** — `verser2-guest-bun` → `verser2-guest-node` →
  `verser2-guest-js-common` → `verser-common`.

## Data & Control Flow

### Bun Guest
```
createVerserBunGuest(options)
  │
  └── createVerserNodeGuest(options)    (from verser2-guest-node)
        │
        └── guest.attach(bunHandler, domain)
              │
              └── createNodeStyleHandler(domain, bunHandler)
                    │
                    ├── wrapped listener (req, res):
                    │     ├── create BunDispatchRequest from Node request
                    │     ├── dispatchVerserBunRequestInternal(handler, bunRequest)
                    │     │     ├── try routes (exact → param → wildcard)
                    │     │     │     └── resolveRoute() → route match
                    │     │     ├── try handler.fetch (catch-all)
                    │     │     └── 404 if neither matches
                    │     ├── toVerserBunResponse(webResponse)
                    │     └── writeResponseBody(ReadableStream → Node response)
                    │
                    └── nodeGuest.attach(wrappedListener, domain)
```

### Bun Broker
```
createVerserBroker(options)
  │
  └── createVerserNodeBroker(options)    (from verser2-guest-node)
        │
        └── broker.createFetch() ─► Bun-adapted fetch
              │
              ├── new Request(input, init)
              ├── resolveRouteForUrl(broker.getRoutes(), url)
              ├── nodeBroker.request({ targetId, method, path, headers, body })
              └── new Response(ReadableStream, { status, headers })
```

## Integration Points

- **`@signicode/verser2-guest-node`** — core transport (Guest lease pool, Broker
  route table, HTTP/2 session management); Bun packages provide only the handler
  adapter and fetch wrapper.
- **`@signicode/verser2-guest-js-common`** — shared types and helpers used
  indirectly through verser2-guest-node.
- **`@signicode/verser-common`** — route resolution (`resolveRouteForUrl`).
- **Bun runtime** — `Request`, `Response`, `ReadableStream`, `Headers` are
  Web-standard APIs available in Bun.

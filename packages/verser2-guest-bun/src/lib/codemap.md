# packages/verser2-guest-bun/src/lib/

## Responsibility

Contains the Bun-specific handler adapter, route matcher, types, and constants.

**Files:**

| File | Role |
|------|------|
| `adapter.ts` | `createNodeStyleHandler()` — converts a Bun-style handler (with `fetch` and/or `routes`) into a Node-style `(req, res) => void` listener. Contains `dispatchVerserBunRequestInternal()` for route dispatch and `writeResponseBody()` for streaming Web `ReadableStream` to Node response. |
| `routes.ts` | `resolveRoute()` — path-matcher implementing exact, `:param`, wildcard `*`, and per-method map routing. Returns matched value and extracted params (or `allow` header for 405). |
| `types.ts` | Bun-specific type definitions: `VerserBunGuest`, `VerserBunBunGuestOptions`, `VerserBunRequest`, `VerserBunRoutes`, `VerserBunRouteMethod`, `VerserBunRouteHandler`, `VerserBunRouteValue`, `VerserBunRoutesPerMethod`, `VerserBunGuestRequestHandler`, `VerserBunGuestServer`. Also re-exports Node Broker types. |
| `constants.ts` | `VERSER2_GUEST_BUN_PACKAGE_NAME` and `DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE`. |

## Design / Patterns

- **Adapter bridge** — `createNodeStyleHandler()` is the central adapter.
  It receives a Node-style `(req, res)` pair, constructs a Web `Request`
  from the raw method/url/headers/body, runs it through the Bun handler
  (`routes` → `fetch` fallback), then writes the resulting `Response` status,
  headers, and body stream back to the Node-style response.
- **Route resolution pipeline** — `resolveRoute()` processes routes in priority
  order: exact matches first, then `:param` patterns, then wildcard `*`.  Each
  entry may be a static `Response`, a handler `(request, server) => Response`,
  or a per-method map.  Method maps return a 405 with `Allow` header when the
  method doesn't match.
- **Streaming body** — The adapter converts the Node request body stream to a
  Web `ReadableStream` for Bun handler consumption, and converts the Web
  `ReadableStream` response back to Node `write()`/`end()` calls.
- **Lazy body access** — `VerserBunDispatchResponse` uses a getter for `.body`
  with access-mode tracking (`none` / `stream` / `text-json`) to enforce
  single-consumption semantics matching the Web `Response` contract.
- **Exact-path matching** — `tryMatchExactRoute()` does strict string equality.
- **Param matching** — `tryMatchParamRoute()` splits paths by `/`, compares
  segment by segment, and collects `:param` values with `decodeURIComponent`.
- **Wildcard matching** — `tryMatchWildcardRoute()` supports `*` (everything),
  `/*`, and `prefix/*` patterns.

## Data & Control Flow

### Handler dispatch
```
Node-style (req, res) ──► createNodeStyleHandler() wrapper
  │
  ├── build VerserBunDispatchRequest
  │     ├── method, path, origin, headers
  │     └── body: ReadableStream from req 'data'/'end' events
  │
  └── dispatchVerserBunRequestInternal(handler, request)
        │
        ├── try handler.routes
        │     └── resolveRoute(routes, path, method)
        │           ├── exact entries → tryMatchExactRoute
        │           ├── param entries → tryMatchParamRoute
        │           └── wildcard entries → tryMatchWildcardRoute
        │           └── per-method: resolveMethodRoute() → value or 405 Allow
        │
        ├── (fallback) try handler.fetch(request, server)
        │
        └── (default) 404 Not Found
              │
              └── toVerserBunResponse(webResponse)
                    ├── status, statusText, headers
                    ├── body: getter with access-mode tracking
                    ├── text(), json() methods
                    └── writeResponseBody(ReadableStream → res.write/end)
```

### Route matching priority
```
resolveRoute()
  │
  ├── 1. exact entries (tryMatchExactRoute)
  ├── 2. param entries (tryMatchParamRoute)
  └── 3. wildcard entries (tryMatchWildcardRoute)
        │
        each: resolveMethodRoute() if value is a method-map object
              → value for matched method
              → { allow: [...] } for 405 if no method match
```

## Integration Points

- **`@signicode/verser2-guest-node`** — `createNodeStyleHandler()` produces a
  `NodeRequestListener` that is passed to `nodeGuest.attach()`.
- **`@signicode/verser-common`** — route resolution (`resolveRouteForUrl`) used
  by the Bun Broker's `createFetch()` in `src/index.ts`.
- **Bun / Web APIs** — `Request`, `Response`, `Headers`, `ReadableStream`,
  `URL`, `TextEncoder` — all standard Web APIs available in Bun.

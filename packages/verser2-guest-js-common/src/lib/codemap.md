# packages/verser2-guest-js-common/src/lib/

## Responsibility

Contains the thin local implementations and re-export stubs that constitute
the runtime-neutral Guest foundations.

**Files:**

| File | Role |
|------|------|
| `types.ts` | Shared type definitions (`VerserRoute`, `VerserStreamChunkSource`, `AbstractRoute`). Most types re-exported from `@signicode/verser-common`. |
| `abstract-fetch-dispatcher.ts` | `AbstractVerserFetchDispatcher<TRequestBody, TResponseBody>` — abstract base that resolves routes by URL hostname and normalises Broker requests. |
| `headers.ts` | Re-exports `isValidHeaderName`, `isValidHeaderValue`, `flattenHeaderValue`, `normalizeHeaders` from `verser-common`. |
| `routes.ts` | Re-exports `resolveRouteForHostname`, `resolveRouteForUrl` from `verser-common`. |
| `url.ts` | `appendQueryString()` — local utility that appends query params to a path while handling existing query strings, array values, and null/undefined skips. |
| `utils.ts` | Re-exports `createCommonBrokerRequest` from `verser-common`. |
| `constants.ts` | `VERSER2_GUEST_JS_COMMON_PACKAGE_NAME` string constant. |
| `index.ts` | Barrel re-exporting the public API surface. |

## Design / Patterns

- **Thin re-export layer** — The majority of files are one-liners that re-export
  from `@signicode/verser-common`.  This avoids consumer packages depending
  directly on `verser-common` and provides a stable, versioned package boundary.
- **Abstract base class** — `AbstractVerserFetchDispatcher` uses the template-method
  pattern: concrete subclasses provide the request/response body type mapping
  while route resolution and request creation are handled here.
- **Pure functions** — `appendQueryString()` is a standalone pure utility with
  no class or framework coupling.

## Data & Control Flow

```
Consumer subclass of AbstractVerserFetchDispatcher
  │
  ├── resolveRouteForUrl(url) ─────────► resolveRouteForUrl(verser-common)
  │                                         │
  │                                         └── broker.getRoutes() (consumer provides broker)
  │
  └── createBrokerRequest(raw) ─────────► createCommonBrokerRequest(verser-common)
```

```
appendQueryString(path, query) ─────────► local implementation
                                              │
                                              ├── new URLSearchParams()
                                              ├── skip null/undefined
                                              ├── flatten arrays
                                              └── append ? or &
```

## Integration Points

- **`@signicode/verser-common`** — nearly all logic is delegated here.
- **`@signicode/verser2-guest-node`** — imports `AbstractVerserFetchDispatcher`
  indirectly via route helpers, `normalizeHeaders`, `appendQueryString`.
- **`@signicode/verser2-guest-bun`** — imports the same shared surface as
  guest-node, ensuring cross-runtime type compatibility.

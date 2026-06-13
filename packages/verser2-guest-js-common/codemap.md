# packages/verser2-guest-js-common/

## Responsibility

Provides runtime-neutral TypeScript foundations shared across adapter Guest
implementations (Node, Bun).  This package is a **re-export hub** that surfaces
common protocol types and utility functions from `@signicode/verser-common`
without pulling in runtime-specific dependencies.

Consumer packages (`verser2-guest-node`, `verser2-guest-bun`) depend on this
package for shared types (`VerserRoute`, `VerserCommonBrokerRequest`,
`VerserCommonBrokerResponse`, `VerserCommonBroker`, `VerserHeaderValue`,
`VerserHeaderInput`, `VerserStreamChunkSource`) and helpers
(`AbstractVerserFetchDispatcher`, `flattenHeaderValue`, `normalizeHeaders`,
`resolveRouteForHostname`, `resolveRouteForUrl`, `appendQueryString`,
`createCommonBrokerRequest`).

## Design / Patterns

- **Re-export pattern** — Most exports originate from `@signicode/verser-common`;
  this package simply re-exports them under a stable `@signicode/verser2-guest-js-common`
  package name. This avoids direct `verser-common` dependency coupling in consumers.
- **Abstract base class** — `AbstractVerserFetchDispatcher<TRequestBody, TResponseBody>`
  provides a common `resolveRouteForUrl()` and `createBrokerRequest()` so that
  runtime adapters (Node, Bun) only need to implement the body-type mapping.
- **Backwards-compatible barrel** — `src/index.ts` re-exports types and functions
  separately; `src/lib/index.ts` provides a secondary barrel for internal use.
- **Stream chunks** — `VerserStreamChunkSource<TChunk>` defines an `AsyncIterable`
  contract for chunk-at-a-time body consumption without full buffering.

## Data & Control Flow

```
Consumer code
    │
    ▼
@signicode/verser2-guest-js-common      (this package)
    │
    ├── re-exports types ───────────────────► @signicode/verser-common
    │
    └── re-exports helpers ─────────────────► @signicode/verser-common
         (flattenHeaderValue, normalizeHeaders,
          resolveRouteForHostname, resolveRouteForUrl,
          createCommonBrokerRequest)
         │
         ├── appendQueryString() ──────────► local implementation (url.ts)
         │
         └── AbstractVerserFetchDispatcher ─► local abstract class
```

No runtime code executes in this package at call time — all logic is delegated
to `verser-common` or to the concrete subclass in the consumer package.

## Integration Points

- **`@signicode/verser-common`** — sole dependency; all type definitions and
  most function implementations live there.
- **`@signicode/verser2-guest-node`** — consumes `AbstractVerserFetchDispatcher`
  (indirectly via route-resolution helpers), `normalizeHeaders`, `appendQueryString`.
- **`@signicode/verser2-guest-bun`** — consumes the same shared types and helpers
  as guest-node, providing uniform type identity across runtimes.

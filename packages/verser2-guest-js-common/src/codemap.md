# packages/verser2-guest-js-common/src/

## Responsibility

Serves as the public API barrel for the `@signicode/verser2-guest-js-common`
package.  `index.ts` re-exports types and functions from `./lib/` while the
bare `./lib/index.ts` barrel is used internally by sibling packages.

## Design / Patterns

- **Dual barrel** — `src/index.ts` is the public entry point (consumers import
  from `@signicode/verser2-guest-js-common`).  `src/lib/index.ts` is a secondary
  barrel that other in-repo packages may import directly.
- **Type-only re-exports** — Types are re-exported with `export type {...}`
  to avoid runtime side-effects.
- **Package constant** — `VERSER2_GUEST_JS_COMMON_PACKAGE_NAME` is exported
  at the top level for logging and error-message consistency.

## Data & Control Flow

```
src/index.ts
  │
  ├── export type VerserRoute                      (from ./lib/types)
  ├── export type VerserCommonBrokerRequest
  ├── export type VerserCommonBrokerResponse
  ├── export type VerserCommonBroker
  ├── export type VerserHeaderValue
  ├── export type VerserHeaderInput
  ├── export type VerserStreamChunkSource
  │
  ├── export AbstractVerserFetchDispatcher         (from ./lib)
  ├── export flattenHeaderValue                    (from ./lib)
  ├── export normalizeHeaders                      (from ./lib)
  ├── export resolveRouteForHostname               (from ./lib)
  ├── export resolveRouteForUrl                    (from ./lib)
  ├── export appendQueryString                     (from ./lib)
  └── export createCommonBrokerRequest             (from ./lib)
```

## Integration Points

- **`./lib/`** — all implementation lives in `src/lib/`; this file is purely a
  re-export facade.

# packages/verser2-guest-node/src/

## Responsibility

Public API barrel for `@signicode/verser2-guest-node`.  Exports the
`createVerserNodeGuest()` and `createVerserBroker()` factory functions,
the minimal HTTP classes (`MinimalIncomingMessage`, `MinimalServerResponse`),
and all public type definitions.

## Design / Patterns

- **Factory functions** — `createVerserNodeGuest()` and `createVerserBroker()`
  are the public constructors; concrete classes (`Http2VerserNodeGuest`,
  `Http2VerserBroker`) are not exported.
- **Type re-exports** — All public types are re-exported from `./lib/types`
  with individual JSDoc annotations.
- **Package constant** — `VERSER2_GUEST_NODE_PACKAGE_NAME` re-exported from
  `./lib/constants`.
- **Minimal HTTP classes** — `MinimalIncomingMessage` and `MinimalServerResponse`
  provide a lightweight HTTP/1-style request/response surface for local handlers.

## Data & Control Flow

```
src/index.ts
  │
  ├── export { VERSER2_GUEST_NODE_PACKAGE_NAME }                           (from ./lib/constants)
  │
  ├── export { MinimalIncomingMessage, MinimalServerResponse }             (from ./lib/minimal-http)
  │
  ├── export type { NodeRequestListener, VerserBroker, VerserBrokerOptions,
  │                 VerserBrokerRequest, VerserBrokerResponse,
  │                 VerserNodeGuestDispatchRequest, VerserNodeGuestDispatchResponse,
  │                 VerserNodeGuest, VerserNodeGuestLifecycleEvent,
  │                 VerserNodeGuestOptions }                                (from ./lib/types)
  │
  ├── export function createVerserNodeGuest(options) ─────────► new Http2VerserNodeGuest(options)
  │
  └── export function createVerserBroker(options)  ─────────► new Http2VerserBroker(options)
```

## Integration Points

- **`./lib/`** — all implementation lives in `src/lib/`; this file is purely a
  re-export and factory facade.

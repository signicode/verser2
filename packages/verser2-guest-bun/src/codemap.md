# packages/verser2-guest-bun/src/

## Responsibility

Public API barrel for `@signicode/verser2-guest-bun`.  Exports the
`createVerserBunGuest()` and `createVerserBroker()` factory functions,
all Bun-specific type definitions, and the `DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE`
constant.

## Design / Patterns

- **Wrapper factories** — `createVerserBunGuest()` wraps the Node Guest transport;
  `createVerserBroker()` wraps the Node Broker.  Both delegate most methods
  directly to the underlying Node instance.
- **Handler conversion** — `createVerserBunGuest().attach()` calls
  `createNodeStyleHandler()` from `./lib/adapter` to bridge Bun handler
  semantics to Node callback style, then passes the converted listener to
  `nodeGuest.attach()`.
- **Fetch override** — `createVerserBroker()` replaces the Node Broker's
  `createFetch()` with a Bun-adapted version that returns Web `Response`
  objects with `ReadableStream<Uint8Array>` bodies.
- **Type re-exports** — All public types re-exported from `./lib/types`,
  including re-exports of Node Broker types (`VerserBroker`, `VerserBrokerOptions`,
  `VerserBrokerRequest`, `VerserBrokerResponse`).
- **Package constant** — `VERSER2_GUEST_BUN_PACKAGE_NAME` from `./lib/constants`.

## Data & Control Flow

```
src/index.ts
  │
  ├── export { VERSER2_GUEST_BUN_PACKAGE_NAME }                          (from ./lib/constants)
  │
  ├── export type { VerserBroker, VerserBrokerOptions, VerserBrokerRequest,
  │                 VerserBrokerResponse, VerserBunGuest,
  │                 VerserBunGuestLifecycleEvent, VerserBunGuestOptions,
  │                 VerserBunRequest, VerserBunRoutes, VerserBunRouteMethod,
  │                 VerserBunRouteHandler, VerserBunRouteValue,
  │                 VerserBunRoutesPerMethod, VerserBunGuestRequestHandler }  (from ./lib/types)
  │
  ├── export function createVerserBunGuest(options)
  │     └── wraps createVerserNodeGuest(options) + bun handler adapter
  │
  └── export function createVerserBroker(options)
        └── wraps createVerserNodeBroker(options) + bun fetch adapter
```

## Integration Points

- **`./lib/`** — adapter, routes, types, constants; all implementation lives in
  `src/lib/`; this file is purely a factory and re-export facade.

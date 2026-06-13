# packages/verser2-host/src/

## Responsibility

Source root for the `@signicode/verser2-host` package. Aggregates and exports the Host public API through a single `index.ts` barrel file: the factory function `createVerserHost()`, the `VerserHost` interface, Host options/lifecycle types, and local Host peer attachment types.

## Design / Patterns

- **Factory function pattern** — `createVerserHost(options)` instantiates `NodeHttp2VerserHost`, the sole implementation. No class is exported directly; consumers interact only through the `VerserHost` interface.
- **Barrel export** — `index.ts` re-exports from `lib/` modules and from `@signicode/verser-common` (typed re-export of `VerserPeerRole`). Host lifecycle events, options, and the registration request type are re-exported for consumer convenience.
- **Interface-driven API** — `VerserHost` defines the full contract (`start`, `close`, `reloadTlsCertificate`, `getRoutedDomains`, `attachLocalGuest`, `attachLocalBroker`, `onLifecycle`, `running`, `address`). Internal implementation is fully encapsulated.
- **Local peer type exports** — The barrel re-exports `VerserLocalGuestRequestListener`, local Guest/Broker options, request/response shapes, and handle interfaces so consumers can type in-process Host peer attachment.
- **JSDoc with `@public` / `@internal`** — the factory function and all re-exported types are documented with full examples, parameter descriptions, and `@public` tags. Internal implementation class `NodeHttp2VerserHost` is marked `@internal`.

## Data & Control Flow

1. **Import time** — consumer calls `createVerserHost(options)` → `index.ts` imports `NodeHttp2VerserHost` from `lib/node-http2-verser-host` and types from `lib/types` → returns a new instance.
2. **Runtime** — the Host instance manages its own lifecycle: `start()` creates the HTTP/2 server, `close()` tears it down, `address` reflects the current bound state.
3. **Local peer runtime** — Consumers call `attachLocalGuest()` and `attachLocalBroker()` on the returned Host instance; these methods are runtime methods, not top-level exports.
4. **Type-only dependency** — `VerserPeerRole` is re-exported from `@signicode/verser-common` as a type-only import, avoiding runtime coupling.

## Integration Points

- **Entry module** — `index.ts` is the sole entry point (`main` in `package.json`). All public API flows through this file.
- **Delegates to** — `./lib/` modules for server implementation, I/O helpers, types, and utilities.
- **Depends on** — `@signicode/verser-common` for envelope encoding, registration parsing, TLS normalisation, lifecycle events, and error types.
- **Consumed by** — End-user applications that create and manage a Verser Host instance.

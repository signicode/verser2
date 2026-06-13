# packages/verser-common/src/

## Responsibility

Source root for the `@signicode/verser-common` package. Aggregates and re-exports all shared protocol types, constants, validation helpers, and runtime utilities through a single `index.ts` barrel file. Consumers import from `@signicode/verser-common` and never reference `src/lib/` directly.

## Design / Patterns

- **Barrel export pattern** — `index.ts` re-exports every public symbol from the `lib/` modules. No internal module is exposed directly.
- **Type + value co-exports** — both TypeScript types/interfaces and runtime values (functions, constants) are exported from the same barrel, enabling isolated type imports (`import type { ... }`) and value imports (`import { ... }`) as needed.
- **Namespaced by concern** — each `lib/` module focuses on one aspect: envelope encoding, routing, TLS, headers, registration, errors, etc. The barrel file groups related exports with JSDoc `@module` annotations.
- **No runtime adapters** — this package is runtime-neutral for types and protocol helpers. Node-specific stream and TLS utilities live here because `@signicode/verser-common` is a Node package, but the types themselves (`VerserCommonBroker`, `VerserEnvelopeMetadata`, etc.) are designed for cross-runtime use.

## Data & Control Flow

1. **Import time** — consumer imports from `@signicode/verser-common` → `index.ts` resolves → `lib/` modules execute their top-level declarations (constants, function definitions) → exports are available.
2. **No init/startup** — the package is purely functional/stateless. All functions are pure or accept explicit state (e.g., envelope parser returns a stateful `{ push() }` object). There is no global state or singleton.
3. **JSDoc authoring** — every export in `index.ts` carries a complete JSDoc block that documents purpose, parameters, return types, thrown errors, and `@public` visibility.

## Integration Points

- **Entry module** — `index.ts` is the sole entry point (`main` in `package.json`). All public API flows through this file.
- **Delegates to** — `./lib/` modules for all implementation. The barrel file is pure re-export with JSDoc.
- **Consumed by** — Host (`@signicode/verser2-host`), Guest Node (`@signicode/verser2-guest-node`), Guest JS Common (`@signicode/verser2-guest-js-common`), and any third-party adapter.
- **Tree-shakeable** — individual function/constant imports are supported by the module structure.

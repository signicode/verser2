# Track: Split package sources while preserving single-file dist artifacts

## Goal

Refactor package source files into maintainable `src/lib/*` modules and extracted type files while preserving the public package entrypoints and producing a single bundled `dist/index.js` plus `dist/index.d.ts` per package.

## Constraints

- Preserve runtime public API keys asserted by `test/packages.test.js`.
- Keep `src/index.ts` as each package's explicit public entrypoint.
- Do not change Host, Guest, Broker, Peer protocol behavior.
- Use npm only.
- Document bundler tooling in `conductor/tech-stack.md` before implementation.
- No commits, branches, pushes, or PRs unless explicitly requested by the user.

## Phase 1: Build artifact guardrails and tooling

- [x] Update tests to assert package dist artifacts remain single-entrypoint bundles.
- [x] Update tests that scan source to include split `src/**/*.ts` files.
- [x] Add single-file bundling tooling and scripts.
- [x] Validate with `npm run build` and `node --test test/packages.test.js`.

## Phase 2: Common and JS-common package split

- [x] Split `@signicode/verser-common` into `src/lib/types.ts`, domain modules, and `src/lib/utils.ts`.
- [x] Split `@signicode/verser2-guest-js-common` into `src/lib/types.ts`, domain modules, and `src/lib/utils.ts`.
- [x] Preserve explicit package root exports.
- [x] Validate focused common/package tests.

## Phase 3: Host package split

- [x] Split `@signicode/verser2-host` into `src/lib/types.ts`, Host implementation, protocol helpers, HTTP/2 IO helpers, and local utilities.
- [x] Keep `NodeHttp2VerserHost` internal.
- [x] Validate host and routing tests.

## Phase 4: Node guest package split

- [x] Split `@signicode/verser2-guest-node` into `src/lib/types.ts`, minimal HTTP, Guest, Broker, Agent, Socket, Dispatcher, controller, and helper modules.
- [x] Avoid circular imports by depending on small interfaces from `types.ts`.
- [x] Preserve explicit package root exports.
- [x] Validate guest-node, agent, dispatcher, and end-to-end tests.

## Phase 5: Final validation

- [x] Run `npm test`.
- [x] Run `npm run lint`.
- [x] Run coverage or record why unavailable.
- [x] Record deduplication result and validation notes.

## Notes

- @librarian confirmed `tsc` cannot bundle CommonJS modules into one file; use a bundler such as tsup for JS and declaration rollup.
- @oracle recommended mechanical source splits first, explicit root exports, and no broad `export *` from implementation files.
- Added `tsup` for single-file CommonJS JS bundles and `dts-bundle-generator` for single-file declarations. `dts-bundle-generator` emits a composite-project warning during package builds, but generated declarations pass its checker and package tests assert the single-file dist shape.
- @oracle review findings were addressed by restoring Node Guest factory return types to public interfaces, using Undici `fetch` typing/runtime, removing internal Node Guest type exports from the root entrypoint, and adding declaration leakage assertions.
- Deduplication check: common behavior remained in `@signicode/verser-common`; package-local helpers were split by domain. Duplicate helper copies introduced during the mechanical split were removed for `activeLeaseKey` and `appendQueryString`.
- Validation: `npm test` passed 81/81 tests; `npm run lint` passed; `npm run test:coverage` passed with 95.15% line coverage overall.

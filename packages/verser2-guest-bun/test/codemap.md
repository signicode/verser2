# packages/verser2-guest-bun/test/

## Responsibility

Contains Bun-facing package test assets when Bun-specific runtime tests are added.
The current repository validates Bun adapter behavior primarily through root
Node tests and documentation assertions.

## Design

- Reserved test directory colocated with the Bun package.
- Intended for runtime-specific tests that cannot live in root `node:test` suites.

## Flow

Future Bun test files should import package entrypoints, create Bun handler
objects, and verify adapter behavior against the shared Host/Broker transport.

## Integration

- Complements root tests under `test/`.
- Depends on `@signicode/verser2-guest-bun` source and package build outputs.

# Specification: Setup Monorepo

## Overview

Set up the initial npm workspace monorepo for `verser2` so future Host and Guest packages can be implemented consistently. This track establishes repository tooling, TypeScript configuration, package layout, test/lint/build commands, and minimal package entrypoints without implementing the full Host/Guest runtime protocol.

## Goals

- Create a root npm workspace configured for `packages/*`.
- Add strict TypeScript configuration targeting ES2019 CommonJS with declaration output.
- Add Biome configuration for linting and formatting.
- Add initial package directories for `@signicode/verser2-host` and `@signicode/verser2-guest-node`.
- Add minimal package manifests and source entrypoints that compile.
- Add a test setup and smoke tests proving the initial packages are wired correctly.
- Ensure `npm run build`, `npm run test`, and `npm run lint` are available.

## Non-Goals

- Implement full HTTP/2 multiplexing.
- Implement HTTP/3 support.
- Implement request routing between Host and Guest.
- Implement non-TypeScript guest packages.
- Publish packages to npm.

## Acceptance Criteria

- The repository contains a valid root `package.json` with npm workspaces under `packages/*`.
- The repository contains TypeScript, test, and Biome configuration aligned with `conductor/tech-stack.md`.
- `packages/verser2-host` and `packages/verser2-guest-node` exist with buildable TypeScript source.
- Root npm scripts exist for `build`, `test`, and `lint`.
- Tests cover initial package exports or placeholder constructors/functions.
- The changed behavior meets the workflow's 95% coverage expectation where measurable.
- Generated package structure follows `conductor/code_styleguides/typescript.md`.

## Risks and Constraints

- Keep implementation minimal so this setup track does not accidentally design runtime protocol behavior.
- Avoid adding compatibility code for future runtimes before concrete package needs exist.
- Keep package names and terminology aligned with the repository's Host, Guest, Broker, and Peer nomenclature.

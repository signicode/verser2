# Plan: Setup Monorepo

## Phase 1: Root Workspace and Tooling

- [x] Task: Define root npm workspace configuration
    - [x] Write tests or validation checks for expected workspace package discovery where practical.
    - [x] Create root `package.json` with `packages/*` workspaces and core scripts.
- [x] Task: Add TypeScript and Biome configuration
    - [x] Write or update validation expectations for build and lint commands.
    - [x] Add strict CommonJS TypeScript configuration targeting ES2019 with declaration output.
    - [x] Add Biome configuration aligned with the TypeScript style guide.
- [x] Task: Configure test tooling
    - [x] Write a minimal failing smoke test target before implementation.
    - [x] Add the test runner configuration and root `npm run test` script.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Root Workspace and Tooling' (Protocol in workflow.md)

Phase 1 validation notes:

- Confirmed `npm test` failed before implementation because `package.json` did not exist.
- `npm test` passes after adding root workspace and configuration smoke tests.
- `npm run lint` initially failed on formatting for new files and generated `conductor/setup_state.json`; fixed new-file formatting and excluded the generated setup state file from Biome.
- `npm run lint` passes after fixes.
- Coverage is not line-measured for Phase 1 because changed behavior is configuration/script wiring; smoke tests cover the measurable expectations.
- Phase 1 checkpoint commit: `ae5e5c2`.

## Phase 2: Initial Packages

- [x] Task: Create `verser2-host` package scaffold
    - [x] Write tests for the initial host package export.
    - [x] Add package manifest, source entrypoint, and build configuration for `packages/verser2-host`.
- [x] Task: Create `verser2-guest-node` package scaffold
    - [x] Write tests for the initial Node guest package export.
    - [x] Add package manifest, source entrypoint, and build configuration for `packages/verser2-guest-node`.
- [x] Task: Validate cross-package build and test behavior
    - [x] Run root build, test, and lint commands.
    - [x] Fix any session-introduced validation failures according to the workflow continuation protocol.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Initial Packages' (Protocol in workflow.md)

Phase 2 validation notes:

- Confirmed package tests failed before implementation because package manifests and built entrypoints did not exist.
- `npm install` updated the lockfile for workspace package links.
- `npm run build`, `npm test`, and `npm run lint` pass.
- Package smoke tests cover the measurable placeholder export behavior added in this phase.
- Manual verification feedback removed artificial `create*Info()` functions in favor of simple package-name constants that do not imply a future runtime API.
- Phase 2 checkpoint commit: `98589bb`.

## Phase 3: Documentation Alignment

- [x] Task: Update project documentation for setup commands
    - [x] Write or update documentation expectations for install, build, test, and lint commands.
    - [x] Update `README.md` or package docs with the established workspace commands.
- [x] Task: Confirm Conductor artifacts match implemented setup
    - [x] Review `product.md`, `tech-stack.md`, and `workflow.md` for any needed updates.
    - [x] Update Conductor artifacts only if implementation decisions changed documented project context.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Documentation Alignment' (Protocol in workflow.md)

Phase 3 validation notes:

- Confirmed documentation test failed before implementation because README did not include setup commands.
- Added README development setup documentation for `npm install`, `npm run build`, `npm test`, and `npm run lint`.
- Reviewed Conductor product, tech stack, and workflow documents; they already match the implemented setup, so no Conductor context updates were needed in this phase.
- `npm run build`, `npm test`, and `npm run lint` pass.
- Documentation expectations are covered by the README smoke test.

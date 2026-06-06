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

## Phase 2: Initial Packages

- [ ] Task: Create `verser2-host` package scaffold
    - [ ] Write tests for the initial host package export.
    - [ ] Add package manifest, source entrypoint, and build configuration for `packages/verser2-host`.
- [ ] Task: Create `verser2-guest-node` package scaffold
    - [ ] Write tests for the initial Node guest package export.
    - [ ] Add package manifest, source entrypoint, and build configuration for `packages/verser2-guest-node`.
- [ ] Task: Validate cross-package build and test behavior
    - [ ] Run root build, test, and lint commands.
    - [ ] Fix any session-introduced validation failures according to the workflow continuation protocol.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Initial Packages' (Protocol in workflow.md)

## Phase 3: Documentation Alignment

- [ ] Task: Update project documentation for setup commands
    - [ ] Write or update documentation expectations for install, build, test, and lint commands.
    - [ ] Update `README.md` or package docs with the established workspace commands.
- [ ] Task: Confirm Conductor artifacts match implemented setup
    - [ ] Review `product.md`, `tech-stack.md`, and `workflow.md` for any needed updates.
    - [ ] Update Conductor artifacts only if implementation decisions changed documented project context.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Documentation Alignment' (Protocol in workflow.md)

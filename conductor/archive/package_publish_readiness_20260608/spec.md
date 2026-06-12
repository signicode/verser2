# Specification: Package buildability and publish readiness

## Overview

Prepare the `verser2` npm workspace packages to be built, staged, packed, published to GitHub Packages, and consumed as built packages. The track should prove that the local repo can produce npm-publishable artifacts without changing the existing Host/Guest/Broker runtime APIs or replacing the current TypeScript/tsup build approach.

The primary release path is GitHub Packages first: build once, stage publish-ready package directories under a central `dist/packages` tree, create packable artifacts, test those artifacts through consumer-style tests, publish to GitHub Packages, and validate package installation from GitHub Packages. npmjs publishing remains out of scope for execution in this track, but the workflow should preserve a clear future path for npm publishing with `latest` and `next` dist-tags.

## Track Type

Feature / release engineering infrastructure.

## Goals

- Make every current TypeScript/Node workspace package publish-ready as a fully built npm package.
- Add a central staged package output at `dist/packages/<package-name-or-safe-name>/`.
- Generate publish-only package metadata for staged packages, removing unneeded scripts, test commands, dev-only fields, and local development configuration.
- Ensure JavaScript entrypoints and TypeScript declaration fields point to the correct staged build artifacts.
- Add versioning and tagging support for stable and prerelease flows:
  - stable versions publish with the `latest` tag;
  - prerelease versions publish with the `next` tag;
  - main-merge GitHub Packages builds may publish or update only the latest main build using a `<current-version>-sha` style version.
- Add package-consumer tests that can target:
  - workspace source packages;
  - central staged package directories;
  - tarballs produced from staged packages;
  - packages installed from GitHub Packages.
- Prove import compatibility for each published package from:
  - CommonJS `require` consumers;
  - ESM `.mjs` import consumers;
  - TypeScript import/type-check consumers.
- Add GitHub Actions automation for main/tag workflows that builds, stages, packs, tests, and publishes to GitHub Packages according to the selected version/tag policy.
- Keep the solution low-dependency and npm-only.

## Functional Requirements

1. Build and staging
   - The existing `npm run build` package build behavior must remain valid.
   - A new staging command must create central publish directories under `dist/packages`.
   - Staging must include built JavaScript, TypeScript declarations, and required package files such as README/LICENSE when available.
   - Staging must fail clearly if a package is missing required publish artifacts.

2. Publish package metadata
   - Staged `package.json` files must be generated or transformed into publish-only metadata.
   - Staged metadata must retain publish-critical fields such as `name`, `version`, `description`, `license`, `repository`, `main`, `types`, `exports`, runtime dependencies, and package manager-compatible metadata needed for consumers.
   - Staged metadata must remove test scripts, development scripts, dev-only fields, workspace-only settings, and unnecessary local configuration.
   - Declaration paths must resolve correctly for staged and packed consumers.

3. Version and dist-tag workflow
   - The implementation must support stable and prerelease version flows.
   - Stable releases should map to the `latest` dist-tag.
   - Prereleases should map to the `next` dist-tag.
   - Main-merge GitHub Packages publishing should use a deterministic `<current-version>-sha` style package version and avoid accumulating a publish for every commit beyond the latest main merge policy.
   - npmjs publish execution is out of scope, but scripts/workflow boundaries should avoid blocking future npm publishing.

4. Consumer test source selection
   - Tests must be configurable to target workspace source, central staged directories, packed tarballs, or GitHub Packages installs.
   - The package source selector must be documented and usable from npm scripts or CI.
   - Tests must verify all current packages: `@signicode/verser-common`, `@signicode/verser2-host`, and `@signicode/verser2-guest-node`.

5. Import compatibility tests
   - CommonJS consumers must be able to load each package.
   - ESM `.mjs` consumers must be able to import each package.
   - TypeScript consumers must be able to import each package and type-check against emitted declarations.
   - Tests should exercise package entrypoints without requiring changes to public Host/Guest/Broker APIs.

6. GitHub Packages workflow
   - Add a GitHub Actions workflow that builds, stages, packs, tests, and publishes to GitHub Packages for appropriate main/tag events.
   - The workflow must use npm and GitHub Packages authentication patterns compatible with scoped packages.
   - The workflow must document required permissions/secrets, including package write permissions.
   - The workflow must validate installed packages from GitHub Packages after publish where feasible.

7. Documentation
   - Document local staging, packing, source-targeted testing, version bumping, GitHub Packages publishing, and future npmjs publishing steps.
   - Documentation must use the repo terminology precisely and should not imply changes to HTTP/1, HTTP/2, Host, Guest, Broker, Peer, routing, or streaming behavior.

## Non-Functional Requirements

- Use npm only; do not introduce non-npm package managers.
- Prefer shell/Node scripts and existing tooling over release-management dependencies.
- Preserve strict TypeScript behavior and generated declaration compatibility.
- Keep generated `dist/` artifacts ignored and out of source control.
- Fail fast with actionable errors when package artifacts, metadata, registry configuration, or authentication are missing.
- Avoid hardcoded secrets and avoid committing registry tokens.

## Acceptance Criteria

- `npm run build` succeeds.
- A staging command creates publish-ready package directories under `dist/packages` for all current packages.
- Staged package metadata excludes development/test scripts and retains correct runtime package fields.
- `npm pack` can create tarballs from staged package directories.
- Consumer tests pass against staged directories and tarballs.
- Consumer tests include CommonJS, ESM `.mjs`, and TypeScript import/type-check coverage for all current packages.
- GitHub Actions workflow exists for build/stage/pack/test and GitHub Packages publish/validation according to the selected main/tag version policy.
- Documentation explains how to test against source, staging, tarballs, and GitHub Packages.
- No public runtime API changes are required for Host, Guest, Broker, or common package consumers.

## Out of Scope

- Publishing to npmjs during this track.
- Changing public Host/Guest/Broker runtime APIs.
- Replacing the existing TypeScript/tsup build approach.
- Adding release-management dependencies unless explicitly justified and approved.
- Implementing HTTP/2 multiplexing, new routing behavior, HTTP/3, authentication, authorization, or non-TypeScript guests.
- Committing generated `dist/` package artifacts or packed tarballs.

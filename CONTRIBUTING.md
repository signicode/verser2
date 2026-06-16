# Contributing to Verser2

Thanks for helping improve `verser2`. This project uses a spec-driven, test-driven workflow and precise Host/Guest/Broker terminology.

## Product boundaries

- **Host** accepts outbound Guest and Broker connections and routes requests to advertised Guest routes.
- **Guest** connects outbound to a Host and exposes a local handler without opening an inbound listener port.
- **Broker** connects outbound to a Host and sends requests to advertised Guest routes.
- **Peer** is shared terminology for connected clients; direct peer-to-peer behavior is not implemented.

Do not describe HTTP/3, browser, Rust, Go, Java, or Python Host behavior as implemented. Do not position Verser2 as a complete public gateway; applications remain responsible for authentication, authorization, and routing policy.

## Development setup

Prerequisites:

- Node.js `>=20`
- npm
- `uv` for Python package work under `packages/verser2-guest-python`

Install dependencies:

```sh
npm ci
```

Build all packages:

```sh
npm run build
```

Run validation:

```sh
npm run lint
npm test
```

Package-specific release-engineering checks:

```sh
npm run stage:packages
npm run test:package-consumers -- --source=staging
npm run test:package-consumers -- --source=tarball
npm run test:package-tarballs
```

## Workflow expectations

- Follow the active Conductor track in `conductor/tracks.md` when contributing to planned work.
- Write or update focused tests before behavior changes.
- Prefer small, reviewable pull requests.
- Reuse shared code from `@signicode/verser-common` before adding package-local helpers.
- Keep generated output such as `dist/`, caches, local certificates, and dependency folders out of commits.
- Use npm for repository JavaScript commands; use `uv` only for Python package commands.

## Pull requests

Before opening or updating a pull request:

- External contributors must add a DCO-style signoff to each commit with `git commit --signoff` or `git commit -s`. Pull requests from `MichalCz` or the configured Signicode maintainer team are exempt.
- Run the narrowest validation that proves the change.
- Update docs when public behavior, package metadata, release workflow, or user-facing APIs change.
- Confirm Host/Guest/Broker terminology is precise.
- Note skipped validation and why it was safe to skip.
- Keep release, secret, repository-visibility, branch-protection, and first-public-publish actions as maintainer-controlled manual gates.

## Security issues

Do not file public issues for vulnerabilities. Follow [`SECURITY.md`](./SECURITY.md) instead.

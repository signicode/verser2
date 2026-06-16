# Open sourcing checklist

This checklist captures the current repository state and the work to complete before making `signicode/verser2` public and accepting outside contributors.

## Current state snapshot

- Repository: `signicode/verser2` on GitHub.
- Visibility: private.
- Default branch: `main`.
- GitHub features: Issues and Projects are enabled; Wiki and Discussions are disabled.
- Merge methods: merge commits, squash merges, and rebase merges are all allowed.
- Delete branch on merge: disabled.
- License detected by GitHub: MIT.
- Branch protection: not verifiable through the current private-repository API response; confirm manually before publishing.
- GitHub security features: Dependabot alerts and secret scanning are disabled; code scanning requires GitHub Advanced Security while the repository remains private.
- Existing workflow: `.github/workflows/package-publish.yml` validates packages on selected pull requests and publishes to GitHub Packages on `main` and `v*` tags.

## Publish decision gates

- [x] Decide whether open sourcing means source visibility only, GitHub Packages publishing, npmjs.org publishing, PyPI publishing, or all of these. Current repository-file support covers public source readiness, GitHub Packages previews/releases, and maintainer-gated npmjs.org publishing; PyPI remains out of scope.
- [x] Decide whether `conductor/`, `opencode.jsonc`, and `.slim/` should stay public, move to private tooling, or be documented as internal project-management/tooling artifacts. `opencode.jsonc` is removed from the current tree; `conductor/` remains public with older archived plans summarized as outcomes; `.slim/` remains public.
- [x] Decide whether package publication remains under `@signicode` and whether public package names are final. Repository metadata and workflows keep the `@signicode` scope.
- [x] Confirm every roadmap claim is still accurate; do not imply HTTP/3, browser, Rust, Go, Java, or Python Host implementations are shipped.
- [x] Confirm the README states that applications remain responsible for authentication, authorization, and routing policy.

## Safety precautions before changing visibility

- [ ] Run a full secret scan on the complete git history, not only the working tree.
- [x] Treat `test/fixtures/generated-tls/` certificates and keys as test-only; document this if they remain in the public repo.
- [ ] Review commit history for credentials, private hostnames, customer names, private URLs, unpublished business plans, and personal data. Suggested command: `docker run --rm -v $(pwd):/repo ghcr.io/gitleaks/gitleaks:latest detect --source=/repo --verbose --report-path=/tmp/gitleaks-report.json`.
- [x] Review `conductor/` for internal planning details that should not be public.
- [x] Review `.github/workflows/package-publish.yml` and all scripts for tokens, registry assumptions, and publish side effects.
- [ ] Confirm `.gitignore` excludes generated output (`dist/`, coverage, virtualenvs, caches, local cert locks, and dependency folders).
- [ ] Rotate any credential that ever appeared in the repository, even if it was later removed.
- [ ] Make the repository public only after branch protection, required checks, and security scanning are configured.

## Licensing and attribution

Current state:

- Root `LICENSE` exists and uses MIT.
- Each workspace package includes a copied `LICENSE` file.
- Every JavaScript package declares `"license": "MIT"`.
- `packages/verser2-guest-python/pyproject.toml` declares MIT license text.
- No `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`, or `CODE_OF_CONDUCT.md` file is present.

Checklist:

- [ ] Confirm MIT is the intended license for source, JavaScript packages, and the Python package.
- [x] Add `NOTICE` if any dependency or bundled asset requires attribution beyond MIT license text. No `NOTICE` file is currently required because no bundled third-party source/assets needing extra attribution were identified.
- [x] Add `CONTRIBUTING.md` with development setup, test commands, coding style, issue/PR expectations, and release boundaries.
- [x] Add `SECURITY.md` with vulnerability reporting contact, supported versions, and disclosure expectations.
- [x] Add `CODE_OF_CONDUCT.md`, such as Contributor Covenant.
- [ ] Confirm third-party licenses for npm and Python dependencies are compatible with MIT distribution.

## Package readiness checks

Root workspace:

- [ ] Keep root `package.json` private if it is only a monorepo aggregator.
- [ ] Add root `repository`, `homepage`, `bugs`, and `keywords` if npm package metadata or repo discoverability should use them.
- [ ] Confirm Node engine requirement remains `>=20`.

All JavaScript workspace packages:

- [x] Remove `"private": true` before public npm publishing, or keep it if GitHub source release is the only goal. Source workspace manifests keep `private: true`; staged publish manifests omit it before packing/publishing.
- [x] Add `publishConfig` for the intended registry and access level.
- [x] Add `repository`, `homepage`, `bugs`, `keywords`, and `engines` metadata.
- [ ] Confirm `main` and `types` point to built files included in package tarballs.
- [ ] Confirm each package README is consumer-facing and has links that work after `scripts/stage-packages.js` rewrites them.
- [ ] Run `npm run build`, `npm run stage:packages`, `npm run test:package-consumers`, and `npm run test:package-tarballs` before first public publish.

Per-package notes:

| Package | Current state | Open-source checks |
| --- | --- | --- |
| `@signicode/verser-common` | `private: true`, MIT, CJS/types output. | Confirm shared protocol API surface is stable enough; add package metadata and public publish config. |
| `@signicode/verser2-host` | `private: true`, MIT, depends on `@signicode/verser-common`. | Confirm Host security docs describe TLS/mTLS and authorization boundaries; add package metadata and public publish config. |
| `@signicode/verser2-guest-js-common` | `private: true`, MIT, runtime-neutral JavaScript foundations. | Confirm only intended adapter foundations are exported; add package metadata and public publish config. |
| `@signicode/verser2-guest-node` | `private: true`, MIT, depends on `undici`. | Confirm Broker, Agent, Dispatcher, and fetch helper docs match exported APIs; add package metadata and public publish config. |
| `@signicode/verser2-guest-bun` | `private: true`, MIT, has Bun adapter tests. | Confirm Bun examples and compatibility notes are current; add package metadata and public publish config. |
| `@signicode/verser2-guest-python` | npm wrapper is `private: true`; Python project is MIT and requires Python `>=3.11`. | Decide whether public distribution is npm wrapper, PyPI, GitHub Release artifact, or multiple channels; add `project.urls` in `pyproject.toml`. |

## Workflow triggering and release controls

Current `.github/workflows/package-publish.yml` behavior:

- Pull requests to `main` run only when configured source/package/test/workflow paths change.
- Pushes to `main` run validation and publish SHA-derived versions to GitHub Packages with the `next` dist-tag.
- Tags matching `v*` run validation and publish tag-derived versions to GitHub Packages with the policy-selected dist-tag.
- Pull requests never publish.
- Publishing uses `secrets.GITHUB_TOKEN`, `packages: write`, and `npm publish --access restricted --registry https://npm.pkg.github.com`.
- Python distributions are uploaded as workflow artifacts and attached to GitHub Releases for `v*` tags; no PyPI publish exists.

Checklist:

- [x] Add a separate always-on PR CI workflow for build, tests, lint, package consumer checks, and package tarball checks.
- [x] Revisit PR `paths` filters; current filters can skip docs-only, root config, or governance changes that should still receive basic checks.
- [x] Add `workflow_dispatch` for explicit release dry runs if maintainers need manual validation.
- [ ] Pin or audit third-party GitHub Actions (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `astral-sh/setup-uv`, `softprops/action-gh-release`).
- [ ] Use environments or required reviewers for publishing jobs.
- [ ] Confirm `packages: write` and `contents: write` are granted only to publish jobs, not validation jobs.
- [x] If publishing to npmjs.org, change registry configuration, add `NPM_TOKEN`, and update `scripts/package-version-policy.js` where `NPMJS_PUBLISH_ALLOWED` is currently false. Manual setup of `NPM_TOKEN` or trusted publishing remains required.
- [ ] If publishing to PyPI, add trusted publishing or scoped API token release steps for `packages/verser2-guest-python`.
- [ ] Add release notes validation and changelog requirements before tag publishing.

## GitHub repository safeguards

- [ ] Make `main` branch protection explicit before public launch.
- [ ] Require pull requests before merge.
- [ ] Require status checks for build, tests, lint, package staging, package consumer tests, and tarball tests.
- [ ] Require conversation resolution and at least one approving review.
- [ ] Restrict who can push tags matching `v*` or create releases.
- [ ] Enable delete branch on merge if that matches maintainer workflow.
- [ ] Decide which merge method to allow; allowing all three is flexible but can make history conventions inconsistent.
- [x] Enable Dependabot alerts and add `.github/dependabot.yml` for npm and GitHub Actions. Dependabot alerts still require repository setting enablement.
- [ ] Enable secret scanning after making the repository public, and enable push protection if available.
- [x] Enable CodeQL or another code scanning workflow for TypeScript and Python.
- [x] Add `.github/CODEOWNERS` for package, docs, scripts, and workflow ownership.
- [x] Add issue templates and a pull request template.
- [ ] Consider enabling Discussions only if maintainers intend to support community Q&A there.

## Code safeguards

Current state:

- TypeScript is strict and uses project references.
- Biome is configured for linting and formatting (`npm run lint`).
- Tests use Node `node:test`; Python package has `unittest` and syntax checks through `compileall`.
- Package staging, consumer import checks, and tarball behavior tests exist.
- No pre-commit hook configuration is present.
- No secret scanning configuration is present.
- No CodeQL, Dependabot, dependency review, or security scanning workflow is present.

Checklist:

- [ ] Add a local pre-commit or pre-push path for `npm run lint` and focused tests.
- [x] Add repository-level secret scanning configuration such as Gitleaks or TruffleHog for CI and local use.
- [x] Add CodeQL, Semgrep, or equivalent static analysis for TypeScript and Python.
- [x] Add dependency review for pull requests.
- [ ] Add CI coverage reporting only if maintainers will enforce it.
- [ ] Keep `dist/` and generated build artifacts out of source commits.
- [ ] Add a documented maintainer checklist for changing public API exports.
- [ ] Add a compatibility checklist for Node, Bun, and Python runtime support before releases.

## Documentation and community readiness

Current state:

- Root `README.md`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`, and task-focused docs under `docs/` are present.
- Package publishing is documented in `docs/package-publishing.md` and `docs/release-procedure.md`.
- Examples exist for Node/Bun/Python usage, including a Bun gateway example.

Checklist:

- [ ] Add CI and package status badges only after the public workflow names are stable.
- [ ] Add a short “supported runtimes” section that distinguishes implemented runtimes from roadmap runtimes.
- [ ] Add contribution labels and triage guidance for issues.
- [ ] Add a maintainer-facing release checklist that references this open-source checklist, package publishing docs, and security review.
- [ ] Confirm docs never position Verser2 as a complete public gateway or a replacement for application-owned auth and routing policy.

## Final pre-publication runbook

1. Complete secret/history review and rotate exposed credentials if any are found.
2. Add missing governance files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and optional `NOTICE`.
3. Configure branch protection and required CI checks on `main`.
4. Enable Dependabot, secret scanning, and code scanning appropriate for the repository visibility and GitHub plan.
5. Decide package publishing targets and update package metadata accordingly.
6. Run `npm ci`, `npm run lint`, `npm test`, and package publish dry-run checks.
7. Review GitHub repository settings, topics, description, homepage, merge policy, Discussions, and branch deletion policy.
8. Make the repository public.
9. Confirm public README rendering, license detection, workflows, issues, and package links.
10. Announce only after the first public CI run is green.

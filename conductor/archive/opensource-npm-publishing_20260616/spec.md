# Specification: Open source readiness and full npm publishing

## Overview

Prepare `verser2` for public open sourcing and full package publishing while preserving repository safety, release control, and the project’s Host/Guest/Broker terminology and product boundaries.

This track completes the practical work from `docs/opensource-checklist.md` in a hybrid manual/automated mode:

- Automate repository-file changes such as package metadata, workflow configuration, governance docs, security configuration, and publishing documentation.
- Leave GitHub repository settings, secrets, and the first public release/publish as explicit manual maintainer gates.
- Support dual registry behavior: public npmjs.org publication for the JavaScript workspace packages and continued GitHub Packages publication for preview/internal builds.

## Track type

Chore / release-readiness.

## Functional requirements

1. Open-source governance files
   - Add contributor-facing governance documents required for public collaboration:
     - `CONTRIBUTING.md`
     - `SECURITY.md`
     - `CODE_OF_CONDUCT.md`
     - `NOTICE` if dependency/license review requires it, otherwise record why it is not needed.
   - Keep guidance consistent with the repository workflow, npm-only JavaScript commands, `uv` for Python package work, and Verser2 product terminology.

2. Package metadata and npm publishing readiness
   - Update JavaScript workspace package metadata for public npm publishing where appropriate:
     - remove package-level `private: true` blockers for publishable packages,
     - add `repository`, `homepage`, `bugs`, `keywords`, `engines`, and `publishConfig` metadata,
     - preserve root workspace `private: true` unless there is a concrete reason to publish the root package.
   - Keep package names under the `@signicode` scope unless maintainers choose otherwise during manual release setup.
   - Update package staging/publish scripts if needed so staged manifests remain correct for public npmjs.org and GitHub Packages workflows.
   - Update `scripts/package-version-policy.js` so npmjs.org publication is intentionally supported instead of blocked, with safeguards for stable/prerelease dist-tags.

3. Dual-registry release workflow
   - Keep GitHub Packages publishing available for preview/internal builds.
   - Add or adjust GitHub Actions so public npmjs.org publication can be performed safely through a maintainer-controlled release path.
   - Keep pull request validation non-publishing.
   - Ensure publish jobs require manual secrets or trusted publishing setup and cannot run accidentally from ordinary pull requests.
   - Document manual setup for npmjs.org token/trusted publishing, GitHub environments, required reviewers, and any package access settings.

4. Safety and repository safeguards
   - Add repository-file support for safety checks such as secret scanning configuration, dependency update configuration, code scanning workflow, dependency review, and/or equivalent lightweight safeguards.
   - Document manual GitHub settings that cannot be reliably changed from repository files, including branch protection, required checks, tag/release restrictions, secret scanning, Dependabot alerts, and repository visibility change order.
   - Ensure test-only certificates and keys are clearly identified as test fixtures if they remain in the public repository.

5. CI and validation
   - Add or refine CI so build, lint, tests, package staging, package consumer checks, and package tarball checks run on relevant pull requests.
   - Avoid over-restrictive workflow path filters that skip important governance, docs, workflow, or package metadata changes.
   - Keep release/publish validation aligned with existing commands:
     - `npm run build`
     - `npm run stage:packages`
     - `npm run test:package-consumers -- --source=staging`
     - `npm run test:package-consumers -- --source=tarball`
     - `npm run test:package-tarballs`
     - `npm run lint`
     - `npm test` where broad validation is needed.

6. Documentation updates
   - Update `docs/opensource-checklist.md` as work is completed, preserving remaining manual gates.
   - Update `docs/package-publishing.md` and `docs/release-procedure.md` for dual-registry publishing and first-public-release flow.
   - Update README/package README references only when needed for public package consumption or status badges.
   - Preserve documented limitations: `verser2` is not a complete public gateway, and future runtimes/transports remain roadmap work unless implemented.

## Non-functional requirements

- Safety first: no secret, visibility, branch protection, or first-public-release step should be automated in a way that can surprise maintainers.
- Minimal behavior changes: do not change Host, Guest, Broker, routing, TLS, mTLS, streaming, or HTTP protocol behavior except as needed for release tooling.
- Reproducibility: release and validation steps should be deterministic and documented.
- Maintainability: prefer clear, small workflow files and scripts over opaque one-off release logic.
- Security: avoid broad token permissions; use least-privilege workflow permissions and maintainer-approved release gates.

## Acceptance criteria

- Governance docs exist and are consistent with the repository workflow and product boundaries.
- Publishable JavaScript packages no longer have package-level public-publish blockers and include public package metadata.
- Root workspace remains private unless intentionally changed and justified.
- Dual-registry publishing is documented and represented in workflows/scripts with safe manual gates for npmjs.org.
- Pull request CI validates source, package, docs/governance, and workflow changes without publishing.
- Security/safety repository configs or workflows are added where practical, and all manual GitHub settings are documented.
- `docs/opensource-checklist.md` reflects completed automated work and remaining manual steps.
- Existing package staging, consumer, tarball, lint, and test validation pass or any skipped validation is recorded with reason.
- No product docs claim unsupported HTTP/3, browser, Rust, Go, Java, or Python Host behavior as implemented.

## Out of scope

- Making the repository public directly.
- Creating or rotating real npm/GitHub/PyPI secrets.
- Performing the first public npm publish.
- Enabling GitHub branch protection, repository visibility, or organization settings through the API unless a maintainer explicitly authorizes it later.
- Publishing the Python package to PyPI unless explicitly added by a later scope decision.
- Implementing new runtime behavior, transport behavior, Host/Guest/Broker protocol changes, or public gateway policy features.

# Specification: Documentation Finalisation

## Overview

Finalize the verser2 implementation documentation so AI and manual implementers have clear, task-focused instructions for developing solutions based on verser2. The documentation must be organized by implementation task rather than by package or programming language, and source-level public API documentation must be added across TypeScript/JavaScript and Python public APIs.

The source code is the source of truth. Tests are secondary confirmation. Existing documentation is only potentially correct and must not be copied without verification against the implementation.

## Track Type

Chore / documentation.

## Goals

- Replace package/language-first user guidance with task-focused documentation.
- Document how to use verser2 for connecting, exposing handlers, making requests, route advertisement, certificate/TLS setup, authorization, accepting/rejecting connections, lifecycle, shutdown, and error handling.
- Add JSDoc to all TypeScript/JavaScript public APIs, exported types, and public runtime interfaces.
- Add Python docstrings as the Python equivalent of JSDoc for public Python APIs.
- Review Conductor documentation relevant to implementation work and ensure it remains accurate for documentation/API-doc development.
- Regenerate codemaps as an explicit implementation phase.
- Keep Host/Guest/Broker terminology precise and avoid implying unsupported roadmap features are implemented.

## Functional Requirements

### Task-focused documentation

Create or update the documentation set under `docs/` around implementation tasks:

- `docs/index.md` for documentation navigation, role model, and quickstart.
- `docs/connecting.md` for starting a Host and connecting Guests/Brokers.
- `docs/exposing-http.md` for exposing Node HTTP handlers, Bun fetch/routes, and Python ASGI applications without opening inbound listeners.
- `docs/making-requests.md` for Broker request APIs, Node Agent, Undici Dispatcher, fetch helper, and Python Broker request helpers.
- `docs/routes.md` for route advertisement, route discovery, exact hostname matching, target IDs, and route removal.
- `docs/certificates.md` for TLS certificates, client trust, mTLS client identity, PFX/PKCS12, key permissions, hostname verification, and Host certificate reload behavior.
- `docs/authorization.md` for registration-time authorization, certificate identity, fingerprints, allow/close policy examples, and limitations such as lack of built-in per-request Broker target authorization.
- `docs/lifecycle-and-errors.md` for Host/Guest lifecycle APIs, Broker error handling, shutdown, request failure cases, timeouts, and error codes.

### Existing documentation treatment

- Trim `README.md` to a concise overview, minimal quickstart, package entrypoints, and links to task docs.
- Replace or absorb `docs/ssl-certificate-generation.md` into `docs/certificates.md`.
- Trim `packages/verser2-guest-bun/README.md` to package identity, minimal usage, Bun-specific caveats, and links to task docs.
- Trim `packages/verser2-guest-python/README.md` to package identity, minimal ASGI/Broker usage, Python-specific caveats, and links to task docs.
- Create minimal package README files for packages that currently lack them where useful for package consumers:
  - `packages/verser-common/README.md`
  - `packages/verser2-host/README.md`
  - `packages/verser2-guest-node/README.md`
  - `packages/verser2-guest-js-common/README.md`
- Leave release/process/internal docs alone unless the implementation-work review identifies a concrete accuracy issue:
  - `docs/package-publishing.md`
  - `docs/common-issues.md`
  - `AGENTS.md`
  - `AGENTS.development.md`
  - `ROADMAP.md`
  - `conductor/**`
  - `LICENSE`

### Source-level API documentation

Add source-level documentation to all public APIs and exported/public types in:

- `packages/verser-common/src/**`
- `packages/verser2-host/src/**`
- `packages/verser2-guest-js-common/src/**`
- `packages/verser2-guest-node/src/**`
- `packages/verser2-guest-bun/src/**`
- `packages/verser2-guest-python/src/verser2_guest_python/**`

TypeScript/JavaScript packages must use JSDoc. Python APIs must use docstrings.

Source-level API docs must explain:

- What the API does.
- Required and optional parameters.
- Host/Guest/Broker role semantics.
- Route/domain/target-ID semantics.
- TLS and security implications.
- Lifecycle and shutdown behavior.
- Streaming behavior where relevant.
- Failure modes and raised/rejected errors where relevant.
- Unsupported behavior and roadmap-only features where relevant.

### Implementation-review requirement

Before writing final docs, review the actual implementation and public API surface. Use tests only to confirm or clarify behavior. Treat existing docs as potentially stale. In particular, verify lifecycle/event APIs from source rather than copying existing README examples.

### Conductor documentation review

Perform a full review of Conductor documentation relevant to implementation work, including at least:

- `conductor/index.md`
- `conductor/product.md`
- `conductor/product-guidelines.md`
- `conductor/tech-stack.md`
- `conductor/workflow.md`
- `conductor/known-solutions.md`
- active track registry/structure docs as needed

Update only if the review finds concrete inaccuracies, missing instructions, or conflicts with the new documentation/API-doc workflow.

### Codemap regeneration

Regenerate codemaps as a required phase of the track. Codemap outputs must reflect the final source/docs state after documentation and API-doc changes, using the repository's established codemap process if present.

## Non-Functional Requirements

- Keep documentation concise, task-oriented, and implementation-accurate.
- Prefer small examples that show correct Host/Guest/Broker terminology.
- Avoid unsupported claims about HTTP/3, browser guests, Rust/Go/Java guests, Python Host behavior, WebSocket forwarding, or complete gateway authorization unless implemented in source.
- Avoid duplicating long explanations between README, package READMEs, and task docs.
- Ensure links between docs are valid and relative paths are correct.
- Preserve package consumer clarity for npm/Python package pages.
- Follow repository formatting, TypeScript, Python, and Conductor workflow conventions.

## Acceptance Criteria

- Task-focused docs exist and cover the specified implementation tasks.
- README and package READMEs point to task docs and no longer duplicate large stale sections.
- Certificate documentation is consolidated into the task-focused certificate doc.
- All public TypeScript/JavaScript APIs and exported/public types have useful JSDoc.
- All public Python APIs have useful docstrings.
- Documentation statements about behavior are traceable to source code or tests.
- Conductor implementation-work documentation has been reviewed and updated only if needed.
- Codemaps have been regenerated as part of the track.
- Relevant build/lint/test or documentation validation commands pass, or any skipped validation is recorded with rationale.

## Out of Scope

- Implementing new transport behavior.
- Adding HTTP/3, browser, Rust, Go, or Java Guest implementations.
- Adding Python Host behavior.
- Adding WebSocket forwarding.
- Adding complete public gateway authentication/authorization.
- Adding built-in per-request Broker target authorization unless a separate implementation track defines it.
- Changing public API behavior except for documentation comments and docstring-only metadata.

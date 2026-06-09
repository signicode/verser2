# Specification: Python Guest

## Overview

Create the first Python implementation of a Verser2 Guest. The Python Guest should connect outbound to the existing Verser2 Host and expose a local ASGI 3-style application without opening an inbound listening port. The implementation should broadly target the behavior already available in the Node Guest while using Python-native application conventions and development tooling.

The initial package should live in `packages/verser2-guest-python/` and include a `package.json` so repository-level package tooling can treat it consistently with existing packages. Python build, test, and development commands should be driven from that package using a Python environment/tooling choice such as `uv` and a virtual environment.

## Functional Requirements

- Add a new Python Guest package under `packages/verser2-guest-python/`.
- Provide package metadata and scripts compatible with the repo's package discovery expectations, including a `package.json` plus Python packaging metadata such as `pyproject.toml`.
- Expose an ASGI 3 primary interface accepting an async callable shaped like `app(scope, receive, send)`.
- Allow ASGI-compatible applications, including FastAPI/Starlette-style apps, to be attached as Verser2 Guests.
- Connect outbound from the Python Guest to the existing Verser2 Host using the current Host/Guest protocol rather than adding a new Host implementation.
- Preserve familiar HTTP semantics for routed requests: method, path, query string, headers, request body, response status, response headers, and response body.
- Support bidirectional streaming semantics where feasible:
  - streamed request bodies from broker/host into ASGI `receive` events;
  - streamed response bodies from ASGI `send` events back through the Host;
  - correct handling of chunk continuation/end semantics.
- Document any streaming, lifecycle, or compatibility limits that remain in the first Python implementation.
- Provide a Python-side request/fetch helper if practical within the first implementation slice; if not practical, document it as deferred.
- Include a runnable smoke example using a plain ASGI app and/or FastAPI-compatible app pattern.

## Non-Functional Requirements

- Follow Verser2 terminology precisely: Host accepts connections, Guest connects outbound and serves a local app, Broker sends requests through the Host.
- Keep public APIs minimal, explicit, and Pythonic while remaining compatible with Verser2 Host protocol concepts.
- Reuse existing shared protocol definitions or derive behavior from current common/Node implementation rather than inventing incompatible protocol semantics.
- Keep HTTP/3, authentication/authorization policy, public gateway behavior, and non-Python guest runtimes out of scope.
- Integrate with repository validation without breaking existing npm-driven build, staging, package, and test workflows.
- Use focused tests and maintain meaningful coverage for changed behavior.

## Acceptance Criteria

- `packages/verser2-guest-python/` exists with package metadata, source layout, tests, and development scripts.
- Repository package tooling recognizes the Python package consistently with the existing package model via `package.json`.
- Python package commands create/use an isolated Python environment through the selected toolchain and can run package tests.
- A Python ASGI 3 app can be connected as a Verser2 Guest to the existing Host.
- Integration tests demonstrate at least one routed request from broker/host to the Python Guest and validate method, path, headers, status, and body forwarding.
- Tests or smoke examples demonstrate response streaming and request streaming behavior, or clearly document any intentionally deferred streaming gaps.
- A FastAPI/Starlette-compatible usage example is documented or included as a smoke example without making FastAPI a required runtime dependency unless explicitly chosen during implementation.
- Existing Node Host/Guest/Broker tests and package readiness tests continue to pass or are intentionally updated for the new package.
- Documentation and tech-stack references are updated to describe Python Guest as implemented rather than roadmap-only.

## Out of Scope

- Implementing a Python Host or Python Broker beyond a small request/fetch helper if practical.
- Implementing HTTP/3 support.
- Adding authentication, authorization, or public gateway policy.
- Replacing or redesigning the existing Node Host/Guest/Broker protocol.
- Implementing browser, Bun, Rust, Go, or Java Guests.
- Full FastAPI feature certification beyond practical ASGI compatibility and example coverage.

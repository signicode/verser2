# Specification: Bun Guest

## Overview

Create a Bun Guest implementation for `verser2` that lets Bun applications expose local HTTP handlers through the existing outbound Host/Guest routing model without opening an inbound listening port. The package should be compatible with Bun’s `Bun.serve` HTTP handler style, including Web-standard `Request`/`Response` handlers and Bun routes/method handlers, while providing Node compatibility within reason for handler-style interoperability.

This track promotes Bun from roadmap-only status into an implemented guest runtime package, modeled after the existing Node Guest and Python ASGI Guest patterns.

## Goals

- Add a new Bun Guest package target at `packages/verser2-guest-bun`.
- Provide a public API that accepts Bun-style HTTP handlers without requiring `Bun.serve(...).listen()` or any inbound port.
- Dispatch Host-routed requests into Bun-compatible handlers and return status, headers, and body responses through the existing Verser2 transport model.
- Support Bun `fetch(req)` and `fetch(req, server)`-style HTTP handlers where practical.
- Support Bun `routes`/method handler configuration where practical for ordinary HTTP request dispatch.
- Preserve familiar HTTP semantics: method, path, query, headers, request body, response status, response headers, and response body.
- Provide Node compatibility within reason by supporting practical handler bridge behavior and smoke-testing relevant Bun compatibility for `Buffer`, `events`, and stream interop where used.
- Add Bun-specific automated validation using `bun test`, alongside repository npm build/lint/test validation where appropriate.
- Document Bun Guest usage, examples, limits, and validation requirements.

## Functional Requirements

### Package and Public API

- Create a new workspace package for `@signicode/verser2-guest-bun`.
- Export a small public API consistent with existing package conventions, including package name constants and typed creation/connect helpers where appropriate.
- Reuse existing shared protocol primitives from `@signicode/verser-common` and existing JavaScript Guest foundations from `@signicode/verser2-guest-js-common` before introducing package-local equivalents.
- Keep runtime-specific Bun adapter code package-local unless it becomes reusable across JavaScript runtimes.

### Bun Handler Compatibility

- Accept Bun-style `fetch` handlers that receive a Web `Request` and return a Web `Response` or promise of a `Response`.
- Support practical `fetch(req, server)` compatibility without requiring a real listening Bun server; unsupported `server` capabilities must be documented or fail clearly.
- Accept route/method handler definitions modeled after Bun’s `routes` option for ordinary HTTP methods where feasible.
- Construct Web-standard `Request` objects from routed Verser2 requests, including method, URL/path/query, headers, and body.
- Serialize Web-standard `Response` objects back into Verser2 responses, preserving status, headers, and body.

### Host/Guest Transport Integration

- Connect outbound to the existing Verser2 Host using the current Guest registration and routed request model.
- Do not introduce HTTP/3, public gateway policy, authentication, authorization, or unrelated runtime guests.
- Do not require opening an inbound TCP port in Bun applications.
- Preserve existing Host, Guest, Broker, and Peer terminology.

### Streaming and Body Semantics

- Support ordinary request and response bodies for common Bun `Request`/`Response` usage.
- Prefer Web `ReadableStream` semantics for Bun handler bridging.
- Preserve streaming behavior where the current transport and Bun runtime support it.
- Clearly document any buffering or runtime limitations discovered during implementation.

### Node Compatibility Within Reason

- Provide practical bridge behavior for Node-like handler/server shapes when this can be done without compromising the Bun-first API.
- Smoke-test compatibility for common Node primitives used by the adapter, especially `Buffer`, `node:events`, and stream interop.
- Avoid depending on obscure or partial Node internals in Bun.

### WebSockets

- Bun WebSocket upgrade support is out of scope for this track.
- The package must document WebSocket upgrade behavior as unsupported/deferred.
- If an upgrade request reaches the Bun Guest adapter, behavior should be explicit and diagnosable rather than silently incorrect.

### Testing and Validation

- Add Bun-specific tests using `bun test` for handler adaptation and response behavior.
- Add repository-level tests for package scaffolding, documentation, and integration behavior as appropriate.
- Follow the Conductor workflow: write failing tests first, implement the smallest passing behavior, validate narrowly, and commit at phase checkpoints.
- Maintain at least 95% meaningful coverage for changed behavior or record why coverage cannot be measured for Bun-specific runtime paths.

## Non-Functional Requirements

- Keep the primary developer API minimal and familiar to Bun users.
- Preserve existing HTTP semantics and error/lifecycle diagnostics expectations.
- Keep implementation incremental, reviewable, and aligned with the existing monorepo build/package conventions.
- Document operational caveats, including Bun runtime requirements and any unavailable Bun server features.
- Avoid broad transport changes unless required for the Bun Guest behavior and explicitly covered by tests.

## Acceptance Criteria

- `@signicode/verser2-guest-bun` exists as a recognized workspace/package target with public exports.
- A Bun `fetch(req)` handler can be connected as a Verser2 Guest without opening a local listening port.
- A Host-routed HTTP request reaches the Bun handler and returns the expected status, headers, and body.
- Bun route/method handler configuration is supported for ordinary HTTP request paths or documented with tested limitations.
- Streaming/body behavior is tested for representative request and response cases.
- Node compatibility bridge behavior is tested for the agreed practical scope.
- WebSocket upgrade behavior is explicitly out of scope and documented.
- Bun-specific tests run with `bun test`, and repository validation uses npm commands according to repo policy.
- Documentation includes a Bun Guest example and clearly states that the local Bun app does not call `listen()`.

## Out of Scope

- Full WebSocket upgrade forwarding.
- HTTP/3 support.
- Browser, Rust, Go, Java, or additional Python behavior.
- Host authentication, authorization, or public gateway policy.
- Replacing the existing Node Guest or Python ASGI Guest APIs.
- Broad rewrites of the existing Host/Broker transport beyond what the Bun Guest requires.

## Research Notes

- Bun’s server model is Web-standard first: handlers receive `Request` and return `Response`.
- `Bun.serve` supports `fetch(req, server)` and WebSocket upgrades through `server.upgrade`, but WebSocket forwarding is deferred for this track.
- Bun’s Node compatibility is strong for common primitives such as streams and events, but some lower-level or outbound HTTP details have caveats; the track should avoid obscure Node internals.
- Official Bun docs consulted: `https://bun.com/docs/runtime/bun-apis`, `https://bun.com/docs/runtime/http/websockets`, `https://bun.com/docs/runtime/nodejs-compat`, and `https://bun.com/docs/test`.

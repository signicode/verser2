# Agent Notes

## Purpose
- `verser2` lets applications route HTTP requests to Guest-side Node, Bun, and Python handlers that connect outbound to a Host instead of listening for inbound traffic.
- Use these notes for basic package integration guidance. For repository implementation work, read [`AGENTS.development.md`](./AGENTS.development.md) and then `conductor/index.md`.

## Integration model
- Host accepts outbound Guest and Broker connections and routes requests to advertised Guest routes.
- Guest connects outbound to a Host and attaches a local HTTP/1 handler without calling `listen()`.
- Broker connects outbound to a Host and sends requests to advertised Guest routes.
- Local Guest HTTP handlers remain normal in-process Node HTTP handlers; the remote Host/Guest/Broker transport uses TLS HTTP/2.

## Package entrypoints
- `@signicode/verser-common` — shared protocol and utility exports.
- `@signicode/verser2-host` — Host creation and lifecycle APIs.
- `@signicode/verser2-guest-js-common` — runtime-neutral JavaScript Guest foundations.
- `@signicode/verser2-guest-node` — Node Guest, Broker, Agent, Dispatcher, and fetch helper APIs.
- `@signicode/verser2-guest-bun` — Bun Guest and Bun-facing Broker APIs.
- `@signicode/verser2-guest-python` — Python ASGI Guest and async Broker APIs.

## Usage boundaries
- Do not describe HTTP/3, browser, Rust, Go, Java, or Python Host behavior as implemented. Python Host is not implemented and is not on the current roadmap. Browser, Rust, Go, and Java guests remain roadmap work unless a future development track changes that.
- Do not imply that `verser2` is a complete public gateway. Applications remain responsible for authentication, authorization, and routing policy.
- Keep Host/Guest/Broker terminology precise in examples and documentation.

## Development work
- For code changes, tests, release packaging, Conductor tracks, and repository commands, follow [`AGENTS.development.md`](./AGENTS.development.md).

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

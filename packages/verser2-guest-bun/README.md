# @signicode/verser2-guest-bun

This package is a **Phase 1 scaffold** for the Bun Guest API.

Phase 1 intentionally provides only package wiring and type-safe public exports,
not a connected transport implementation. The runtime behavior (registration,
routing handoff, and stream handling) is deferred to later Conductor phases.

- Guests connect to Host and route local handlers without calling `listen()`.
- Bun fetch-style request handling is the intended runtime shape for this guest.
- WebSocket forwarding is explicitly out of scope for Phase 1.

## Public API (scaffold)

- `VERSER2_GUEST_BUN_PACKAGE_NAME`
- `createVerserBunGuest(options)`

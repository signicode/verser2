# @signicode/verser2-guest-bun

This package provides the Bun Guest outbound adapter. It reuses the established
`@signicode/verser2-guest-node` transport for Host connection, route
registration, lease management, lifecycle events, and close behavior while adapting
the local handler model to Bun-style `fetch` request handling.

- Guests connect to Host and route handlers without calling `listen()`.
- Local handlers use Bun-style `fetch` (and optional route-table) behavior via
  `dispatchVerserBunRequest`.

## Public API (scaffold)

- `VERSER2_GUEST_BUN_PACKAGE_NAME`
- `createVerserBunGuest(options)` delegates to the Node Guest transport.
- `dispatchVerserBunRequest(handler, request)`

## `dispatchVerserBunRequest`

Phase 2 adds a tiny Bun runtime adapter helper:

- Accepts a handler object with `fetch(request)` / `fetch(request, server)` and
  optional `routes` table.
- Builds a web-standard `Request` from `{ method, path, headers, body, origin }`.
- Returns a typed data response with `status`, `statusText`, `headers`, `body`,
  `text()` and `json()`.

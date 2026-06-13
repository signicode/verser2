# packages/verser2-guest-bun/examples/

## Responsibility

Contains a standalone **self-checking Bun Guest runtime** (`runtime_guest.ts`)
that exercises the full Verser2 Bun Guest and Broker API surface.  It is used
both as documentation and as a smoke-test / integration-check against a running
Host.

## Design / Patterns

- **Dual connect** — Creates both a Bun Guest (`createVerserBunGuest`) and a
  Bun Broker (`createVerserBroker`), connects both, then performs self-checks.
- **Route table demonstration** — The attached Guest handler shows many route
  patterns: static responses (`/status`), `:param` segments (`/users/:id`),
  wildcard (`/files/*`), method maps (`/items`), JSON responses, iterable bodies,
  Node `Readable` bodies, and a catch-all `fetch`.
- **Self-check flow**:
  1. Wait for Guest domain to be advertised via `broker.waitForRoute()`.
  2. Perform a direct `broker.request()` to `/status`.
  3. Perform a `createFetch()` request to `/response-json`.
  4. Log readiness, then wait for `SIGINT`/`SIGTERM`.
- **Timeout safety** — All async operations use `waitWithTimeout()` to prevent
  hangs.
- **TLS configuration** — Reads multiple env vars (`VERSER_TLS_CA_FILE`,
  `VERSER_TLS_CERT_FILE`, `VERSER_TLS_KEY_FILE`, `VERSER_TLS_PFX_FILE`,
  `VERSER_TLS_PASSPHRASE`) for both PEM and PFX-based client auth.

## Data & Control Flow

```
runtime_guest.ts
  │
  ├── read env vars (hostUrl, guestId, domain, TLS options)
  │
  ├── createVerserBunGuest(options)
  │     └── guest.attach(handler with routes + fetch, domain)
  │
  ├── createVerserBroker(options)
  │
  ├── broker.connect()
  ├── guest.connect()
  │
  ├── broker.waitForRoute(domain)
  │
  ├── self-check 1: broker.request({ targetId, path: '/status' }) → expect 200 "ok"
  │
  ├── self-check 2: broker.createFetch() → fetch('/response-json') → expect { ok: true }
  │
  ├── log "bun guest ready"
  │
  └── wait for SIGINT/SIGTERM → close both connections
```

## Integration Points

- **`@signicode/verser2-guest-bun`** — imports `createVerserBunGuest` and
  `createVerserBroker` from the package entry point.
- **Running Host** — requires a Verser Host at `VERSER_HOST_URL` accepting
  TLS connections with the configured certificates.

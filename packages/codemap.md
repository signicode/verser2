# packages/

## Responsibility

Contains all publishable workspace packages for the Verser2 Host, shared common
protocol code, JavaScript/Node/Bun Guest/Broker implementations, and the Python
ASGI Guest/Broker package.

## Design

- **Layered package architecture:** `verser-common` defines protocol-neutral
  contracts; Host and Guest/Broker packages build transport adapters around it.
- **Entrypoint barrels:** each package exposes a narrow public API from `src/index.ts`
  or Python `__init__.py`, with implementation modules under `src/lib` or
  `src/verser2_guest_python`.
- **Runtime adapters:** Node is the base JavaScript transport, Bun wraps Node
  transport semantics with Fetch-style handler conversion, and Python mirrors the
  protocol with `asyncio`/`h2`.

## Flow

1. Applications import package entrypoints.
2. Host starts a TLS HTTP/2 server.
3. Guests and Brokers connect outbound, register peer role and IDs, and exchange
   route/control/request streams.
4. Local runtime adapters translate routed envelopes into Node HTTP, Bun Fetch,
   or Python ASGI handler calls.

## Integration

- Built by root `npm run build` workspace orchestration.
- Staged by `scripts/stage-packages.js` into `dist/packages`.
- Validated by root `test/` suites and Python package tests.
- Documented by package READMEs and task docs under `docs/`.

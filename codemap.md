# Repository Atlas: verser2

## Project Responsibility

`verser2` is a reverse HTTP connectivity monorepo. It lets Guest-side Node,
Bun, and Python handlers connect outbound to a TLS HTTP/2 Host, advertise route
domains, and receive HTTP requests from connected Brokers without opening
inbound listener ports.

## System Entry Points

- `package.json`: npm workspace manifest and root build/test/lint scripts.
- `README.md`: concise package-consumer overview and task-doc navigation.
- `docs/`: task-focused usage, TLS, authorization, lifecycle, development, and
  publishing documentation.
- `scripts/stage-packages.js`: publish-staging pipeline that copies built
  artifacts and rewrites package README links to GitHub SHA/tag URLs.
- `packages/*/src/index.ts`: TypeScript package public entrypoints.
- `packages/verser2-guest-python/src/verser2_guest_python/__init__.py`: Python
  package public entrypoint.

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `packages/` | Workspace package layer containing shared protocol code, Host, Node/Bun/Python Guest/Broker adapters, package READMEs, examples, and Python tests. | [View Map](packages/codemap.md) |
| `packages/verser-common/` | Shared protocol contracts, envelope encoding, routing, header normalization, TLS/certificate helpers, and error primitives. | [View Map](packages/verser-common/codemap.md) |
| `packages/verser2-host/` | Node TLS HTTP/2 Host with peer registration, route advertisements, lease-stream routing, mTLS authorization, and certificate reload. | [View Map](packages/verser2-host/codemap.md) |
| `packages/verser2-guest-js-common/` | JavaScript adapter foundations for route-aware fetch dispatch and shared Broker request types. | [View Map](packages/verser2-guest-js-common/codemap.md) |
| `packages/verser2-guest-node/` | Node Guest/Broker transport with minimal HTTP shims, direct Broker requests, Agent, Dispatcher, and fetch helper. | [View Map](packages/verser2-guest-node/codemap.md) |
| `packages/verser2-guest-bun/` | Bun Guest and Bun-facing Broker wrapper over the Node transport, including Bun Fetch/route-table adapters. | [View Map](packages/verser2-guest-bun/codemap.md) |
| `packages/verser2-guest-python/` | Python ASGI Guest and async Broker implementation using `h2`, asyncio, route control frames, and one-shot response bodies. | [View Map](packages/verser2-guest-python/codemap.md) |
| `docs/` | Task-focused documentation for connecting, exposing handlers, making requests, routes, certificates, authorization, lifecycle, development, and publishing. | [View Map](docs/codemap.md) |
| `scripts/` | Release-engineering utilities for staging packages, version policy, consumer checks, tarball behavior tests, and license copying. | [View Map](scripts/codemap.md) |
| `test/` | Node `node:test` suites for protocol, routing, TLS, package publishing, package consumers, tarballs, docs, and integration behavior. | [View Map](test/codemap.md) |

## Cross-Cutting Flows

1. **Registration:** Guests and Brokers connect outbound to the Host, POST to
   `/verser/register`, and receive registration responses. Guest routed domains
   become Host route records.
2. **Route advertisement:** Host broadcasts full route tables to Brokers over
   NDJSON control streams. Brokers replace local route state on each frame.
3. **Request routing:** Brokers send requests to `/verser/request`; Host assigns
   a Guest lease stream, writes a routed request envelope, pipes body bytes, and
   returns the Guest response or error envelope.
4. **Local handler dispatch:** Node uses minimal HTTP/1-style request/response
   shims; Bun maps to Fetch `Request`/`Response`; Python maps to ASGI 3 scopes
   and events.
5. **Package staging:** Build outputs are copied to `dist/packages`; staged
   package READMEs rewrite repository doc links to GitHub `blob/<sha-or-tag>`
   URLs for package-consumer contexts.

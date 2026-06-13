# Phase 1 Source Inventory

## Scope and method

- Source is the source of truth for the documentation finalisation track.
- Tests were used only to confirm or clarify source-derived behavior.
- Existing documentation was treated as potentially stale.
- Behavior-neutral documentation/API-doc work does not change runtime behavior; coverage is not applicable unless later phases introduce behavior changes unexpectedly.

## Public package API inventory

### `@signicode/verser-common`

- Entrypoint: `packages/verser-common/src/index.ts`.
- Public constants include `VERSER_COMMON_PACKAGE_NAME`, envelope constants, `DEFAULT_MAX_ENVELOPE_METADATA_BYTES`, `VERSER_LIFECYCLE_EVENTS`, and `VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER`.
- Public classes include `VerserError` and `VerserHttpErrorResponse`.
- Public helpers include routing/ID helpers (`createGuestId`, `createPeerId`, `createRoutedDomainRegistration`, `resolveRouteForHostname`, `resolveRouteForUrl`), Broker request creation, registration/control-frame helpers, envelope readers/writers, error-response helpers, stream/NDJSON/body helpers, header normalization/serialization helpers, HTTP/2 header conversion helpers, TLS/certificate helpers, and `getErrorMessage`.
- Public types include peer/guest/request IDs, routed domain/request/response envelopes, header shapes, envelope metadata/parser shapes, common Broker request/response shapes, registration request/response shapes, certificate identity and registration authorization shapes, Broker routes control frames, TLS option shapes, and error context/code shapes.
- Docs should reuse common terminology for Guest IDs, Peer IDs as generic shared identifiers, Broker/Guest roles, exact routed-domain matching, lifecycle events, lease acquire timeout, certificate identity, and registration authorization.

### `@signicode/verser2-host`

- Entrypoint: `packages/verser2-host/src/index.ts`.
- Public API: `createVerserHost(options?: VerserHostOptions): VerserHost`.
- Public types include `VerserHost`, `VerserHostLifecycleEvent`, `VerserHostOptions`, `VerserHostRegistrationRequest`, and re-exported `VerserPeerRole`.
- Public constant: `VERSER2_HOST_PACKAGE_NAME`.
- Runtime caveats: Host uses Node TLS HTTP/2, requires TLS options, defaults to `127.0.0.1` and port `0`, throws for `address` before listening, supports server certificate reload only while running, and supports registration-time client-auth authorization.

### `@signicode/verser2-guest-js-common`

- Entrypoint: `packages/verser2-guest-js-common/src/index.ts`.
- Public API includes `AbstractVerserFetchDispatcher`, header helpers, route helpers, `appendQueryString`, `createCommonBrokerRequest`, route/common Broker/header/stream chunk types, and `VERSER2_GUEST_JS_COMMON_PACKAGE_NAME`.
- Runtime caveat: this package is a shared JavaScript foundation for adapters; `AbstractVerserFetchDispatcher` is intended for subclasses rather than direct app-level dispatch.

### `@signicode/verser2-guest-node`

- Entrypoint: `packages/verser2-guest-node/src/index.ts`.
- Public API: `createVerserNodeGuest`, `createVerserBroker`, `MinimalIncomingMessage`, `MinimalServerResponse`, public Guest/Broker option/request/response/lifecycle/dispatch types, and `VERSER2_GUEST_NODE_PACKAGE_NAME`.
- Runtime caveats: Node Guest/Broker uses outbound TLS HTTP/2; `attach()` accepts an `http.Server` with a request listener or a listener function and does not call `listen()`; Broker exposes `request()`, `createAgent()`, `createDispatcher()`, and `createFetch()`; minimal HTTP objects do not implement the full Node request/response/socket surface.

### `@signicode/verser2-guest-bun`

- Entrypoint: `packages/verser2-guest-bun/src/index.ts`.
- Public API: `createVerserBunGuest`, `createVerserBroker`, Bun Guest/Broker option/request/response/lifecycle/route/handler types, and `VERSER2_GUEST_BUN_PACKAGE_NAME`.
- Runtime caveats: Bun Guest wraps the Node Guest transport; Bun Broker wraps the Node Broker and provides Web Fetch-style `createFetch()`; `attach()` accepts a Bun-like handler object with `fetch` and/or `routes`; route tables support exact paths, `:param` segments, wildcard `*`, and method maps; WebSocket upgrade is not implemented.

### `@signicode/verser2-guest-python`

- Entrypoint: `packages/verser2-guest-python/src/verser2_guest_python/__init__.py`.
- Public exports: `VERSER2_GUEST_PYTHON_PACKAGE_NAME`, `VerserGuest`, `create_verser_guest`, `VerserBroker`, `VerserBrokerResponse`, and `create_verser_broker`.
- Guest public API: `VerserGuest(host_url, guest_id, app=None, routed_domains=None, tls_ca_file=None, min_waiting_streams=1, max_response_bytes=...)`, `attach(app, domain=None)`, `dispatch_routed_request(metadata, body)`, async `connect()`, and async `close(reason='guest-close')`.
- Broker public API: `VerserBroker(host_url, broker_id, tls_ca_file=None, tls_cert_file=None, tls_key_file=None, tls_key_password=None, tls_pfx_file=None, tls_pfx_password=None, **options)`, async context manager methods, async `connect()`, async `close()`, async `request()`, convenience `get/post/put/patch/delete`, `get_routes()`, and `wait_for_route(domain)`.
- `VerserBrokerResponse` exposes `status`, `headers`, `request_id`, async `read()`, `text()`, `json()`, and async iterator `aiter_bytes(chunk_size=8192)`. Response bodies are one-shot.
- Submodule helpers in `asgi.py` and `protocol.py` are importable but not top-level public exports; treat them as advanced/internal unless intentionally promoted.

## Verified behavior facts

- Host is a TLS HTTP/2 secure server and only supports `/verser/register`, `/verser/guest/control`, `/verser/guest/lease`, and `/verser/request` protocol paths.
- Peers register as role `guest` or `broker`; duplicate peer IDs are rejected.
- Host registration authorization is a registration-time mTLS/client-certificate hook only. It is not complete application authentication/authorization or per-request Broker target authorization.
- Guest registration creates route records with `targetId` and `domain`. Host advertises the full current route table to Brokers. Later route frames replace Broker route state, so retraction is represented by a shorter or empty route list.
- Route matching is exact URL hostname equality; there is no wildcard or suffix domain matching.
- Node Guest connects outbound, registers as `guest`, opens a control stream, and maintains lease streams. `attach()` does not call `listen()` and defaults the route domain to the Guest ID when no domain is supplied.
- Node local handlers receive minimal HTTP/1-style request/response objects. Unsupported features include HTTP upgrade/WebSocket forwarding, CONNECT tunneling, informational responses, trailers, and full socket semantics.
- Node Broker connects outbound, registers as `broker`, sends requests to Host path `/verser/request`, and uses leased streams to route request and response bodies.
- Node Broker request bodies may be omitted, buffers/chunks, or streams. Agent, Dispatcher, and fetch helper route by advertised hostname.
- `createAgent()` returns a plain `http:` Agent that routes advertised hostnames without DNS resolution.
- `createDispatcher()` returns an Undici Dispatcher; it rejects upgrade requests and supports common buffer/string/stream/iterable body forms.
- `createFetch()` wraps Undici `fetch` with the Broker dispatcher by default.
- Python Broker connects over TLS with ALPN `h2`, registers as `broker`, consumes route control frames, routes by URL hostname, and raises `RuntimeError` for missing advertised routes.
- Python Broker request helpers include `request`, `get`, `post`, `put`, `patch`, and `delete`; body helpers support JSON, text, bytes, chunk lists/tuples, and async byte iterables.
- Host TLS identity supports PEM and PFX/PKCS12 via direct values or files. Node Guest/Broker support CA trust and PEM/PFX client identities. Host mTLS is enabled by `tls.clientAuth.ca` or `caFile` and sets `requestCert` and `rejectUnauthorized`. Host can reload server certificate material while running. Python Broker supports CA trust plus PEM and PFX/PKCS12 client identity files.

## Stale or unsupported claims to avoid

- Do not claim HTTP/3 support.
- Do not claim Browser, Rust, Go, Java, or Python Host implementations.
- Do not claim complete public gateway authentication/authorization or built-in per-request Broker target authorization.
- Do not claim WebSocket, HTTP upgrade, CONNECT forwarding, trailers, informational responses, or full socket APIs are implemented.
- Do not claim full Node `IncomingMessage` or `ServerResponse` compatibility for Guest local handlers.
- Do not claim wildcard or suffix route-domain matching.
- Do not describe Python Broker routed requests as deferred or unimplemented; they are implemented.

## Conductor documentation review findings

### Updated in Phase 1

- `conductor/product.md`: clarified Peer as a generic shared concept, documented implemented Python Broker support, and changed success criteria from generic Peer request issuance to Broker request issuance.
- `conductor/product-guidelines.md`: clarified implemented Bun/Python documentation boundaries and retained browser/Rust/Go/Java as roadmap.
- `conductor/workflow.md`: clarified that behavior-neutral docs/API-doc phases use source inventory and validation instead of failing tests and may record coverage as not applicable.
- `conductor/tracks/docs_finalisation_20260613/metadata.json`: moved status from `new` to `in_progress` to match registry/plan state.

### No change needed

- `conductor/index.md`: navigation is accurate.
- `conductor/tech-stack.md`: current packages, Python Broker, Bun, `uv`, `h2`, and `cryptography` are accurately represented.
- `conductor/known-solutions.md`: no docs-specific recovery path was needed.
- `conductor/tracks.md`: active registry links are accurate.

## Deduplication baseline

- Phase 1 changed only Conductor documentation and inventory artifacts.
- No runtime code or reusable package code was added.
- Later docs should centralize task-focused explanations under `docs/` and keep root/package READMEs concise to avoid duplicated stale content.

## Phase 1 validation

- Command: `npm run lint`
- Result: passed; Biome checked 118 files with no fixes applied.
- Coverage: not applicable because Phase 1 changed only documentation and Conductor metadata/inventory artifacts.
- Skipped validation: build/test were not run for Phase 1 because no runtime code, package exports, generated declarations, or behavior changed.
- Branch/PR review: branch `docs-finalisation-20260613` tracks `origin/docs-finalisation-20260613`; PR #17 is open with title `Finalize task-focused verser2 documentation`, base `main`, and head `docs-finalisation-20260613`.

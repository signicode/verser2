# Changelog

## Unreleased - Federated VWS/1 WebSockets

- Documents Node, Bun, and Python runtime-facing WebSocket APIs over explicit
  VWS/1 frames, including authenticated multi-Host federation.
- Clarifies protocol-neutral route advertisements, pre-accept failover,
  lifecycle closure, bounded flow control, frame limits, and the distinct
  `missing-guest` versus `websocket-negotiation-failed` outcomes.
- Records unsupported generic upgrades, Python Host, browser, Rust, Go, Java,
  and HTTP/3 runtimes.

## Unreleased - Explicit route-domain selection

- Broker request surfaces may provide `routeDomain` (Node/Bun and local APIs) or
  `route_domain` (Python) when a Guest advertises more than one domain.
- Route-aware Agent, Dispatcher, Bun fetch, and Python URL helpers populate the
  advertised domain automatically. Existing target-only requests remain valid
  when the Host can identify exactly one active route; target-only requests for
  multiple domains must migrate to an explicit route domain.
- Hosts authorize only the `(targetId, routeDomain)` pair, forward the selected
  route as `Host`, and overwrite `X-Forwarded-Host` with the caller's original
  authority. Applications should not use forwarded headers for authorization.

### Phase 6 migration notes

- Python upgrades should be performed Host-first: upgrade the Host and route
  lifecycle/control-plane peers before rolling Python Guests or Brokers.
- Python-facing interface additions include `route_domain`, route lifecycle
  observations, and the ASGI WebSocket exports. Keep mixed-version deployments
  on the documented compatibility path while rolling these interfaces.
- Request and response streams have explicit ownership: the producer owns
  writing, the consumer owns reading, and cancellation/close transfers a
  terminal lifecycle event rather than silently reusing a stream.

## v0.5.0 - Route revocation and lifecycle observation

- Adds Guest-owned route revocation APIs across Node, Bun, Python, and local Guest surfaces.
- Adds Broker route-change observation for added, removed, changed/restored, and degraded route lifecycle events.
- Adds degraded/disconnected route state with delayed removal, restoration events, and Host `degradedRouteTimeoutMs` configuration.
- Propagates route lifecycle events through local peers and Host federation, including multi-hop and loop-safe forwarding.
- Documents lifecycle event semantics, route snapshots, listener error handling, and Broker observational boundaries.

## v0.4.5 - Local response header flushing

- Adds `flushHeaders()` to Host local Guest responses so Node HTTP stream handlers can commit headers before body bytes are available.
- Adds `flushHeaders()` to Node Guest minimal responses for leased streaming response compatibility.
- Adds regression coverage for early header delivery before request body completion.

## v0.4.4 - HTTP/2 response header sanitization

- Strips HTTP/1 hop-by-hop response headers before forwarding bridged responses through HTTP/2.
- Removes headers named by the `Connection` header so local handlers can safely return ordinary HTTP/1-style streaming responses.
- Adds Node, Python, leased-routing, and federated forwarding regression coverage for streamed responses with `transfer-encoding: chunked`.

## v0.4.1 - Upstream Broker dispatch

- Enables Brokers connected to downstream Hosts to dispatch requests to routes imported from upstream Host federation links.
- Adds a distinct one-shot federated dispatch path for downstream-to-upstream requests while preserving existing upstream-to-downstream request streams.
- Validates Node, Bun-facing, and Python Broker behavior for upstream route dispatch, including native 307/308 redirect-following across imported routes.

## v0.4.0 - Host federation, upstreams, and HA foundations

- Adds route-aware Host-to-Host federation over TLS HTTP/2 with stable Host IDs, upstream link lifecycle APIs, mTLS federation authorization, and federated route import/export.
- Enables Brokers connected to an upstream Host to reach Guests attached to downstream Hosts while preserving HTTP method, path, headers, status, and streaming request/response bodies.
- Adds local-first route candidate selection, loop/hop suppression, route withdrawal propagation, and new-request fallback to another available federated candidate before forwarding starts.
- Documents federation topology, runner -> hub -> manager deployments, HA limitations, failure modes, and non-goals including no CONNECT tunneling, consensus, exactly-once delivery, or active in-flight migration.

## v0.3.1 - Release workflow reliability

- Preserves staged-package dependency resolution in publish-job validation when validated build artifacts are reused.
- Shortens slow Bun and Python TLS integration paths to keep release validation faster.
- Carries forward native Python wheel and source distribution artifact publishing from the 0.3 release line.

## v0.3.0 - Python distribution artifacts

- Builds the Python Guest package as native Python wheel and source distribution artifacts.
- Publishes Python distribution artifacts through GitHub Actions and attaches tag builds to GitHub Releases.
- Reuses validated package build output in the publish workflow to avoid a second full build/stage cycle.

## v0.2.1 - Broker internal redirects

- Adds default-on internal `307`/`308` redirect following for Node Broker-driven request paths when the `Location` hostname exactly matches an advertised Verser2 route.
- Preserves redirected request method, headers, path/query, and replayable body bytes with configurable `maxInternalRedirects` and `internalRedirectReplayBufferBytes` limits.
- Keeps oversized or non-internal redirect responses client-visible and documents the `createFetch()` manual redirect default.

## v0.2.0 - Initial stable candidate

- Marks the first stable candidate release for Verser2 packages.
- Establishes the initial supported baseline for Host, Guest, and Broker APIs.

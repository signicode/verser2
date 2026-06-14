# Specification: Broker Internal Redirect Following

## Overview

Add default-on internal redirect following for verser2 Broker-driven request paths. When a Guest handler returns a `307` or `308` response with a `Location` hostname that exactly matches an advertised verser2 route, Broker integrations should resolve that target through the Broker route table and issue the redirected request to the owning Guest instead of relying on DNS.

This track is scoped to the current implemented Broker-facing integrations: direct Broker request helpers, the Node `http.Agent` path, and fetch-style Dispatcher/fetch integrations that use the Node Broker transport. The behavior supports use cases where a coordination service returns an internal route, while payload streams continue directly to the owning Guest route.

Issue reference: https://github.com/signicode/verser2/issues/20

## Functional Requirements

1. Internal redirect following is enabled by default for eligible Broker-driven request paths.
2. The Broker follows only HTTP `307` and `308` responses as internal redirects.
3. The Broker follows an internal redirect only when the `Location` hostname exactly matches a route currently advertised in the Broker route table.
4. The Broker follows eligible internal redirects for any HTTP method; it must not maintain a method allowlist or classify methods as safe/unsafe.
5. Redirect targets must be resolved through the Broker route table, not through DNS.
6. Redirected requests must preserve the original HTTP method, headers, path/query semantics after applying the `Location`, and request body bytes from the beginning of the request.
7. The Broker must preserve existing streaming and backpressure behavior as much as possible while buffering only what is necessary to replay a redirected request.
8. The Broker must support a configurable internal redirect replay buffer limit, defaulting to `16 KiB`.
9. If the Broker has already received more request body data than the configured replay buffer limit when an internal redirect decision is needed, it must not follow the redirect internally; it must return the original `307`/`308` response to the client/caller unchanged so the client can handle it.
10. The Broker must support a configurable maximum internal redirect count, defaulting to `3` hops.
11. If the configured maximum internal redirect count is exceeded, the Broker must surface a clear error that identifies an internal redirect loop or redirect limit failure.
12. If the `Location` header is missing, invalid, or points to a hostname that is not an advertised verser2 route, the response must remain client-visible rather than being treated as an internal redirect.
13. The implementation must cover direct Broker requests, Agent-backed `node:http` requests, and fetch-style Dispatcher/fetch paths consistently where those integrations are backed by the Broker route table.
14. Any new public options for redirect following, max hops, or replay buffer size must be documented and exposed consistently for affected Broker integrations.

## Non-Functional Requirements

1. Keep the redirect logic intentionally bounded; do not introduce complex method safety classification or broad HTTP redirect policy.
2. Preserve familiar HTTP semantics for method-preserving redirects and ordinary non-internal redirects.
3. Avoid unbounded buffering and avoid silently replaying large request bodies beyond the configured limit.
4. Preserve response streaming and backpressure from the final target.
5. Keep reusable protocol-neutral helpers in `@signicode/verser-common` when reuse emerges across package boundaries.
6. Maintain TypeScript strictness, existing CommonJS/ES2019 package conventions, and Biome style.
7. Follow Conductor TDD workflow: add failing tests first, implement the smallest change, then validate narrowly.

## Acceptance Criteria

1. A Broker request to Guest A that receives `307` with `Location: http://<advertised-guest-b>/path` is internally followed and returns Guest B's final response to the caller.
2. The same behavior works for `308` redirects.
3. Redirect following works for non-GET methods and replays the body from the beginning when the body stays within the configured buffer limit.
4. A test proves that the redirected Guest receives the full original body after the redirect decision, including bytes already read before the redirect response.
5. A request body larger than the configured replay buffer limit causes the original `307`/`308` response to be returned unchanged instead of being followed internally.
6. A redirect to an unadvertised hostname remains client-visible and is not resolved through DNS by the Broker.
7. The default maximum redirect count is `3` internal hops.
8. A caller can configure the maximum redirect count, and a focused test proves the configured value is enforced.
9. A redirect loop or more than the configured maximum internal hops fails with a clear redirect-limit error.
10. Direct Broker request, Agent, and fetch-style integrations have focused tests or integration coverage for internal redirect behavior.
11. Existing routing, streaming, and backpressure tests continue to pass.
12. Public documentation or package README guidance is updated if user-visible behavior or options are added.

## Out of Scope

1. General-purpose browser-style HTTP redirect handling beyond `307` and `308` internal verser2 route redirects.
2. DNS resolution for redirected internal hostnames.
3. Method safety classification or restrictions such as only following `GET`/`HEAD`.
4. Complex body replay policies beyond the configurable replay buffer limit.
5. HTTP/3, WebSocket forwarding, Python Host behavior, or new runtime packages.
6. Authentication, authorization, or routing-policy changes beyond route-table lookup of advertised routes.

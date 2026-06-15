# Specification: Verser2 Host Federation, Upstreams, and HA Foundations

## Overview

Verser2 currently routes Guest/Broker traffic through a single Host instance, making each Host a single point of failure and limiting multi-level architectures such as runner -> hub -> manager. This track introduces Host federation: a Verser2 Host can maintain outbound TLS HTTP/2 upstream connections to other Verser2 Hosts, import upstream route advertisements, export selected local route availability upstream, and forward Broker requests to the closest available route without requiring custom application plumbing.

The first implementation target is route-aware Host-to-Host federation, not generic L4 tunneling or HTTP/2 CONNECT tunneling. Existing Guest and Broker semantics must remain compatible: Guests still connect outbound and advertise domains; Brokers still send HTTP requests to advertised routes; Hosts preserve method, path, headers, status, body streaming, cancellation, and error semantics while adding upstream next-hop routing.

The design should also establish HA foundations. Brokers and downstream Hosts may observe route availability across multiple Host nodes and send new requests to another healthy candidate when a selected Host or upstream is unavailable. In-flight stream migration is explicitly not promised.

## Goals

- Allow a Verser2 Host to connect outbound to one or more upstream Verser2 Hosts over TLS HTTP/2.
- Allow downstream Hosts to import route advertisements from upstream Hosts and export their locally available Guest routes upstream.
- Preserve the current Guest/Broker route-based HTTP forwarding flow while enabling multi-level topologies such as runner -> hub -> manager.
- Resolve routes by closest availability:
  - Prefer a route served locally by the current Host when available.
  - Use imported upstream route candidates when no local candidate is available.
  - Prevent route loops and enforce bounded hop counts.
- Authorize upstream links through an application callback, using mTLS certificate identity when configured.
- Expose enough Root/Intermediate/Leaf certificate-chain context for authorization decisions where Node.js TLS provides it or where reusable certificate extraction can safely support it.
- Support basic HA semantics for new requests across multiple route candidates without active request migration.
- Keep reusable protocol shapes, route metadata, errors, TLS identity helpers, and authorization context types in `@signicode/verser-common` where appropriate.

## Functional Requirements

### Host identity and upstream configuration

- A Host participating in federation must have a stable `hostId` distinct from Guest and Broker peer IDs.
- Host APIs must support configuring upstream connections at Host creation and/or connecting upstreams after creation.
- Each upstream configuration must include at minimum:
  - upstream identifier or URL,
  - TLS trust/client identity configuration compatible with the existing TLS option model,
  - route import/export policy defaults,
  - reconnect behavior,
  - maximum hop limit or a default inherited from Host options.
- Upstream HTTP/2 sessions must be long-lived, reconnectable, and observable through lifecycle events.
- Host must still work correctly when no upstreams are configured or when all upstreams are unavailable, serving only locally available routes.

### Route federation

- Federated Hosts must exchange route information using versioned protocol metadata that can carry:
  - domain,
  - target ID,
  - origin Host ID,
  - next-hop Host ID,
  - hop count,
  - via/visited Host IDs for loop prevention,
  - source classification such as local or upstream.
- Existing Broker route-control frames must remain backward compatible. Legacy Brokers should continue to receive route records in the current shape unless a new API explicitly exposes richer metadata.
- Local Guest routes must override imported upstream routes for the same route identity when local routes are available.
- Imported routes must be withdrawn when the upstream session disconnects or reports retraction.
- The Host must reject or suppress routes that would create loops, exceed hop limits, or conflict with explicit local route ownership rules.

### Request forwarding

- When a Broker request targets a route that resolves to an upstream candidate, the downstream Host must forward the request to the upstream Host over HTTP/2 while preserving streaming and backpressure.
- Forwarding must preserve existing HTTP semantics including method, path, headers, request body, response status, response headers, response body, abort/cancellation, timeout, and structured error mapping.
- The implementation must avoid mandatory full-body buffering for ordinary forwarded requests.
- Forwarding metadata must identify source peer, source Host, target route, hop count, and visited Host chain for authorization and loop prevention.
- If an upstream route disappears before dispatch, the request must fail with a clear structured error or select another eligible route candidate if safe.

### Authorization and trust

- Upstream link establishment must be guarded by an application-provided authorization callback.
- If mTLS is configured, the authorization context must include TLS authorization state and certificate identity information for the connecting Host.
- Certificate trust must support normal CA-chain validation, including Root CA -> Intermediate/Leaf CA -> client certificate deployments, using Node.js TLS configuration rules.
- mTLS trust must be treated as transport evidence, not sufficient policy by itself; the callback decides whether the upstream Host identity and advertised capabilities are allowed.
- Authorization failures must produce explicit lifecycle/error events and must close or reject the upstream link predictably.
- The track may define additional route import/export or per-forward authorization contexts if needed by the design, but upstream link authorization is mandatory.

### HA behavior

- Route state may contain multiple candidates for the same domain/target when multiple Hosts advertise availability.
- Route state must in such case include hop distance so that Brokers can prefer the closest candidate.
- New requests may fail over to another healthy candidate when the selected Host/upstream is unavailable before response headers are received and retry is safe.
- Safe automatic retry is limited to replayable/idempotent requests or caller-approved retry policy. Non-replayable streaming bodies must not be retried transparently.
- Existing in-flight requests fail if their selected Host/session/lease dies; active request migration is out of scope.
- Route tables are eventually consistent. The implementation must document consistency limitations and route withdrawal behavior.

### Documentation

- Document the new Host federation topology with examples for runner -> hub -> manager and basic multi-node Host HA.
- Document TLS/mTLS setup for upstream Host links and CA-chain expectations.
- Document failure modes, retry limitations, route conflict behavior, and non-goals.

## Non-Functional Requirements

- Preserve current public Guest and Broker behavior unless explicitly extended by new APIs.
- Preserve HTTP streaming/backpressure behavior for request and response bodies.
- Maintain strict TypeScript types and reusable shared protocol definitions.
- Follow the repository TDD workflow: write failing tests first, implement minimally, validate narrowly, and update documentation when behavior changes.
- Maintain at least 95% meaningful test coverage for changed behavior or record justified exceptions.
- Avoid introducing new external runtime dependencies unless explicitly justified and reflected in `tech-stack.md`.
- Avoid making Host depend on Guest runtime packages; shared behavior should live in `@signicode/verser-common` or Host internals.

## Acceptance Criteria

- A downstream Host can connect outbound to an upstream Host over TLS HTTP/2 using configured trust and optional client identity.
- An upstream authorization callback can accept or reject a federated Host link based on Host identity and certificate context.
- A Guest connected to a downstream Host can be reachable from a Broker connected to an upstream Host through route federation without application-specific forwarding code.
- A Broker request forwarded across at least one Host upstream preserves method, path, headers, status, body streaming, and cancellation/error behavior.
- If a downstream Host and its upstream both advertise the same available route, the downstream Host selects the local route for local requests.
- Route withdrawal propagates when a federated Host or Guest disconnects.
- Loop prevention and hop-limit enforcement are tested.
- New-request failover is tested for an eligible route candidate when an upstream is unavailable before response headers are received.
- Non-replayable active streams are not migrated or retried transparently.
- Existing Guest/Broker tests continue to pass unchanged or with only compatible expectations.
- Documentation covers topology, configuration, authorization, HA semantics, limitations, and troubleshooting.

## Out of Scope

- Generic L4 tunneling and HTTP/2 CONNECT/Extended CONNECT tunneling.
- HTTP/3.
- Browser, Rust, Go, Java, or Python Host behavior.
- WebSocket/upgrade forwarding, trailers, and informational responses.
- Full public gateway authentication/authorization policy.
- Certificate issuance, CA lifecycle management, or PKI tooling beyond consuming TLS material.
- Consensus, leader election, distributed locks, durable route registry, or exactly-once delivery.
- Transparent migration of active requests between Hosts.
- Transparent retry of non-idempotent or non-replayable streaming requests.
- Wildcard/suffix route matching unless a later track explicitly changes exact hostname routing.

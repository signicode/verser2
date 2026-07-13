# WebSocket Federation Implementation

## Overview

Enable full VWS/1 WebSocket routing across the same discoverable route topology
used for HTTP requests. A local Broker must be able to open a WebSocket to a
local Guest, a Guest reached through a directly connected remote Host, or a
Guest reached through an arbitrary valid federation chain. The implementation
must preserve VWS/1 semantics and expose native-feeling Node, Bun, and Python
APIs rather than requiring application authors to work with transport frames.

## Functional Requirements

1. The Host must route a Broker WebSocket open to the exact active
   `(targetId, domain)` candidate, using local Guest leases for local routes and
   a dedicated versioned federation-VWS stream for imported routes.
2. Federation-VWS streams must forward VWS/1 traffic hop by hop. They must not
   use generic HTTP upgrade tunneling or bypass the existing federation
   authorization/session model.
3. Federation routing must support arbitrary valid multi-hop paths, apply the
   existing origin/via/hop-limit and loop protections, and choose failover
   candidates only before a WebSocket is accepted. An accepted socket must
   never migrate to another candidate.
4. Local and federated connections must preserve VWS/1 open metadata,
   subprotocol negotiation, text and binary message boundaries, ping/pong,
   close code and reason, and structured pre-accept errors.
5. Backpressure, cancellation, stream reset, timeout, Host shutdown, upstream
   disconnect, Guest disconnect, and malformed or oversized VWS frames must
   be handled incrementally without unbounded buffering or leaked streams.
   Loss of the selected route or upstream after acceptance must close the active
   socket through a deterministic abnormal-close/error path; new opens must
   fail normally.
6. Route advertisements remain unchanged and protocol-neutral: Brokers do not
   preflight a WebSocket capability. An endpoint may explicitly reject an open
   as unavailable with a 404-style result. When the selected peer or endpoint
   does not provide a valid WebSocket negotiation response, the Broker must
   return a deterministic negotiation-failure error rather than an
   implementation-specific federation or `missing-guest` error.
7. Add native public WebSocket integration for Node and Bun Guests and Broker
   compatibility surfaces, using thin runtime adapters where sufficient while
   keeping VWS/1 as the shared transport protocol. Bun support must use Bun's
   native upgrade/WebSocket model rather than a Verser-only application API.
8. Add Python async Broker WebSocket support and retain ASGI WebSocket Guest
   compatibility so Python applications can both initiate and receive local and
   federated WebSockets.
9. Existing direct Node and Python VWS/1 behavior must remain compatible.
   Existing HTTP/1 request routing, federation, authorization, and route
   lifecycle behavior must not regress.

## Security and Compatibility Requirements

- Bind Broker opens and federation-VWS streams to authenticated HTTP/2
  sessions; never trust forwarded peer or origin identifiers supplied by an
  untrusted caller.
- Keep message/frame limits, bounded queues, and route authorization intact at
  every federation hop.
- Use an explicit, versioned federation-VWS endpoint/contract. A peer without
  that capability must produce the defined negotiation-failure outcome, not be
  sent an unknown protocol or silently downgraded.
- Route revocation and lifecycle cleanup must not allow a consumed Guest lease
  to be reused.

## Acceptance Criteria

- Node, Bun, and Python Brokers can open standard runtime-facing WebSocket
  connections to Node, Bun, and Python Guests when supported by the selected
  endpoint.
- Each supported source/destination runtime pair works for direct local,
  directly remote, and arbitrary multi-hop federated routes where the topology
  permits it.
- A real imported-only route succeeds without requiring a local Guest with the
  same target ID; the former unsupported-federation regression is replaced.
- Success coverage proves subprotocol negotiation, text and binary traffic,
  ping/pong, close propagation, and standard runtime integration behavior.
- Failure coverage proves explicit 404-style unavailable WebSocket rejection,
  missing negotiation responses, denied authorization, mixed-version peers,
  malformed and oversized frames, loops, hop limits, pre-accept failover,
  revocation, slow-consumer backpressure, cancellation, upstream loss, Guest
  disconnect, and Host shutdown.
- Focused and full validation demonstrate no leaked leases or streams and at
  least 95% meaningful coverage for changed behavior.

## Out of Scope

- Browser, Rust, Go, Java, HTTP/3, and Python Host implementations.
- Reconnection, session resumption, migration, or failover after acceptance.
- Changes to route advertisements or a WebSocket capability preflight.
- Turning Verser2 into a public gateway or adding application-level
  authentication and authorization policy.

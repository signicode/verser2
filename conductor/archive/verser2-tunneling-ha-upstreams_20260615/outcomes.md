# Outcomes: Verser2 Host Federation, Upstreams, and HA Foundations

## Completed work

- Added runtime-neutral federation protocol foundations in `@signicode/verser-common`, including Host IDs, federation handshake and route metadata shapes, hop/loop validation, federation route control frames, and structured error coverage.
- Refactored Host route state around route candidates with local-first selection, imported route storage, deterministic ordering, withdrawal handling, and legacy Broker compatibility.
- Added outbound Host upstream links with `/verser/host/federation` handshake, authorization through `tls.clientAuth.authorizeFederation`, mTLS identity context, dynamic `connectUpstream()`, `getUpstreams()`, and close lifecycle handling.
- Added persistent Host-to-Host route streams at `/verser/host/federation/routes`, route import/export policy, multi-hop propagation, loop filtering, hop limits, and route withdrawal propagation.
- Added Host-to-Host federated request forwarding at `/verser/host/federation/request`, preserving method, path, headers, status, response headers, request/response bodies, and streaming behavior across federated paths.
- Added HA foundations for new-request candidate selection: local candidates first, shorter federated hop counts next, deterministic fallback ordering, and fallback before forwarding starts when a preferred candidate is unavailable.
- Documented Host federation, runner -> hub -> manager topology, TLS/mTLS authorization, HA limitations, failure modes, and explicit non-goals.

## Validation and reviews

- Phase validations covered common protocol, Host route registry, upstream lifecycle, federation route propagation, federated forwarding, HA selection, docs, package checks, build, lint, and full tests.
- Final documented validation included `npm run lint`, `npm run build`, `npm test`, focused federation/route/Broker/package/docs tests, and Node experimental coverage runs for focused suites.
- Automated reviews found and drove fixes for malformed metadata validation, route advertisement safety before forwarding, lifecycle leaks, handshake hangs, inbound lifecycle gaps, duplicate races, route-stream close handling, federation example wording, and post-review Copilot findings.
- Post-completion PR follow-up required configured Host IDs for federation, removed fallback `host-local` advertisements, required successful handshakes to return a valid remote Host ID, cleaned timed-out request waiters, preserved downstream structured error codes, and improved unusable-candidate `upstream-unavailable` behavior.

## Deferred or intentional limits

- Generic L4 tunneling, HTTP CONNECT/Extended CONNECT tunneling, HTTP/3, active request migration, consensus, leader election, durable route registry, exactly-once delivery, and transparent retry of non-replayable streams remain out of scope.
- Mid-stream Broker abort propagation across federated forwarding has cleanup hooks but remains a hardening area.
- `packages/verser2-host/src/lib/node-http2-verser-host.ts` grew large; a future refactor should extract federation links, route streams, request forwarding, lease routing, and local peer coordination into smaller units.

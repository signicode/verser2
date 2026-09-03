# Route authorization deepwork

## Context

- Branch: `feat/route-auth`
- Issue: #61 — cached, revocable first-use federation route authorization.
- Authorization is hop-local only: immediate previous advertised domain to the
  concrete next selected domain. It is not end-to-end Broker-to-Guest policy.

## Phases

1. **Design and plan review** — map the current federation metadata and route
   lifecycle seams; publish an implementation plan; obtain reviewer approval.
2. **Authorization foundation** — add the Host-level hook, hop-local metadata,
   cache/revocation API, lifecycle invalidation, and focused tests.
3. **Forwarding enforcement** — enforce before request bodies are piped across
   all relevant federated HTTP and VWS paths; add streamed-denial coverage.
4. **Validation and delivery** — run focused and full checks, resolve review
   findings, commit, open a PR linked to #61, and complete final validation.

## Status

- Current phase: 4 — final validation and delivery. Phase 2 checkpoint:
  `b1bada4`; draft PR: #62. Phase 3 passed formal review.
- Deepwork skill is unavailable in this environment; these requested deepwork
  controls are being followed manually.

## Reviewed plan

1. Add a Host-level, async hop-local callback and a cached-allow revocation
   API. Its context and cache key are exactly normalized
   `{ previousAdvertisedDomain, nextSelectedDomain }`; denied results are not
   cached.
2. Invalidate allowed pairs on relevant route mutations and Host shutdown.
   After awaiting an initial decision, revalidate affected routes before
   forwarding.
3. Enforce before body/frame forwarding in remote and local Broker HTTP,
   inbound federation HTTP dispatch, Broker VWS, and inbound/upstream
   federation VWS.
4. Test caching, denial without body consumption, revocation/invalidation,
   race handling, and every enforcement path; then run focused and full
   validation before committing and opening the linked PR.

## Plan review outcome

The authorization callback receives the already-resolved immediate previous and
next hops. It only decides allow or deny for their domains; it does not select,
validate, or authorize either domain through another callback. Existing hop
admission and route resolution grant the domains. Forwarding replaces the
previous-hop identity and never carries origin or hop history for authorization.

The current protocol can use the incoming selected domain as a hop-local baton:
each forwarding Host replaces it with its newly selected candidate domain. For
a Broker-originated first leg, add an optional configurable Broker hop-domain.
When absent, it remains undefined. When remote mTLS is used, registration must
bind the supplied Broker ID/domain to an exact DNS SAN on that Broker
certificate (no wildcard or CN fallback). This is the only first-leg identity
source; no origin or route history is introduced.

## Final plan amendments pending approval

- Registration accepts `brokerHopDomain` only for Brokers and stores it only
  after validation. With Host mTLS enabled, its normalized value must exactly
  match a DNS SAN on the peer certificate.
- Remote HTTP requests must bind `x-verser-source-id` to a Broker registered
  on the current HTTP/2 session before its stored hop-domain is used. Local
  Broker handles are already Host-owned; VWS retains its existing session
  binding.
- One Host-private authorization helper owns cache lookup, pending-decision
  sharing, successful-allow insertion, pair revocation, invalidation, and
  post-await route revalidation. It is invoked after candidate resolution and
  before federation stream/open-frame/body forwarding.
- If the route authorizer is configured, a Broker-selected federation request
  requires a defined `brokerHopDomain`; otherwise it fails with
  `authorization-denied` before forwarding. The rule applies to both remote
  and local Brokers. Local Broker options persist the same optional value but
  are exempt from certificate matching.
- Invalidation covers local and imported route changes, imported snapshot
  replacement, direct lifecycle removal, federation-link removal, explicit
  pair revoke, and Host shutdown.
- Invalidation advances a generation token. A pending allow may cache and
  forward only if its token is still current after the callback returns, so an
  explicit revoke or route loss cannot be undone by an earlier decision.

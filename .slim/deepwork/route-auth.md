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

- Complete — Phase 2 and Phase 3 passed formal review; final `npm test` and
  `npm run lint` passed. Commits: `b1bada4`, `6db6fac`, `02fe42d`; PR: #62.
- Deepwork skill is unavailable in this environment; these requested deepwork
  controls are being followed manually.

## Follow-up: cache TTL and route/session binding

- Complete — final review passed; `npm test` and `npm run lint` passed.
  Follow-up commit: `c5bc933` on PR #62.
- Rename the public Broker option from `brokerHopDomain` to `brokerDomain`.
  The rename covers registration payload/context, Node/Bun/Python and local
  Broker options, docs, and tests. It is a clean replacement: the legacy field
  is rejected rather than accepted as an alias.
- The positive cache TTL defaults to `60_000` ms. The separately configurable
  negative cache TTL defaults to `Math.floor(positiveTtlMs / 10)` (`6_000` ms
  by default). TTL values are finite non-negative integers; `0` disables that
  cache class. Entries expire lazily, without timers; callback errors are not
  cached.
- “Session” is the logical route-bearing unit: an authorized federation HTTP
  request stream or an accepted federated VWS connection. It retains its
  resolved route/authorization for its lifetime; TTL expiry, explicit revoke,
  and route lifecycle changes apply only to new forwarding/open decisions.
  Physical HTTP/2 sessions remain multiplexed and are never route-bound.
- Revoke clears an allow or deny result and invalidates an in-flight decision
  for the pair. Route/import/link/close invalidation clears both result classes
  and prevents stale pending outcomes from authorizing or repopulating either.

## Follow-up: per-decision cache TTLs

- Complete — final review passed; full test and lint validation passed.
- Route-authorizer allow/deny decisions may optionally specify `cacheTtlMs`:
  omission uses the configured Host cache TTL, `0` disables caching for that
  result, and `Infinity` retains it until explicit revoke or lifecycle
  invalidation. Callback errors remain uncached.
- The callback accepts legacy `'allow'`/`'deny'` strings or
  `{ decision, cacheTtlMs? }`; an omitted/undefined override uses the Host
  TTL. Only `0`, a positive safe integer with a finite representable expiry,
  or `Number.POSITIVE_INFINITY` is valid. Invalid/missing decisions, null,
  non-numbers, NaN, negative or fractional values, unsafe integers, and
  negative infinity fail deterministically without caching.
- Callback output is normalized once to `{ decision, ttlMs }`. A current
  pending allow may take effect/cache; a current pending deny may deny/cache;
  stale pending results may do neither. Revoke/invalidation clears finite and
  infinite entries; a `0` result still resolves its shared in-flight callers.
- Tests cover legacy strings; finite, zero, and infinite allow/deny overrides;
  invalid uncached output; expiry arithmetic; single-flight; pending/revoked
  and lifecycle-invalidated object results; and documentation that `Infinity`
  is callback-only while Host TTL options remain finite.

## Original reviewed plan (superseded cache terminology)

1. Add a Host-level, async hop-local callback and a cached-pair revocation
   API. Its context and cache key are exactly normalized
   `{ previousAdvertisedDomain, nextSelectedDomain }`. The original
   allow-only cache is superseded by the separately configured negative cache
   described above.
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
a Broker-originated first leg, add an optional configurable Broker domain.
When absent, it remains undefined. When remote mTLS is used, registration must
bind the supplied Broker ID/domain to an exact DNS SAN on that Broker
certificate (no wildcard or CN fallback). This is the only first-leg identity
source; no origin or route history is introduced.

## Final plan amendments pending approval

- Registration accepts `brokerDomain` only for Brokers and stores it only
  after validation. With Host mTLS enabled, its normalized value must exactly
  match a DNS SAN on the peer certificate.
- Remote HTTP requests must bind `x-verser-source-id` to a Broker registered
  on the current HTTP/2 session before its stored hop-domain is used. Local
  Broker handles are already Host-owned; VWS retains its existing session
  binding.
- One Host-private authorization helper owns cache lookup, pending-decision
  sharing, allow-or-deny insertion, pair revocation, invalidation, and
  post-await route revalidation. It is invoked after candidate resolution and
  before federation stream/open-frame/body forwarding.
- If the route authorizer is configured, a Broker-selected federation request
  requires a defined `brokerDomain`; otherwise it fails with
  `authorization-denied` before forwarding. The rule applies to both remote
  and local Brokers. Local Broker options persist the same optional value but
  are exempt from certificate matching.
- Invalidation covers local and imported route changes, imported snapshot
  replacement, direct lifecycle removal, federation-link removal, explicit
  pair revoke, and Host shutdown.
- Invalidation advances a generation token. A current pending allow may cache
  and authorize forwarding; a current pending deny may cache and deny. A stale
  pending outcome may do neither, so an explicit revoke or route loss cannot
  be undone by an earlier decision.

## Follow-up acceptance criteria

- Test default/derived TTLs, invalid and zero values, lazy allow/deny expiry,
  callback-error non-caching, and single-flight after expiry.
- Test revoke and all lifecycle invalidations for cached and pending allow/deny
  results, plus reauthorization of new work after revocation.
- Test that a route-bound federation HTTP stream and accepted federated VWS
  connection continue without reauthorization through expiry/revocation, while
  new forwarding/open decisions reauthorize.
- Test the `brokerDomain` replacement across normalized remote/local
  registration, mTLS DNS-SAN binding, every supported Broker runtime, and
  legacy-field rejection.

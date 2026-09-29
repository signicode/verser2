# Concurrent authenticated Broker sessions (#79)

Branch: `fix/79-concurrent-broker-sessions` (base: `main`). PR: https://github.com/signicode/verser2/pull/80.

## Goal and acceptance

One logical Broker ID may register on multiple independent TLS HTTP/2 sessions without an arbitrary count cap, including sessions presenting different trusted leaf certificates. Each connection independently passes TLS and registration authorization; only an authenticated certificate, `broker` role, and exact normalized registration may join that ID. A rejected/closed/racing session cannot use or evict its sibling. Broker HTTP and WebSocket ingress always belongs to the requesting registered session (including federation forwarding), and equal request IDs on separate connections remain independent. Each connection gets route changes; detaching one or closing its registration control stream closes only that Broker session, without disconnecting siblings. Guest, local peer, and federation unique ownership remains unchanged. See issue #79 for the originally reported case; this different-certificate allowance supersedes its same-leaf restriction by explicit user direction.

## Phase 1 — secure session ownership and baseline

- [x] Create branch and PR review surface for #79; record URL.
- [x] Add failing tests for unregistered/spoofed Broker HTTP ingress and racing registration authorization; closed/pending registration is protective coverage.
- [x] Bind remote Broker HTTP ingress to its own admitted session regardless of route authorizer, and make registration's asynchronous commit race-safe across remote/local peers; retain unique-ID rule in this phase. Guard post-await cancellation and Host shutdown.
- [x] Validate focused tests, review security/lifecycle, record coverage and commit.

Gate: Oracle checks that ingress and admission are closed to unregistered, pending and stale sessions before multiplicity is introduced.

## Phase 2 — authenticated Broker session multiplicity

- [x] Add failing real-mTLS tests for same-cert same-ID distinct sessions (streaming, identical request IDs, route updates, detach/reconnect), and rejecting invalid certificate/registration/role without eviction.
- [x] Implement per-connection membership/control streams with an initially same-leaf certificate restriction, matching registration and no count limit; preserve Guest/local/federation ownership. User-directed certificate-policy revision below supersedes same-leaf restriction.
- [x] Confirm HTTP, WebSocket and federated request attribution/cancellation, run focused and broader validation and document identity contract.
- [x] Review security/lifecycle, record coverage and commit interim Phase 2 checkpoint; final PR update follows Phase 2b.

Gate: Oracle checks per-session auth and request/route/lifecycle isolation including competing admissions; an explicit formal code review checks acceptance and tests before delivery.

Verification: TDD failing cases first; `npm run build`, targeted `node --test` integration suites after build/stage, `npm run lint`, `npm test` when finished. Include streaming guard and bounded body handling. No new wire/public protocol field. Existing `@signicode/verser-common` registration/certificate identity helpers are reused; Host-private lifecycle and membership remain Host-specific unless actual reuse emerges. Cover changed behavior meaningfully to repository's 95% target; report any coverage limits. Do not touch unrelated `.slim/worktrees/`.

## Validation and checkpoints

Phase 1 red: spoofed Broker HTTP request unexpectedly dispatched to local Guest (200); concurrent same-ID registrations both succeeded. Before bounded remediation a cancelled request was forwarded to a later Guest lease (210 bytes) and federation request authorization continued after cancellation; pending local admission succeeded after shutdown. Green: `npm run build`; `node --test test/host.test.js` (15/15); `node --test test/local-peers.test.js` (32/32); `node --test test/host-route-authz-forwarding.test.js` (15/15); `npm run lint`; `git diff --check`. Meaningful changed-behavior coverage: negative ingress, concurrent and closed admissions, shutdown/restart, queued lease/federation cancellation; positive existing Broker/local Guest/federation tests. Raw line coverage not measured, so numeric 95% not claimed. Oracle gate 1 required one bounded remediation and focused re-review; no remaining material concerns. Common helpers reused; session state is Host-specific, no common duplicate introduced. Rebased checkpoint commit: `76df72f`. PR #80 created on this branch with the intended final behavior described.

Phase 2 red: same-leaf same-ID sibling and simultaneous admission were rejected on baseline. Green targeted suites: shared-identity 6/6 (including mTLS sibling, same-session duplicate, racing admission, denial, collision, spoofed VWS), Broker routing 56/56, Host 15/15, TLS configuration 47/47, Host route-authorizer 15/15, federated VWS 6/6, WebSocket federation 4/4, WebSocket 9/9, Host upstreams 49/49 and docs 8/8. Full `npm test` initially failed seven raw Broker fixtures (formerly able to spoof a sibling's session) and the first guarded mTLS test memory limit. Both were repaired without relaxing the new source check or the 1 MiB guard. MemLab 2.0.5 ran locally in ignored `.tmp/memlab/` on GC-aligned baseline/target/final snapshots; it reported zero retained JS leaks, external growth ~49 KiB; a representative mTLS warmup removed first-use allocation from the guarded case. Focused bounded test passed 3 times. Final `npm test`: 385/385 in partition 1; 173 pass/4 skip in partition 2; zero failures. `npm run lint` and `git diff --check` passed. Numeric raw changed-line coverage remains to be measured; meaningful positive/negative coverage above. Common primitives reused; Host-specific per-session membership remains Host-local. Oracle gate 2 and formal Reviewer pending.

Interim Phase 2 rebased checkpoint: `22d725c`, explicitly requested by user before final follow-ups; code and docs still describe the prior same-leaf rule. Oracle gate 2 found a pre-existing Broker VWS cancellation race; user requested the bounded fix rather than deferring it. Formal Reviewer PASS preceded the user-directed revision.

## Phase 2b — user-directed bounded follow-ups

- [x] Admit different trusted Broker certificates under one ID when *each* connection independently passes TLS and registration authorization and exact normalized registration/role matches. Do not inherit a sibling's allow result; missing or unverified certificates remain ineligible.
- [x] Test that a separately valid but different registration is rejected without evicting the existing Broker. Test the newly allowed distinct trusted-certificate case without weakening invalid-cert rejection.
- [x] Stop forwarding a cancelled Broker VWS open after pending authorization/acquisition; close any destination acquired after cancellation, leaving a same-ID sibling unaffected.
- [x] Treat closure of a successfully admitted Broker registration control stream as termination of that physical HTTP/2 session, without closing sibling sessions.
- [x] Update affected documentation/codemaps/tests only for these behavior changes; run focused and full bounded tests, lint, security and formal review, then commit and update PR #80.

No Guest lease/control redesign or other unrelated repairs. The required certification is per session, not same fingerprint across sessions; this is an explicit user change to the original issue's threat assumption. Do not touch unrelated `.slim/worktrees/`.

Phase 2b TDD red: different trusted CA-signed leaf was rejected, admitted Broker control stream close did not tear down its session, and cancelled VWS authorization attempted another route. Green: focused VWS/shared identity suites 27/27; Host 15/15, TLS 47/47, Host federation VWS 6/6, WebSocket 9/9, Host upstreams 49/49, docs 8/8. Full `npm test`: partition 1 387/387, partition 2 173 passed/4 skipped; 0 failures with unchanged 1 MiB per-test growth guard. `npm run lint`, `git diff --check` passed. New fixture is a second trusted CA-signed leaf with the same valid Broker-domain SAN and a distinct fingerprint. A valid registration difference and admitted-versus-rejected control closure are tested. Cancellation test covers deferred authorization and no route fallback; post-acquisition destination cleanup is implemented but not isolated by a deterministic acquisition-race test. Raw changed-line coverage unmeasured; positive/negative behavior evidence above. Reused existing Host-private session/group logic and shared TLS identity primitives; no duplicated common implementation.

Gate 2 focused Oracle re-review attempt 2: prior VWS cancellation finding resolved; no new material security or lifecycle risk identified with different independently authorized certificates or per-session control teardown. Formal Reviewer PASS for amended Phase 2b acceptance; no blocking findings. Both noted a nonblocking evidence limit: cancellation after destination *acquisition* has explicit cleanup in code but no separate deterministic acquisition-race test. Raw changed-line coverage remains unmeasured; report this rather than claiming numeric 95%. No unrelated Guest/federation redesign was added. Rebased final behavior commit: `8b39524` (following user-requested interim checkpoint `22d725c`). User-requested rebase onto `origin/main` at `8e50abf` replayed all four PR commits without conflicts or patch changes; rebased `npm test` passed 387/387 and 173 passed/4 skipped, with `npm run lint` and diff check passing. Rebased PR branch updates require explicit force-with-lease confirmation; merge remains manual through protected main.

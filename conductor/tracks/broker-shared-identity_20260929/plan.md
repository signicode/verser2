# Concurrent authenticated Broker sessions (#79)

Branch: `fix/79-concurrent-broker-sessions` (base: `main`). PR: https://github.com/signicode/verser2/pull/80.

## Goal and acceptance

One issued Broker leaf certificate and logical Broker ID may register on multiple independent TLS HTTP/2 sessions without an arbitrary count cap. Every connection is independently authorized; only the same authenticated leaf identity, role, and exact normalized registration may join an existing remote Broker identity. A rejected/closed/racing session cannot use or evict its sibling. Broker HTTP and WebSocket ingress always belongs to the requesting registered session (including federation forwarding), and equal request IDs on separate connections remain independent. Each connection gets route changes; detach one without disconnecting siblings. Guest, local peer, and federation unique ownership remains unchanged. See issue #79 for detailed cases.

## Phase 1 — secure session ownership and baseline

- [x] Create branch and PR review surface for #79; record URL.
- [x] Add failing tests for unregistered/spoofed Broker HTTP ingress and racing registration authorization; closed/pending registration is protective coverage.
- [x] Bind remote Broker HTTP ingress to its own admitted session regardless of route authorizer, and make registration's asynchronous commit race-safe across remote/local peers; retain unique-ID rule in this phase. Guard post-await cancellation and Host shutdown.
- [x] Validate focused tests, review security/lifecycle, record coverage and commit.

Gate: Oracle checks that ingress and admission are closed to unregistered, pending and stale sessions before multiplicity is introduced.

## Phase 2 — authenticated Broker session multiplicity

- [x] Add failing real-mTLS tests for same-cert same-ID distinct sessions (streaming, identical request IDs, route updates, detach/reconnect), and rejecting mismatched certificate/registration/role without eviction.
- [x] Implement per-connection membership/control streams and matching leaf fingerprint and registration with no count limit; preserve Guest/local/federation ownership.
- [x] Confirm HTTP, WebSocket and federated request attribution/cancellation, run focused and broader validation and document identity contract.
- [ ] Review security/lifecycle, record coverage and commit; update PR.

Gate: Oracle checks per-session auth and request/route/lifecycle isolation including competing admissions; an explicit formal code review checks acceptance and tests before delivery.

Verification: TDD failing cases first; `npm run build`, targeted `node --test` integration suites after build/stage, `npm run lint`, `npm test` when finished. Include streaming guard and bounded body handling. No new wire/public protocol field. Existing `@signicode/verser-common` registration/certificate identity helpers are reused; Host-private lifecycle and membership remain Host-specific unless actual reuse emerges. Cover changed behavior meaningfully to repository's 95% target; report any coverage limits. Do not touch unrelated `.slim/worktrees/`.

## Validation and checkpoints

Phase 1 red: spoofed Broker HTTP request unexpectedly dispatched to local Guest (200); concurrent same-ID registrations both succeeded. Before bounded remediation a cancelled request was forwarded to a later Guest lease (210 bytes) and federation request authorization continued after cancellation; pending local admission succeeded after shutdown. Green: `npm run build`; `node --test test/host.test.js` (15/15); `node --test test/local-peers.test.js` (32/32); `node --test test/host-route-authz-forwarding.test.js` (15/15); `npm run lint`; `git diff --check`. Meaningful changed-behavior coverage: negative ingress, concurrent and closed admissions, shutdown/restart, queued lease/federation cancellation; positive existing Broker/local Guest/federation tests. Raw line coverage not measured, so numeric 95% not claimed. Oracle gate 1 required one bounded remediation and focused re-review; no remaining material concerns. Common helpers reused; session state is Host-specific, no common duplicate introduced. Checkpoint commit: `72d1a12`. PR #80 created on this branch with the intended final behavior described.

Phase 2 red: same-leaf same-ID sibling and simultaneous admission were rejected on baseline. Green targeted suites: shared-identity 6/6 (including mTLS sibling, same-session duplicate, racing admission, denial, collision, spoofed VWS), Broker routing 56/56, Host 15/15, TLS configuration 47/47, Host route-authorizer 15/15, federated VWS 6/6, WebSocket federation 4/4, WebSocket 9/9, Host upstreams 49/49 and docs 8/8. Full `npm test` initially failed seven raw Broker fixtures (formerly able to spoof a sibling's session) and the first guarded mTLS test memory limit. Both were repaired without relaxing the new source check or the 1 MiB guard. MemLab 2.0.5 ran locally in ignored `.tmp/memlab/` on GC-aligned baseline/target/final snapshots; it reported zero retained JS leaks, external growth ~49 KiB; a representative mTLS warmup removed first-use allocation from the guarded case. Focused bounded test passed 3 times. Final `npm test`: 385/385 in partition 1; 173 pass/4 skip in partition 2; zero failures. `npm run lint` and `git diff --check` passed. Numeric raw changed-line coverage remains to be measured; meaningful positive/negative coverage above. Common primitives reused; Host-specific per-session membership remains Host-local. Oracle gate 2 and formal Reviewer pending.

# Concurrent authenticated Broker sessions (#79)

Branch: `fix/79-concurrent-broker-sessions` (base: `main`). PR: pending.

## Goal and acceptance

One issued Broker leaf certificate and logical Broker ID may register on multiple independent TLS HTTP/2 sessions without an arbitrary count cap. Every connection is independently authorized; only the same authenticated leaf identity, role, and exact normalized registration may join an existing remote Broker identity. A rejected/closed/racing session cannot use or evict its sibling. Broker HTTP and WebSocket ingress always belongs to the requesting registered session (including federation forwarding), and equal request IDs on separate connections remain independent. Each connection gets route changes; detach one without disconnecting siblings. Guest, local peer, and federation unique ownership remains unchanged. See issue #79 for detailed cases.

## Phase 1 — secure session ownership and baseline

- [~] Create branch and PR review surface for #79; record URL (branch created; PR follows first checkpoint commit).
- [x] Add failing tests for unregistered/spoofed Broker HTTP ingress and racing registration authorization; closed/pending registration is protective coverage.
- [x] Bind remote Broker HTTP ingress to its own admitted session regardless of route authorizer, and make registration's asynchronous commit race-safe across remote/local peers; retain unique-ID rule in this phase. Guard post-await cancellation and Host shutdown.
- [~] Validate focused tests, review security/lifecycle, record coverage and commit.

Gate: Oracle checks that ingress and admission are closed to unregistered, pending and stale sessions before multiplicity is introduced.

## Phase 2 — authenticated Broker session multiplicity

- [ ] Add failing real-mTLS tests for same-cert same-ID distinct sessions (streaming, identical request IDs, route updates, detach/reconnect), and rejecting mismatched certificate/registration/role without eviction.
- [ ] Implement per-connection membership/control streams and matching leaf fingerprint and registration with no count limit; preserve Guest/local/federation ownership.
- [ ] Confirm HTTP, WebSocket and federated request attribution/cancellation, run focused and broader validation and document identity contract.
- [ ] Review security/lifecycle, record coverage and commit; update PR.

Gate: Oracle checks per-session auth and request/route/lifecycle isolation including competing admissions; an explicit formal code review checks acceptance and tests before delivery.

Verification: TDD failing cases first; `npm run build`, targeted `node --test` integration suites after build/stage, `npm run lint`, `npm test` when finished. Include streaming guard and bounded body handling. No new wire/public protocol field. Existing `@signicode/verser-common` registration/certificate identity helpers are reused; Host-private lifecycle and membership remain Host-specific unless actual reuse emerges. Cover changed behavior meaningfully to repository's 95% target; report any coverage limits. Do not touch unrelated `.slim/worktrees/`.

## Validation and checkpoints

Phase 1 red: spoofed Broker HTTP request unexpectedly dispatched to local Guest (200); concurrent same-ID registrations both succeeded. Before bounded remediation a cancelled request was forwarded to a later Guest lease (210 bytes) and federation request authorization continued after cancellation; pending local admission succeeded after shutdown. Green: `npm run build`; `node --test test/host.test.js` (15/15); `node --test test/local-peers.test.js` (32/32); `node --test test/host-route-authz-forwarding.test.js` (15/15); `npm run lint`; `git diff --check`. Meaningful changed-behavior coverage: negative ingress, concurrent and closed admissions, shutdown/restart, queued lease/federation cancellation; positive existing Broker/local Guest/federation tests. Raw line coverage not measured, so numeric 95% not claimed. Oracle gate 1 required one bounded remediation and focused re-review; no remaining material concerns. Common helpers reused; session state is Host-specific, no common duplicate introduced. Checkpoint commit: pending.

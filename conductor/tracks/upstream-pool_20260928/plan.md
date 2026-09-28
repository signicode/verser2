# Implementation Plan: Pool reverse federation request streams

## Phase 1: TDD pool implementation

- [x] Task: Add the opt-in `upstreamPool` public configuration
  - Extend `VerserHostUpstreamOptions` with `minWaitingStreams`, `maxOpenStreams`, `leaseAcquireTimeoutMs`, and `maxQueuedAcquires`.
  - Preserve the existing one-stream behavior when the option is omitted.
  - Validate finite, non-negative integer configuration and `maxOpenStreams >= minWaitingStreams` before opening an upstream session.
- [x] Task: Write failing Host upstream-pool tests
  - Cover invalid configuration, legacy single-stream behavior, independent long-lived and unary requests, pool replenishment, bounded queued acquisitions, timeout cleanup, cancellation cleanup, and close/reconnect cleanup.
  - Keep existing TLS, authorization, and streaming federation coverage as regressions.
- [x] Task: Implement pooled reverse federation request streams
  - Pool only `/verser/host/federation/request` reverse streams per outbound upstream link.
  - Keep one-shot downstream-to-upstream dispatch unchanged.
  - Coordinate inbound idle stream acquisition, bounded queueing, cancellation, timeout, and Host/link close cleanup.
  - Ensure active streams count toward maximum but not the waiting-stream floor.
- [x] Task: Validate Phase 1
  - Build, stage packages, run `test/host-upstreams.test.js`, and lint.
  - Review the Host-private implementation for duplicated lifecycle logic; no common extraction is expected because this behavior owns Node HTTP/2 stream lifecycle.

## Phase 2: Release preparation and verification

- [x] Task: Document public pooling behavior and update the changelog for 0.9.1.
- [x] Task: Prepare all package metadata for `0.9.1` using `npm run package:prepare-release -- --version 0.9.1`.
- [x] Task: Run release validation: lint, full test suite, package version policy, staged consumer tests, and tarball tests.
  - Validation: `npm run lint`, `npm test`, `npm run package:version-policy -- --version 0.9.1 --json`, staged and tarball consumer tests, and `npm run test:package-tarballs` all passed. The version policy classified `0.9.1` as stable with npm dist-tag `latest`.
- [ ] Task: Create the release commit and pull request only after explicit user confirmation; the protected main workflow must merge the PR manually.
- [ ] Task: Create and push the `v0.9.1` tag only after the release-preparation PR merges and explicit user confirmation.

## Design record

- Source inspection: `packages/verser2-host/src/lib/types.ts`, `node-http2-verser-host.ts`, `federation.ts`, and `test/host-upstreams.test.js`; the existing VWS pool is the closest Host-local lifecycle pattern.
- This is an opt-in, link-scoped pool. Each reverse request stream is independently leased so active long-lived requests do not block the waiting-stream floor.
- Reverse request stream policy is conveyed only after the existing federation handshake. Links without policy headers remain in legacy one-stream mode.
- Supplied `upstreamPool` defaults are `minWaitingStreams: 4`, `maxOpenStreams: 16`, `leaseAcquireTimeoutMs: 5000`, and `maxQueuedAcquires: 128`; omission retains the legacy one-stream mode.
- Validation: `npm run build`, `npm run stage:packages`, `npm run test:bounded -- -- test/host-upstreams.test.js` (49 passing), and `npm run lint` passed. Final review passed after confirming local Broker AbortSignals reach federated acquisition and cancelled waiters are removed.

# Specification: Broker dispatch to imported upstream Host routes

## Overview

Implement support for a Broker connected to a downstream Verser2 Host to dispatch requests to routes imported from an upstream Host federation link. This addresses GitHub issue #24: `Support Broker dispatch to imported upstream Host routes`.

The intended topology is:

```text
sequence/runtime Broker
  -> owning downstream STH-local Verser2 Host
  -> upstream Manager Verser2 Host federation link
  -> Manager route or native 307/308 redirect
  -> target advertised route
```

`host.connectUpstream()` should not only import upstream route advertisements; it should also provide a supported request path for downstream Broker requests that target those imported route candidates. Existing inbound federation behavior must remain compatible, but internal Host federation request-routing refactors are allowed when they improve clarity and preserve public behavior.

## Track type

Feature / behavior fix.

## Functional requirements

1. Broker dispatch to upstream imported routes
   - When a downstream Host imports route advertisements through `connectUpstream()`, a Broker connected to that downstream Host can request an imported upstream route.
   - The downstream Host routes the request over the appropriate upstream federation request stream instead of only looking for inbound federation hosts.
   - The request preserves normal HTTP method, path, headers, request body, response status, response headers, and response body semantics.
   - The implementation handles unavailable, closed, or stale upstream links with actionable errors.

2. Host federation request-stream directionality
   - Host federation request acquisition must support the issue #24 direction: downstream Host to upstream Host for imported route candidates.
   - Existing inbound Host federation request forwarding remains supported.
   - Shared route-candidate selection, lease acquisition, error handling, and cleanup logic should be refactored as needed to avoid duplicated inbound/upstream implementations.
   - Route selection must remain route-aware and use advertised route candidates, `nextHopHostId`, route cleanup, and existing HA/fallback semantics where applicable.

3. Native 307/308 redirect behavior across upstream routes
   - A Broker request sent to an imported upstream Manager route can receive a native `307` or `308` redirect to another advertised route and follow it according to existing Broker redirect-following rules.
   - Redirect-following must remain method-preserving and respect existing replay-buffer and hop-limit safeguards.
   - Manager should coordinate routing through redirects without becoming an unnecessary payload proxy for single-owner target routes.

4. Implemented runtime validation
   - Validate Node Host and Node Broker behavior directly.
   - Validate Bun-facing Broker behavior where it uses the shared Node transport and can exercise the upstream route path.
   - Validate Python Broker behavior where practical against the Host behavior, or document why direct runtime validation is not practical in the phase and preserve Python compatibility through shared protocol semantics.

5. Error clarity
   - Errors for unavailable upstream route candidates should distinguish missing inbound federation hosts from missing or unavailable upstream federation links.
   - Relevant errors should include useful context such as target route id/domain, next-hop host id, upstream id, direction, connection state, and request path where available.
   - The prior ambiguous failure shape (`upstream-unavailable` because only inbound federation hosts were checked) should be replaced or clarified for the supported upstream-dispatch path.

6. Documentation
   - Update federation and request-routing documentation to describe the supported downstream-Broker-to-upstream-route topology.
   - Document any limitations, fallback behavior, and redirect behavior.
   - Keep Host/Guest/Broker/Peer terminology precise and do not introduce unsupported HTTP/3, browser, Rust, Go, Java, or Python Host claims.

## Non-functional requirements

- Preserve protocol compatibility for HTTP method, path, headers, body, status, response headers, response body, streaming, and lifecycle behavior unless a focused test proves a required issue #24 change.
- Preserve existing inbound federation behavior and tests.
- Reuse or adapt common Host federation primitives before adding parallel package-local logic.
- Keep implementation incremental and test-driven per `conductor/workflow.md`.
- Maintain at least 95% meaningful test coverage for changed behavior or record why any phase-specific coverage measurement is not applicable.
- Perform all implementation work on a dedicated track branch with a GitHub pull request created as the review surface before behavior-changing work begins.
- Before every Conductor manual validation checkpoint, commit the completed phase changes and push them to the track PR branch.
- Keep manual-review phases to larger coherent chunks rather than tiny tasks: TDD/regression tests, upstream request-stream support, downstream Broker dispatch/redirect behavior, and finalization/documentation.

## Acceptance criteria

- A dedicated track branch and GitHub pull request exist before behavior-changing implementation work begins.
- Each manual validation checkpoint is preceded by a scoped phase commit pushed to the PR branch.
- A downstream Host connected to an upstream Host via `connectUpstream()` can accept a downstream Broker request for an imported upstream route and return the upstream route response.
- The issue #24 reproduction shape passes using raw Verser2 Hosts/Broker without Transform Hub runtime code.
- A downstream Broker request to an imported upstream Manager route can follow a native 307/308 redirect to another advertised route when existing redirect-following safeguards allow it.
- Existing inbound federation tests and behavior continue to pass.
- Error tests cover unavailable upstream links/candidates and assert actionable route/host/direction context.
- Node behavior is directly tested; Bun-facing and Python Broker paths are validated where practical or explicitly documented as covered by shared Host/protocol behavior with a reason.
- Federation/request docs describe the supported topology and clarify request directionality.
- Relevant build, test, lint, package staging, and package consumer/tarball validations pass or any skipped validation is recorded with reason.

## Out of scope

- Transform Hub application/runtime implementation changes.
- Changing the public meaning of Host, Guest, Broker, or Peer.
- Requiring the federation topology to be inverted as the only supported solution.
- Adding a separate public route-aware upstream request API unless discovered as necessary during implementation and approved separately.
- Implementing HTTP/3, browser, Rust, Go, Java, or Python Host behavior.
- Redesigning Broker authorization, complete gateway policy, or unrelated Host federation features beyond the issue #24 request path.

# Outcomes: Broker Internal Redirect Following

## Completed work

- Added default-on internal redirect following for eligible Broker-driven requests that receive `307` or `308` responses with a `Location` hostname matching an advertised Verser route.
- Implemented exact route-table resolution for redirect targets, avoiding DNS for internal redirected hostnames.
- Preserved original method, headers, redirected path/query semantics, and replayed request body bytes from the beginning when the body fits within the configured replay buffer.
- Added configurable redirect settings across direct Broker requests, Agent-backed requests, Dispatcher, and fetch-style integrations, including default max internal redirects of `3` and replay buffer limit of `16 KiB`.
- Added bounded replay behavior: oversized request bodies return the original redirect response unchanged for the caller/client to handle.
- Added redirect-loop and over-limit handling with clear Verser errors.
- Documented default behavior, configuration, oversized body fallback, and internal-route-only semantics.

## Validation and reviews

- Failing direct Broker, Agent, Dispatcher, and fetch integration tests were added before implementation.
- Focused validations passed for Broker routing, Agent, and Dispatcher redirect behavior.
- Build and lint validation passed after public type and documentation updates.
- Deduplication outcome: route lookup reuses common `resolveRouteForUrl`; Node-specific redirect replay remains in the guest-node Broker layer because it depends on Node stream/body behavior.

## Deferred or intentional limits

- Redirect following is intentionally limited to internal Verser `307`/`308` route redirects.
- General browser-style redirect policy, DNS resolution for redirected hostnames, method safety classification, and complex replay policies remain out of scope.

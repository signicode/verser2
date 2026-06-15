# @signicode/verser-common

Shared protocol, type, and utility exports for verser2 packages.

## Public API

- **Constants:** `VERSER_COMMON_PACKAGE_NAME`, envelope constants,
  `DEFAULT_MAX_ENVELOPE_METADATA_BYTES`, `VERSER_LIFECYCLE_EVENTS`,
  `VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER`
- **Classes:** `VerserError`, `VerserHttpErrorResponse`
- **Helpers:** `createGuestId`, `createPeerId`, `createVerserHostId`,
  `createRoutedDomainRegistration`, `createFederatedRouteRegistration`,
  `createVerserHostFederationHandshake`, `resolveRouteForHostname`,
  `resolveRouteForUrl`, Broker request creation, registration/control-frame
  helpers, envelope readers/writers, error-response
  helpers, stream/NDJSON/body helpers, header normalization/serialization,
  HTTP/2 header conversion, TLS/certificate helpers, `getErrorMessage`
- **Types:** peer/guest/request IDs, routed domain/request/response envelopes,
  header shapes, envelope metadata/parser shapes, Broker request/response
  shapes, registration request/response shapes, certificate identity and
  registration and Host federation authorization shapes, Broker routes and
  federated route-control frames, TLS option shapes, error context/code shapes

## Usage

This package is typically consumed as a dependency of other verser2 packages
rather than directly by applications. Its types and helpers are re-exported
through higher-level packages (`@signicode/verser2-host`,
`@signicode/verser2-guest-node`, etc.).

```ts
import { VerserError, createGuestId, resolveRouteForHostname } from '@signicode/verser-common';
```

## Caveats

- Route resolution uses exact hostname matching; there is no wildcard or suffix
  domain matching.
- Host federation protocol helpers are shared foundations for Host packages;
  most applications configure federation through `@signicode/verser2-host`.
- Error codes include federation-aware failures such as `upstream-unavailable`,
  `route-loop`, and `authorization-denied`; `unsafe-retry` is reserved for
  retry-policy failures.
- The package provides foundational types — most applications interact with
  verser through the Host, Guest, or Broker APIs rather than directly with
  verser-common.

## Links

- [Root README](../../README.md)
- [Docs: Routes](../../docs/routes.md)
- [Docs: Certificates](../../docs/certificates.md)
- [Docs: Authorization](../../docs/authorization.md)
- [Docs: Host federation and upstreams](../../docs/host-federation.md)

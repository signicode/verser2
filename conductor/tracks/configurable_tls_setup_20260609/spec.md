# Specification: Configurable TLS setup without shipped development certificate

## Overview

Add public TLS configuration for the TypeScript/Node Verser2 Host, Guest, and Broker so applications can provide their own production certificates and trust roots for the remote TLS HTTP/2 transport. Remove the embedded development certificate from shipped package code; test certificates may remain under test fixtures or test-only directories and must not be part of published runtime artifacts.

## Track Type

Feature

## Functional Requirements

1. Host TLS configuration
   - `@signicode/verser2-host` must expose options for configuring TLS certificates on `NodeHttp2VerserHost`.
   - The Host API must support both direct PEM values and file-path convenience options for at least certificate and private key material.
   - Host setup must pass configured certificate and key material into Node.js `http2.createSecureServer()` for the remote Host-facing TLS HTTP/2 listener.
   - Host behavior must fail clearly when required server certificate/key material is missing or invalid.

2. Guest and Broker trust configuration
   - `@signicode/verser2-guest-node` must expose TLS trust options for both `Http2VerserNodeGuest` and `Http2VerserBroker`.
   - The Guest and Broker APIs must support both direct CA values and file-path convenience options.
   - Guest and Broker setup must pass configured trust material into Node.js `http2.connect()` for outbound TLS HTTP/2 connections to the Host.
   - If no CA/trust option is provided, Guest and Broker must use normal Node.js TLS trust behavior rather than a pinned development CA.

3. Local Guest HTTP/1 remains plain/in-process
   - TLS configuration applies only to the remote Host/Guest/Broker TLS HTTP/2 transport.
   - A Guest-attached local HTTP/1 server or request listener must not be required to use HTTPS.
   - Existing local in-process dispatch into normal Node.js HTTP handlers must remain compatible with plain `node:http` handlers.
   - Documentation must clearly distinguish remote Host transport TLS from local Guest HTTP/1 handler behavior.

4. Remove shipped development certificate
   - The embedded development certificate/private key must be removed from runtime package sources and package exports.
   - Development/test certificate material may remain only in test fixtures or another test-only location that is not shipped in package dist artifacts.
   - Runtime packages must not expose or depend on a bundled self-signed development certificate.

5. Common/shared design
   - Reusable TLS option types or helpers should be placed in `@signicode/verser-common` when they are shared by Host, Guest, and Broker.
   - Package-specific code should remain thin adapters around shared TLS option normalization/loading helpers when practical.
   - File loading must be explicit and deterministic, using Node.js APIs suitable for the Node package targets.

6. Documentation
   - Update the README to document Host certificate/key configuration and Guest/Broker CA/trust configuration for the remote TLS HTTP/2 transport.
   - Update public API/type documentation exposed through package entrypoints or generated declaration surfaces as needed.
   - Remove or rewrite documentation that says the Host always uses an embedded self-signed development certificate or that Guest/Broker always pin that certificate.
   - Include examples for certificate/key files and direct PEM values.
   - Explicitly state that Guest-attached local HTTP/1 servers do not need HTTPS certificates and do not call `listen()` for this routing path.

## Non-Functional Requirements

- Preserve existing Host/Guest/Broker protocol behavior, routing semantics, request/response forwarding, streaming behavior, and lifecycle events except for TLS setup behavior.
- Preserve strict TypeScript typing and package buildability.
- Avoid adding HTTP/3, authentication, authorization, public gateway policy, or unrelated transport changes.
- Avoid shipping hardcoded private keys, bundled development CAs, or production-inappropriate defaults.
- Keep the API compatible with Node.js `http2` TLS expectations where practical.

## Acceptance Criteria

- Host users can configure remote transport TLS with direct PEM `cert`/`key` values.
- Host users can configure remote transport TLS with `certFile`/`keyFile` paths.
- Guest and Broker users can configure Host trust with direct `ca` values.
- Guest and Broker users can configure Host trust with `caFile` paths.
- Guest and Broker work with normal Node.js TLS trust when no custom CA is configured.
- Guest-attached local HTTP/1 handlers continue to work as plain `node:http` handlers without HTTPS setup.
- Runtime source and shipped package artifacts no longer include the embedded development certificate/private key.
- Tests cover direct PEM options, file path options, default Node trust behavior where feasible, local plain HTTP/1 Guest handler compatibility, and absence of runtime development certificate usage.
- README and public API documentation describe the new TLS setup and clarify that local Guest HTTP/1 is not HTTPS.
- `npm run build`, focused tests, and relevant lint/tests pass for changed areas.

## Out of Scope

- Requiring HTTPS for Guest-attached local HTTP/1 servers.
- Mutual TLS/client certificates unless already supported naturally by the chosen option shape and explicitly needed for server/client setup.
- Certificate generation tooling for users.
- Automatic certificate reload/rotation.
- Authentication, authorization, or route policy.
- HTTP/3, QUIC, or non-Node guest runtime implementation.
- HTTPS Agent behavior for routed target semantics beyond existing Broker/Agent functionality.

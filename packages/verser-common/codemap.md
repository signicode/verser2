# packages/verser-common/

## Responsibility

Shared protocol contracts, constants, and runtime-neutral helpers for the Verser HTTP routing system. This package is consumed by all other Verser packages (Host, Guest, Broker) and defines the wire format, type system, error handling, and validation rules that every peer must agree on.

## Design / Patterns

- **Binary envelope wire format** — a 6-byte prefix (`[version:1] [type:1] [metadataLength:4]`) followed by JSON metadata and an opaque body. Three envelope types: `request`, `response`, `error`.
- **Discriminated type unions** — envelope metadata, registration auth actions, and control frames use discriminant fields (`type`, `action`) for type-safe narrowing.
- **Exact hostname route matching** — `resolveRouteForHostname` uses strict equality (`===`), no wildcard or suffix support.
- **Multi-mode TLS configuration** — Host and client TLS options support four mutually exclusive identity modes: inline PEM, PEM file paths, inline PFX/PKCS12, PFX file paths. Key file permissions `0600` enforced on non-Windows.
- **NDJSON control frames** — Broker route advertisements and Host registration responses use newline-delimited JSON over HTTP/2 streams.
- **VerserError with codes** — all protocol errors carry a machine-readable `VerserErrorCode` (`missing-guest`, `timeout`, `stream-failure`, `protocol-error`, etc.) plus structured `context` for diagnostics.
- **Lifecycle event names** — canonical string constants (`connected`, `disconnected`, `registered`, `route-advertised`, `request-started`, `request-completed`, `error`, `closed`) shared across all packages.

## Data & Control Flow

1. **Encoding path**: Caller assembles `VerserEnvelopeToEncode` → `encodeVerserEnvelope()` serialises JSON metadata, writes 6-byte prefix + metadata buffer. Body is written separately by the caller.
2. **Decoding path**: Incoming bytes → `createVerserEnvelopeParser()` (streaming, chunk-by-chunk) or `readVerserEnvelopeFromStream()` (async, exact byte count via `readExactly`). Returns `ParsedVerserEnvelope` with typed metadata and body remainder.
3. **Header flow**: Inbound headers → `normalizeHeaders()` (flattens, lowercases, validates) → `validateVerserHeaders()` (rejects forbidden HTTP/1 connection headers) → envelope metadata. Broker→Host uses `x-verser-headers` JSON header → `decodeHeaderMap()`.
4. **Registration flow**: Raw JSON → `parseRegistrationRequest()` (validates role) → `authorizeRegistration` callback (mTLS hook) → `createRoutedDomainRegistration()` (validates fields) → peer stored in Host's `peers` map.
5. **Route advertisement**: Host calls `createBrokerRoutesControlFrame()` → `encodeJsonLine()` → written to Broker control streams via `writeJsonLine()`.

## Integration Points

- **Exported to**: `@signicode/verser2-host`, `@signicode/verser2-guest-node`, `@signicode/verser2-guest-js-common`, and any runtime-specific adapter.
- **Host consumes**: `parseRegistrationRequest`, `encodeVerserEnvelope`, `readLeaseResponseMetadataFromStream`, `validateVerserHeaders`, `decodeHeaderMap`, `normalizeServerTlsOptions`, `normalizeHostClientAuthTlsOptions`, `extractCertificateIdentity`, `createBrokerRoutesControlFrame`, `VERSER_LIFECYCLE_EVENTS`.
- **Guest consumes**: `readLeaseRequestMetadataFromStream`, `encodeVerserEnvelope`, `normalizeHeaders`, `parseRegistrationResponse`.
- **Broker consumes**: `createCommonBrokerRequest`, `normalizeBrokerRequestBody`, `parseRegistrationResponse`, `readNdjsonLines`.
- **Dependencies**: `node:stream`, `node:crypto`, `node:fs` (stream readers, TLS helpers). No external npm dependencies.

# packages/verser-common/src/lib/

## Responsibility

Implementation modules for the `@signicode/verser-common` package. Each file owns a single protocol concern: binary envelope wire format, route registration and resolution, HTTP header validation and normalization, TLS certificate handling, error types, NDJSON streaming, and low-level stream I/O.

## Design / Patterns

### Module inventory

| File | Responsibility | Key exports |
|---|---|---|
| `types.ts` | All shared TypeScript types, interfaces, and type aliases. | `VerserPeerId`, `VerserGuestId`, `VerserRequestId`, `RoutedDomainRegistration`, `RoutedRequestEnvelope`, `RoutedResponseEnvelope`, `VerserEnvelopeMetadata` (union), `VerserHostTlsOptions` (discriminated union of 4 identity modes), `VerserClientTlsOptions`, `VerserRegistrationRequest`/`Response`, `VerserBrokerControlFrame`, `VerserErrorCode`, `VerserErrorContext`, `VerserCertificateIdentity`, `VerserRegistrationAuthorizationAction`/`Context`/`Callback`, `VerserCommonBrokerRequest`/`Response`, `VerserCommonBroker`, `LeaseRequestMetadataReadOptions`, `LeaseResponseMetadataReadOptions` |
| `constants.ts` | Canonical constants shared across the system. | `VERSER_COMMON_PACKAGE_NAME`, `VERSER_LIFECYCLE_EVENTS` (8 string constants), `VERSER_ENVELOPE_VERSION` (1), `VERSER_ENVELOPE_PREFIX_BYTES` (6), `DEFAULT_MAX_ENVELOPE_METADATA_BYTES` (64 KiB), `VERSER_ENVELOPE_TYPES` (request=1, response=2, error=3) |
| `envelope.ts` | Binary envelope encoding and streaming/parser functions. | `encodeVerserEnvelope()` — serialises metadata to prefix + JSON buffer. `createVerserEnvelopeParser()` — stateful chunk-by-chunk parser. `readVerserEnvelopeFromStream()` — async stream reader. `readLeaseResponseMetadataFromStream()` — reads Guest response, re-throws error envelopes. `readLeaseRequestMetadataFromStream()` — reads incoming request for Guest. |
| `routing.ts` | Route ID creation and domain-based resolution. | `createGuestId()`, `createPeerId()`, `createRoutedDomainRegistration()` — validated constructors. `resolveRouteForHostname()` / `resolveRouteForUrl()` — exact hostname match. `createRoutedRequestEnvelope()` / `createRoutedResponseEnvelope()` — validated envelope builders. |
| `errors.ts` | Typed error system with machine-readable codes. | `VerserError` class (extends `Error` with `code` + `context`), `createVerserError()`, `toVerserError()` (wraps unknown errors). |
| `error-response.ts` | Serializable HTTP error response bodies. | `VerserHttpErrorResponse` interface, `toVerserHttpErrorResponse()` (VerserError → JSON body), `toVerserErrorCode()` (string validation), `verserErrorFromResponseBody()` (JSON buffer → VerserError). |
| `headers.ts` | Header validation, normalisation, and flattening. | `isValidHeaderName()`, `isValidHeaderValue()` (RFC 7230), `flattenHeaderValue()`, `normalizeHeaders()` (3 input formats → flat record), `normalizeRequestHeaders()` (Node.js outgoing headers), `validateVerserHeaders()` (rejects connection/upgrade/keep-alive), `validateRuntimeNeutralHeaders()`. |
| `header-serialization.ts` | JSON header map encoding/decoding. | `flattenVerserHeaders()` (string array → comma-joined), `decodeHeaderMap()` (JSON string → record). |
| `http2-headers.ts` | HTTP/2 pseudo-header conversion. | `toHttp2RequestHeaders()`, `fromHttp2RequestHeaders()`, `toHttp2ResponseHeaders()`, `fromHttp2ResponseHeaders()`, `stripHttp2PseudoHeaders()`. |
| `body.ts` | Broker request body normalisation. | `isIterableBody()`, `isAsyncIterableBody()`, `normalizeBrokerRequestBody()` (string, Buffer, Uint8Array, Readable, iterable → transport format). |
| `broker-request.ts` | Broker request validation + normalisation. | `createCommonBrokerRequest()` — validates targetId, uppercases method, ensures path starts with `/`, normalises headers and body. |
| `registration.ts` | Peer registration parsing + route control frames. | `parseRegistrationRequest()` (validates role), `parseRegistrationResponse()`, `createBrokerRoutesControlFrame()`. |
| `ndjson.ts` | Newline-delimited JSON streaming. | `encodeJsonLine()` (value → `JSON + \n`), `readNdjsonLines()` (stream → per-line parse with error handling). |
| `protocol-headers.ts` | Verser-specific HTTP headers. | `VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER`, `parseLeaseAcquireTimeoutMs()` (default 5000 ms). |
| `stream-readers.ts` | Low-level exact-byte stream reads. | `readExactly()` — reads N bytes from Readable, handles backpressure via `readable` event, rejects on end/close/error. |
| `tls.ts` | TLS option normalisation + certificate identity extraction. | `normalizeServerTlsOptions()`, `normalizeClientTlsOptions()`, `normalizeHostClientAuthTlsOptions()`, `getCertificateFingerprint()`, `verifyPinnedCertificate()`, `extractCertificateIdentity()`. Key file permission `0600` enforcement on non-Windows. |
| `utils.ts` | Internal helpers. | `isRecord()`, `getErrorMessage()`, `requireNonEmpty()`, `requireValidStatusCode()`, `isValidHttpHeaderName()`, `envelopeTypeNameFromCode()`. |

### Patterns

- **Validated constructors** — functions like `createGuestId()`, `createRoutedDomainRegistration()`, `createCommonBrokerRequest()` validate inputs and throw `VerserError` on invalid data. No classes; plain-object return values.
- **Consistent error pattern** — all protocol errors go through `createVerserError(code, message, context)`. Errors carry structured context for diagnostics, never just strings.
- **Streaming-first parsing** — `createVerserEnvelopeParser()` and `readNdjsonLines()` process data incrementally, supporting backpressure and partial chunks.
- **Discriminated TLS unions** — `VerserHostTlsOptions` uses `never` fields to enforce exactly one of four identity modes at the type level, validated at runtime.
- **No side effects at module scope** — all modules are side-effect-free at import; state is explicitly created (e.g., parser instances, TLS options objects).

## Data & Control Flow

1. **Envelope encode**: `encodeVerserEnvelope()` → 6-byte `Buffer.alloc` + `writeUInt32BE` for metadata length + `Buffer.concat([prefix, JSON metadata])` → caller appends body.
2. **Envelope decode (stream)**: `readVerserEnvelopeFromStream()` → `readExactly(stream, 2)` for version+type + `readExactly(stream, 4)` for length + `readExactly(stream, metadataLength)` for JSON → `parseEnvelopeMetadata()` validates JSON is a record → returns `ParsedVerserEnvelope`. Excess bytes unshifted back to stream.
3. **Header normalisation**: `normalizeHeaders()` → detects input format (record, array, iterable) → `flattenHeaderValue()` on each value (null/undefined omitted, arrays joined) → lowercases keys → `validateRuntimeNeutralHeaders()` checks name/value validity.
4. **Route resolution**: `resolveRouteForHostname(routes, hostname)` → `routes.find(r => r.domain === hostname)` — exact match only.
5. **TLS normalisation**: `normalizeServerTlsOptions()` → counts identity modes (PEM inline, PEM file, PFX, PFX file) → rejects ambiguous or incomplete config → reads files if paths given → validates key permissions.

## Integration Points

- **All modules consumed by** `src/index.ts` for re-export.
- **`errors.ts`, `envelope.ts`, `routing.ts`, `headers.ts`, `tls.ts`** — directly imported by `@signicode/verser2-host`.
- **`envelope.ts`, `registration.ts`, `body.ts`, `broker-request.ts`, `ndjson.ts`** — directly imported by Guest/Broker packages.
- **`stream-readers.ts`** — used internally by `envelope.ts` and by Host/adapters that need exact-byte stream I/O.
- **No files import from sibling packages** — all dependencies are Node.js built-ins or internal.

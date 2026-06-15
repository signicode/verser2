/**
 * A unique identifier for a Peer (Guest or Broker) in the Verser protocol.
 *
 * Peer IDs are supplied by the application at registration time and must be unique
 * per Host. They appear in routed request/response envelopes as `sourceId` and `targetId`.
 *
 * @public
 */
export type VerserPeerId = string;

/**
 * A stable identifier for a Verser Host participating in federation.
 *
 * Host IDs are distinct from Guest and Broker peer IDs. Federated route metadata
 * uses them to identify route origin, next hop, and visited Hosts for loop
 * prevention.
 *
 * @public
 */
export type VerserHostId = string;

/**
 * The role of a Peer in the Verser protocol.
 *
 * - `'guest'` — a Guest that registers route domains and receives forwarded requests.
 * - `'broker'` — a Broker that discovers advertised routes and sends requests to Guests through the Host.
 *
 * @public
 */
export type VerserPeerRole = 'broker' | 'guest';

/**
 * A unique identifier for a Guest peer.
 *
 * Type alias for {@link VerserPeerId} used where a Guest identity is expected.
 *
 * @public
 */
export type VerserGuestId = string;

/**
 * A unique identifier for a single routed request.
 *
 * Assigned by the source (Broker or Host) and propagated through envelopes so
 * request/response pairs can be correlated across the system.
 *
 * @public
 */
export type VerserRequestId = string;

/**
 * A route record associating a Guest with a domain.
 *
 * Route matching uses **exact** URL hostname equality — no wildcard or suffix matching
 * is performed. Routes are registered by Guests and advertised to Brokers by the Host.
 *
 * @public
 */
export interface RoutedDomainRegistration {
  /** The Guest peer that owns this route. */
  readonly targetId: VerserGuestId;
  /** The exact hostname this route handles (e.g. `"api.example.com"`). */
  readonly domain: string;
}

/**
 * Source classification for a route candidate known by a Host.
 *
 * @public
 */
export type VerserFederatedRouteSource = 'local' | 'upstream';

/**
 * A route advertisement carrying Host federation metadata.
 *
 * This extends the legacy Broker route shape with protocol-neutral next-hop
 * metadata. Legacy Broker frames should strip these fields and continue to
 * advertise only `{ targetId, domain }` records.
 *
 * @public
 */
export interface FederatedRouteRegistration extends RoutedDomainRegistration {
  /** Host where the route originally became available. */
  readonly originHostId: VerserHostId;
  /** Host to contact as the next hop from the current Host. */
  readonly nextHopHostId: VerserHostId;
  /** Number of Host-to-Host hops from the route origin. */
  readonly hopCount: number;
  /** Host IDs already visited by this advertisement. */
  readonly viaHostIds: readonly VerserHostId[];
  /** Whether this candidate is local to the advertising Host or imported upstream. */
  readonly source: VerserFederatedRouteSource;
}

/**
 * Versioned handshake payload exchanged when one Host opens a federated link to another.
 *
 * @public
 */
export interface VerserHostFederationHandshake {
  /** Discriminant for Host federation handshake payloads. */
  readonly type: 'verser-host-federation-handshake';
  /** Federation protocol version. */
  readonly protocolVersion: number;
  /** Stable ID of the connecting Host. */
  readonly hostId: VerserHostId;
  /** Maximum allowed Host-to-Host hops for forwarded routes/requests. */
  readonly maxHopCount?: number;
  /** Whether the connecting Host wants to import routes from the peer. */
  readonly importRoutes?: boolean;
  /** Whether the connecting Host wants to export routes to the peer. */
  readonly exportRoutes?: boolean;
}

/**
 * Application authorization context for a Host federation link.
 *
 * @public
 */
export interface VerserHostFederationAuthorizationContext {
  /** Stable ID declared by the connecting Host. */
  readonly hostId: VerserHostId;
  /** Parsed federation handshake. */
  readonly handshake: VerserHostFederationHandshake;
  /** Parsed TLS client certificate identity, if mTLS is configured. */
  readonly certificate?: VerserCertificateIdentity;
  /** Socket-level TLS authorization metadata and implementation-specific context. */
  readonly metadata: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * Host federation link authorization callback result.
 *
 * @public
 */
export type VerserHostFederationAuthorizationAction =
  | { readonly action: 'allow' }
  | { readonly action: 'close'; readonly reason?: string };

/**
 * Callback for authorizing Host-to-Host federation links.
 *
 * @public
 */
export type VerserHostFederationAuthorizationCallback = (
  context: VerserHostFederationAuthorizationContext,
) => VerserHostFederationAuthorizationAction | Promise<VerserHostFederationAuthorizationAction>;

/**
 * A request envelope routed from a Broker to a Guest through the Host.
 *
 * The Host forwards this envelope's metadata to the target Guest over a lease stream,
 * then pipes the request body. The Guest receives the metadata and body via its local
 * HTTP handler. Lease acquisition timeout can be controlled via
 * {@link VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER}.
 *
 * @public
 */
export interface RoutedRequestEnvelope {
  /** Unique identifier for this request, used to correlate the response. */
  readonly requestId: VerserRequestId;
  /** The Peer (Broker) that originated this request. */
  readonly sourceId: VerserPeerId;
  /** The Guest that should handle this request. */
  readonly targetId: VerserGuestId;
  /** HTTP method (e.g. `GET`, `POST`). */
  readonly method: string;
  /** Request path (e.g. `/api/users`). */
  readonly path: string;
  /** Request headers as a flat string map. */
  readonly headers: Record<string, string>;
  /** Optional lease acquisition timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * A response envelope returned from a Guest to a Broker through the Host.
 *
 * After the Guest local handler produces a response, the Host reads the response
 * metadata from the lease stream and pipes the response body back to the Broker.
 * The Broker receives the status code and headers before consuming the body stream.
 *
 * @public
 */
export interface RoutedResponseEnvelope {
  /** The request ID this response corresponds to. */
  readonly requestId: VerserRequestId;
  /** HTTP status code (e.g. `200`, `404`, `500`). */
  readonly statusCode: number;
  /** Response headers as a flat string map. */
  readonly headers: Record<string, string>;
}

/**
 * A single header value that can be a string, number, boolean, null/undefined (to omit),
 * or an array of string/number/boolean values (joined with `,` on flatten).
 *
 * @public
 */
export type VerserHeaderValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

/**
 * Flexible input format for header maps.
 *
 * Accepts a record, an even-length array of `[name, value, name, value, …]`,
 * or an iterable of `[name, value]` pairs. Use {@link normalizeHeaders} to
 * convert to a flat `Record<string, string>`.
 *
 * @public
 */
export type VerserHeaderInput =
  | Readonly<Record<string, VerserHeaderValue>>
  | readonly string[]
  | Iterable<readonly [string, VerserHeaderValue]>;

/**
 * A read-only record of validated header key/value pairs.
 *
 * Values are typically strings after normalization. This is the standard header
 * representation used throughout Verser envelopes and metadata.
 *
 * @public
 */
export type VerserHeaders = Readonly<Record<string, VerserHeaderValue>>;

/**
 * The type name portion of a Verser envelope.
 *
 * - `'request'` — a routed request.
 * - `'response'` — a routed response.
 * - `'error'` — a protocol error.
 *
 * @public
 */
export type VerserEnvelopeTypeName = 'request' | 'response' | 'error';

/**
 * Metadata for a routed **request** envelope.
 *
 * Carried in the binary envelope prefix before the request body. The Host reads
 * these fields from the incoming Broker stream and forwards them to the target Guest.
 *
 * @public
 */
export interface VerserRequestEnvelopeMetadata {
  /** Unique request identifier for correlation. */
  readonly requestId: VerserRequestId;
  /** The Peer (Broker) that originated the request. */
  readonly sourceId: VerserPeerId;
  /** The Guest peer that should handle this request. */
  readonly targetId: VerserGuestId;
  /** HTTP method (e.g. `GET`, `POST`). */
  readonly method: string;
  /** Request path (e.g. `/api/users`). */
  readonly path: string;
  /** Request headers. */
  readonly headers: VerserHeaders;
  /** Optional lease acquisition timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Metadata for a routed **response** envelope.
 *
 * Written by the Host after reading the Guest's response metadata from the lease stream.
 * The Broker receives this before consuming the response body.
 *
 * @public
 */
export interface VerserResponseEnvelopeMetadata {
  /** The request ID this response corresponds to. */
  readonly requestId: VerserRequestId;
  /** HTTP status code. */
  readonly statusCode: number;
  /** Response headers. */
  readonly headers: VerserHeaders;
}

/**
 * Metadata for an **error** envelope.
 *
 * Used when a request cannot be completed — e.g. timeout, missing Guest, local handler failure.
 * The `code` field provides a machine-readable error classifier.
 *
 * @public
 */
export interface VerserErrorEnvelopeMetadata {
  /** The request ID this error relates to. */
  readonly requestId: VerserRequestId;
  /** Machine-readable error code. */
  readonly code: VerserErrorCode;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional structured context for the error. */
  readonly context?: VerserErrorContext;
}

/**
 * Union of all envelope metadata types.
 *
 * @public
 */
export type VerserEnvelopeMetadata =
  | VerserRequestEnvelopeMetadata
  | VerserResponseEnvelopeMetadata
  | VerserErrorEnvelopeMetadata;

/**
 * Input shape for encoding a Verser envelope via {@link encodeVerserEnvelope}.
 *
 * @public
 */
export interface VerserEnvelopeToEncode {
  /** The envelope type name (`'request'`, `'response'`, or `'error'`). */
  readonly type: VerserEnvelopeTypeName;
  /** The metadata payload for this envelope. */
  readonly metadata: VerserEnvelopeMetadata;
}

/**
 * Result of parsing a Verser envelope from a stream or buffer.
 *
 * Contains the typed metadata and any excess bytes (the body portion) that follow
 * the envelope prefix and metadata.
 *
 * @public
 */
export interface ParsedVerserEnvelope {
  /** The envelope type name. */
  readonly type: VerserEnvelopeTypeName;
  /** Deserialized metadata object. */
  readonly metadata: VerserEnvelopeMetadata;
  /** Remaining bytes after the envelope prefix and metadata (the body). */
  readonly bodyRemainder: Buffer;
}

/**
 * Options for configuring an envelope parser via {@link createVerserEnvelopeParser}.
 *
 * @public
 */
export interface VerserEnvelopeParserOptions {
  /**
   * Maximum allowed metadata payload size in bytes.
   * Defaults to {@link DEFAULT_MAX_ENVELOPE_METADATA_BYTES} (64 KiB).
   */
  readonly maxMetadataBytes?: number;
}

/**
 * Contextual identifiers used in stream-read error messages for debugging.
 *
 * When specified, these values are included in the `VerserError.context` for any
 * stream-read failure, making it easier to trace errors to a specific request or peer.
 *
 * @public
 */
export interface VerserStreamReadContext {
  /** The ID of the request being read. */
  readonly requestId?: string;
  /** The target Guest ID. */
  readonly targetId?: string;
  /** The Guest peer ID. */
  readonly guestId?: string;
  /** The lease stream identifier. */
  readonly leaseId?: string;
}

/**
 * Options for reading a Verser envelope from a readable stream.
 *
 * Extends {@link VerserEnvelopeParserOptions} with an optional context for error diagnostics.
 *
 * @public
 */
export interface VerserEnvelopeStreamReadOptions extends VerserEnvelopeParserOptions {
  /** Diagnostic context for error messages. */
  readonly context?: VerserStreamReadContext;
}

/**
 * A generic Broker request used by runtime-neutral Broker APIs.
 *
 * The generic `TBody` parameter captures the body type before normalization;
 * after normalization the body is converted to `Buffer[]`, `Readable`, or `undefined`.
 *
 * @typeParam TBody - The input body type (string, Buffer, Readable, iterable, etc.).
 * @public
 */
export interface VerserCommonBrokerRequest<TBody = unknown> {
  /** The target Guest ID for this request. */
  readonly targetId: string;
  /** HTTP method (e.g. `GET`, `POST`). */
  readonly method: string;
  /** Request path (e.g. `/api/users`). */
  readonly path: string;
  /** Optional request headers. */
  readonly headers?: VerserHeaders;
  /** Optional request body. Supports strings, Buffers, Readable streams, and iterables. */
  readonly body?: TBody;
}

/**
 * A generic Broker response returned by runtime-neutral Broker APIs.
 *
 * @typeParam TBody - The response body type (e.g. `Buffer`, `string`, or a stream).
 * @public
 */
export interface VerserCommonBrokerResponse<TBody> {
  /** The request ID this response corresponds to. */
  readonly requestId: string;
  /** HTTP status code. */
  readonly statusCode: number;
  /** Response headers. */
  readonly headers: VerserHeaders;
  /** The response body. */
  readonly body: TBody;
}

/**
 * Runtime-neutral Broker interface providing route discovery and request dispatch.
 *
 * Implementations (e.g. Node Broker, Python Broker) connect to a Host, register as a Broker,
 * receive advertised route tables, and issue routed requests to Guests.
 *
 * @typeParam TRequestBody - Input body type for requests.
 * @typeParam TResponseBody - Output body type for responses.
 * @public
 */
export interface VerserCommonBroker<TRequestBody = unknown, TResponseBody = unknown> {
  /**
   * Returns the current set of advertised routes known to this Broker.
   * Routes are updated when the Host sends route-control frames.
   */
  getRoutes(): { targetId: string; domain: string }[];
  /**
   * Waits (asynchronously) until a route for the given domain is advertised.
   * Resolves immediately if the route already exists.
   */
  waitForRoute(domain: string): Promise<void>;
  /**
   * Sends a routed request to the target Guest via the Host.
   * Response body shape is runtime-specific and may be buffered or streamed.
   */
  request(
    request: VerserCommonBrokerRequest<TRequestBody>,
  ): Promise<VerserCommonBrokerResponse<TResponseBody>>;
}

/**
 * Options for reading lease response metadata from a Guest lease stream.
 *
 * @public
 */
export interface LeaseResponseMetadataReadOptions extends VerserEnvelopeParserOptions {
  /** The request ID expected in the response envelope. */
  readonly requestId: string;
  /** The target Guest ID for diagnostics. */
  readonly targetId: string;
}

/**
 * Options for reading lease request metadata from a Guest lease stream.
 *
 * @public
 */
export interface LeaseRequestMetadataReadOptions extends VerserEnvelopeParserOptions {
  /** The Guest peer ID. */
  readonly guestId: string;
  /** The lease stream identifier. */
  readonly leaseId: string;
}

/**
 * A protcol-level registration request sent by a Peer (Guest or Broker) to the Host
 * on the `/verser/register` stream.
 *
 * Guests supply `routedDomains` to advertise the hostnames they handle. Brokers
 * typically omit `routedDomains` and receive the full route table in the response.
 *
 * @public
 */
export interface VerserRegistrationRequest {
  /** Application-chosen unique identifier for this Peer. */
  readonly peerId: string;
  /** The Peer's role: `'guest'` or `'broker'`. */
  readonly role: VerserPeerRole;
  /**
   * Hostnames this Guest handles.
   * Route matching uses exact hostname equality.
   * Brokers typically omit this field.
   */
  readonly routedDomains?: readonly string[];
}

/**
 * The Host's response to a peer registration request.
 *
 * @public
 */
export interface VerserRegistrationResponse {
  /** Status string, typically `'registered'`. */
  readonly status?: string;
  /** Full current route table (advertised to Brokers). */
  readonly routes?: readonly RoutedDomainRegistration[];
}

/**
 * Parsed identity information extracted from a TLS client certificate.
 *
 * Used by the Host's registration authorization callback to inspect the connecting
 * peer's certificate. The fingerprint is computed as `sha256:<hex>`.
 *
 * @public
 */
export interface VerserCertificateIdentity {
  /** Common Name (CN) from the certificate subject, if present. */
  readonly commonName?: string;
  /** DNS Subject Alternative Names (SANs). */
  readonly dnsNames: readonly string[];
  /** URI Subject Alternative Names. */
  readonly uriNames: readonly string[];
  /**
   * SHA-256 certificate fingerprint in `sha256:<hex>` format.
   * Computed from the DER-encoded certificate bytes.
   */
  readonly fingerprint256: string;
  /** Human-readable certificate subject string (e.g. `CN=client.example.com, O=Example`). */
  readonly subject: string;
  /** Human-readable certificate issuer string. */
  readonly issuer: string;
  /** Certificate validity start date string. */
  readonly validFrom: string;
  /** Certificate validity end date string. */
  readonly validTo: string;
  /** Raw DER certificate bytes encoded as a Base64 string (if available). */
  readonly raw?: string;
  /** Selected X.509v3 custom extension values, keyed by OID. */
  readonly customExtensions: Readonly<Record<string, string>>;
}

/**
 * Context provided to the registration authorization callback when a Peer connects.
 *
 * Includes the peer's registration details, TLS certificate identity (if mTLS is enabled),
 * and socket-level TLS authorization state. The callback can inspect these to decide
 * whether to `'allow'` or `'close'` the connection.
 *
 * @public
 */
export interface VerserRegistrationAuthorizationContext {
  /** The Peer's supplied identifier. */
  readonly peerId: VerserPeerId;
  /** The Peer's role. */
  readonly role: VerserPeerRole;
  /** Hostnames this Peer intends to handle (Guests only). */
  readonly routedDomains: readonly string[];
  /** Parsed TLS client certificate identity, if mTLS is configured. */
  readonly certificate?: VerserCertificateIdentity;
  /**
   * Additional metadata from the TLS socket:
   * - `authorized`: boolean indicating Node TLS verification result.
   * - `authorizationError`: string error message if verification failed.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * The action returned by a registration authorization callback.
 *
 * - `{ action: 'allow' }` — accept the registration.
 * - `{ action: 'close', reason?: string }` — reject and close the session.
 *
 * @public
 */
export type VerserRegistrationAuthorizationAction =
  | { readonly action: 'allow' }
  | { readonly action: 'close'; readonly reason?: string };

/**
 * Callback function for authorizing peer registration at connection time.
 *
 * Registered via {@link VerserHostClientAuthTlsOptions.authorizeRegistration}.
 * This is a registration-time mTLS/client certificate hook only, not a
 * complete per-request authentication or authorization system.
 *
 * @public
 */
export type VerserRegistrationAuthorizationCallback = (
  context: VerserRegistrationAuthorizationContext,
) => VerserRegistrationAuthorizationAction | Promise<VerserRegistrationAuthorizationAction>;

/**
 * A route-control frame sent by the Host to Brokers over the control stream.
 *
 * When Guest routes change (additions, removals, disconnections), the Host
 * sends a new `routes` frame with the full current route table. Brokers replace
 * their local state entirely on receipt, so a shorter or empty route list
 * implicitly retracts previously advertised routes.
 *
 * @public
 */
export interface VerserBrokerRoutesControlFrame {
  /** Discriminant — always `'routes'`. */
  readonly type: 'routes';
  /** The full current route table. */
  readonly routes: readonly RoutedDomainRegistration[];
}

/**
 * A route-control frame exchanged between federated Hosts.
 *
 * @public
 */
export interface VerserFederatedRoutesControlFrame {
  /** Discriminant — always `'federated-routes'`. */
  readonly type: 'federated-routes';
  /** Full federated route table from the advertising Host. */
  readonly routes: readonly FederatedRouteRegistration[];
}

/**
 * Options for enabling mTLS client certificate authentication on the Host.
 *
 * When `ca` or `caFile` is provided, the Host sets `requestCert` and `rejectUnauthorized`
 * on the TLS context, requiring all connecting peers to present a client certificate
 * signed by the configured CA. An optional `authorizeRegistration` callback allows
 * application-level admission control at registration time.
 *
 * **Note:** This is a registration-time authentication hook only. It is not a
 * complete per-request authorization or authentication gateway for Broker targets.
 *
 * @public
 */
export type VerserHostClientAuthTlsOptions = {
  /** CA certificate chain (PEM) for verifying client certificates. */
  readonly ca?: string;
  /** Path to a CA certificate file (PEM) for verifying client certificates. */
  readonly caFile?: string;
  /** Known X.509v3 extension OIDs to extract from client certificates. */
  readonly knownExtensionOids?: readonly string[];
  /**
   * Registration-time authorization callback.
   * Called after TLS verification succeeds; returning `'close'` rejects the peer.
   */
  readonly authorizeRegistration?: VerserRegistrationAuthorizationCallback;
};

/**
 * Host TLS identity configured via inline PEM `cert` and `key`.
 * @internal
 */
type VerserPemIdentityOptions = {
  readonly cert: string;
  readonly key: string;
  readonly certFile?: never;
  readonly keyFile?: never;
  readonly pfx?: never;
  readonly pfxFile?: never;
  readonly passphrase?: string;
};

/**
 * Host TLS identity configured via file paths to PEM `certFile` and `keyFile`.
 * Key file permissions are validated to be `0600` on non-Windows platforms.
 * @internal
 */
type VerserPemFileIdentityOptions = {
  readonly cert?: never;
  readonly key?: never;
  readonly certFile: string;
  readonly keyFile: string;
  readonly pfx?: never;
  readonly pfxFile?: never;
  readonly passphrase?: string;
};

/**
 * Host TLS identity configured via an inline PFX/PKCS12 buffer.
 * @internal
 */
type VerserPfxIdentityOptions = {
  readonly cert?: never;
  readonly key?: never;
  readonly certFile?: never;
  readonly keyFile?: never;
  readonly pfx: Buffer;
  readonly pfxFile?: never;
  readonly passphrase?: string;
};

/**
 * Host TLS identity configured via a PFX/PKCS12 file path.
 * @internal
 */
type VerserPfxFileIdentityOptions = {
  readonly cert?: never;
  readonly key?: never;
  readonly certFile?: never;
  readonly keyFile?: never;
  readonly pfx?: never;
  readonly pfxFile: string;
  readonly passphrase?: string;
};

/**
 * Complete TLS configuration for a Verser Host.
 *
 * Choose exactly one identity mode:
 * - `cert` + `key` (inline PEM)
 * - `certFile` + `keyFile` (PEM file paths)
 * - `pfx` (inline PFX/PKCS12 buffer)
 * - `pfxFile` (PFX/PKCS12 file path)
 *
 * The `clientAuth` sub-option enables mTLS client certificate verification.
 *
 * @public
 */
export type VerserHostTlsOptions = (
  | VerserPemIdentityOptions
  | VerserPemFileIdentityOptions
  | VerserPfxIdentityOptions
  | VerserPfxFileIdentityOptions
) & {
  /** Optional mTLS client authentication configuration. */
  readonly clientAuth?: VerserHostClientAuthTlsOptions;
};

/**
 * Options for trusting a CA certificate when connecting as a client (Guest or Broker).
 * @internal
 */
type VerserClientTrustOptions = {
  /** CA certificate chain (PEM) for trusting the Host's server certificate. */
  readonly ca?: string;
  /** Path to a CA certificate file (PEM) for trusting the Host's server certificate. */
  readonly caFile?: string;
};

/**
 * Client TLS identity sub-options (mutually exclusive modes as partial unions).
 * @internal
 */
type VerserClientIdentityOptions =
  | Partial<VerserPemIdentityOptions>
  | Partial<VerserPemFileIdentityOptions>
  | Partial<VerserPfxIdentityOptions>
  | Partial<VerserPfxFileIdentityOptions>;

/**
 * TLS options for a Guest or Broker connecting outbound to a Verser Host.
 *
 * Supports CA trust configuration and optional client certificate identity
 * (PEM inline, PEM files, or PFX/PKCS12). When CA material is supplied the
 * Host certificate is verified against that CA; otherwise the underlying
 * runtime's default trust behavior applies.
 *
 * @public
 */
export type VerserClientTlsOptions = VerserClientTrustOptions & VerserClientIdentityOptions;

/**
 * Union of all control frame types the Host sends to Brokers over the control stream.
 *
 * Currently only {@link VerserBrokerRoutesControlFrame} (`type: 'routes'`) is defined.
 *
 * @public
 */
export type VerserBrokerControlFrame = VerserBrokerRoutesControlFrame;

/**
 * Machine-readable error codes used in {@link VerserError} and error envelopes.
 *
 * - `'missing-guest'` — target Guest is not registered.
 * - `'disconnected-target'` — target Guest disconnected mid-request.
 * - `'timeout'` — lease acquisition or request processing timed out.
 * - `'stream-failure'` — underlying HTTP/2 stream error.
 * - `'protocol-error'` — invalid protocol data or state.
 * - `'local-handler-failure'` — local Guest handler threw or returned an error.
 * - `'invalid-registration'` — peer registration rejected (duplicate ID, bad role, etc.).
 * - `'certificate-verification-failure'` — TLS certificate validation failed.
 * - `'upstream-unavailable'` — selected upstream Host is not reachable.
 * - `'route-loop'` — federated route/request metadata would revisit a Host or exceed hop limits.
 * - `'authorization-denied'` — application authorization rejected a peer/upstream action.
 * - `'unsafe-retry'` — automatic retry would be unsafe for the request/body policy.
 *
 * @public
 */
export type VerserErrorCode =
  | 'missing-guest'
  | 'disconnected-target'
  | 'timeout'
  | 'stream-failure'
  | 'protocol-error'
  | 'local-handler-failure'
  | 'invalid-registration'
  | 'certificate-verification-failure'
  | 'upstream-unavailable'
  | 'route-loop'
  | 'authorization-denied'
  | 'unsafe-retry';

/**
 * A read-only record of key-value pairs providing structured context for an error.
 *
 * Values must be serializable — string, number, boolean, or undefined.
 *
 * @public
 */
export type VerserErrorContext = Readonly<Record<string, string | number | boolean | undefined>>;

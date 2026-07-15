/**
 * @module @signicode/verser-common
 *
 * Shared protocol types, constants, and helpers for the Verser HTTP routing
 * system.
 *
 * This package provides:
 * - **Envelope encoding/decoding** — binary format for request/response/error envelopes.
 * - **Routing helpers** — guest/peer ID creation, domain-based route resolution,
 *   and envelope validation. Route matching uses **exact** hostname equality.
 * - **Header normalization and validation** — HTTP header handling shared by
 *   the Host, Guest, and Broker packages.
 * - **Registration parsing** — peer registration request/response helpers.
 * - **TLS options normalization** — helpers for Host and client (Guest/Broker)
 *   TLS configuration, including PFX/PKCS12 support and certificate fingerprinting.
 * - **Error types** — `VerserError` with machine-readable codes and structured context.
 * - **Broker common interfaces** — shared Broker request/response and route
 *   discovery types.
 * - **Lifecycle events** — canonical event names used by Host and peer adapters.
 * - **NDJSON helpers** — for Broker route-control frame streaming.
 * - **Stream readers** — for reading exact byte counts from Node.js streams.
 *
 * @remarks
 * This package centralizes protocol-neutral contracts plus shared Node-facing
 * stream and TLS helpers used by the TypeScript packages. Runtime-specific
 * adapters remain in the Host and Guest/Broker packages.
 */
export { VERSER_COMMON_PACKAGE_NAME } from './lib/constants';

export {
  VERSER_ENVELOPE_PREFIX_BYTES,
  VERSER_ENVELOPE_TYPES,
  VERSER_ENVELOPE_VERSION,
} from './lib/constants';

export {
  DEFAULT_MAX_ENVELOPE_METADATA_BYTES,
  DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS,
  VERSER_GUEST_REVOCATION_PATH,
  VERSER_LIFECYCLE_EVENTS,
  VERSER_ROUTE_EVENT_REASONS,
  VERSER_ROUTE_LIFECYCLE_EVENT_TYPES,
} from './lib/constants';

export type {
  VerserPeerRole,
  VerserHostId,
  VerserHostFederationAuthorizationAction,
  VerserHostFederationAuthorizationCallback,
  VerserHostFederationAuthorizationContext,
  VerserHostFederationHandshake,
  VerserRegistrationRequest,
  VerserRegistrationAuthorizationAction,
  VerserRegistrationAuthorizationCallback,
  VerserRegistrationAuthorizationContext,
  VerserRegistrationResponse,
  VerserBrokerRoutesControlFrame,
  VerserBrokerRouteLifecycleControlFrame,
  VerserBrokerControlFrame,
  VerserCertificateIdentity,
  VerserClientTlsOptions,
  VerserHostClientAuthTlsOptions,
  VerserHostTlsOptions,
  LeaseRequestMetadataReadOptions,
  LeaseResponseMetadataReadOptions,
  FederatedRouteRegistration,
  ParsedVerserEnvelope,
  RoutedDomainRegistration,
  RoutedRequestEnvelope,
  RoutedResponseEnvelope,
  VerserEnvelopeMetadata,
  VerserEnvelopeParserOptions,
  VerserEnvelopeStreamReadOptions,
  VerserEnvelopeToEncode,
  VerserErrorCode,
  VerserErrorContext,
  VerserErrorEnvelopeMetadata,
  VerserHeaderValue,
  VerserHeaderInput,
  VerserHeaders,
  VerserCommonBroker,
  VerserCommonBrokerRequest,
  VerserCommonBrokerResponse,
  VerserPeerId,
  VerserRequestEnvelopeMetadata,
  VerserRequestId,
  VerserResponseEnvelopeMetadata,
  VerserStreamReadContext,
  VerserEnvelopeTypeName,
  VerserFederatedRoutesControlFrame,
  VerserFederatedRouteSource,
  VerserGuestId,
  VerserRouteLifecycleEventType,
  VerserRouteEventReason,
  VerserRouteGeneration,
  VerserRouteLifecycleEvent,
  VerserGuestRevocationRequest,
  VerserGuestRevocationResponse,
  VerserGuestDomainRevocationResult,
} from './lib/types';

export {
  FEDERATION_VWS_PATH,
  FEDERATION_VWS_VERSION,
  createFederationVwsAccept,
  createFederationVwsError,
  createFederationVwsNegotiationFailure,
  createFederationVwsOpen,
  createFederatedRouteRegistration,
  createFederatedRoutesControlFrame,
  createVerserHostFederationHandshake,
  createVerserHostId,
  exceedsFederatedRouteHopLimit,
  isFederatedRouteLoop,
} from './lib/federation';

export type {
  FederationVwsAccept,
  FederationVwsError,
  FederationVwsOpen,
  FederationVwsOpenInput,
} from './lib/federation';

export {
  createGuestId,
  createPeerId,
  createRoutedDomainRegistration,
  createRoutedRequestEnvelope,
  createRoutedResponseEnvelope,
  resolveRouteForHostname,
  resolveRouteForUrl,
} from './lib/routing';

export { createCommonBrokerRequest } from './lib/broker-request';

export {
  createBrokerRoutesControlFrame,
  parseRegistrationRequest,
  parseRegistrationResponse,
} from './lib/registration';

export {
  createBrokerRouteLifecycleControlFrame,
  createGuestRevocationRequest,
  createGuestRevocationResponse,
  createRouteLifecycleEvent,
  createVerserRouteGeneration,
} from './lib/route-lifecycle';

export {
  VerserError,
  createVerserError,
  toVerserError,
} from './lib/errors';

export { getErrorMessage } from './lib/utils';

export {
  createVerserEnvelopeParser,
  encodeVerserEnvelope,
  readLeaseRequestMetadataFromStream,
  readLeaseResponseMetadataFromStream,
  readVerserEnvelopeFromStream,
} from './lib/envelope';

export {
  VerserHttpErrorResponse,
  toVerserErrorCode,
  toVerserHttpErrorResponse,
  verserErrorFromResponseBody,
} from './lib/error-response';

export { readExactly } from './lib/stream-readers';

export {
  isIterableBody,
  isAsyncIterableBody,
  normalizeBrokerRequestBody,
} from './lib/body';

export { encodeJsonLine, readNdjsonLines } from './lib/ndjson';

export { decodeHeaderMap, flattenVerserHeaders } from './lib/header-serialization';

export {
  flattenHeaderValue,
  isValidHeaderName,
  isValidHeaderValue,
  normalizeHeaders,
  normalizeRequestHeaders,
  validateRuntimeNeutralHeaders,
} from './lib/headers';

export {
  VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER,
  parseLeaseAcquireTimeoutMs,
} from './lib/protocol-headers';

export { sanitizeHttp2ResponseHeaders, validateVerserHeaders } from './lib/headers';

export {
  toHttp2RequestHeaders,
  fromHttp2RequestHeaders,
  toHttp2ResponseHeaders,
  fromHttp2ResponseHeaders,
  stripHttp2PseudoHeaders,
} from './lib/http2-headers';

export {
  extractCertificateIdentity,
  normalizeClientTlsOptions,
  normalizeHostClientAuthTlsOptions,
  normalizeServerTlsOptions,
  getCertificateFingerprint,
  verifyPinnedCertificate,
} from './lib/tls';

export type {
  VwsFrame,
  VwsFrameType,
  VwsOpenFrame,
  VwsAcceptFrame,
  VwsTextFrame,
  VwsBinaryFrame,
  VwsPingFrame,
  VwsPongFrame,
  VwsCloseFrame,
  VwsErrorFrame,
} from './lib/vws';
export {
  VWS_MAX_FRAME_BYTES,
  encodeVwsFrame,
  decodeVwsFrame,
  readVwsLine,
} from './lib/vws';

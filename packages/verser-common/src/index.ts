export { VERSER_COMMON_PACKAGE_NAME } from './lib/constants';

export {
  VERSER_ENVELOPE_PREFIX_BYTES,
  VERSER_ENVELOPE_TYPES,
  VERSER_ENVELOPE_VERSION,
} from './lib/constants';

export { DEFAULT_MAX_ENVELOPE_METADATA_BYTES, VERSER_LIFECYCLE_EVENTS } from './lib/constants';

export type {
  DevelopmentTlsCertificate,
  VerserPeerRole,
  VerserRegistrationRequest,
  VerserRegistrationResponse,
  VerserBrokerRoutesControlFrame,
  VerserBrokerControlFrame,
  LeaseRequestMetadataReadOptions,
  LeaseResponseMetadataReadOptions,
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
  VerserHeaders,
  VerserPeerId,
  VerserRequestEnvelopeMetadata,
  VerserRequestId,
  VerserResponseEnvelopeMetadata,
  VerserStreamReadContext,
  VerserEnvelopeTypeName,
  VerserGuestId,
} from './lib/types';

export {
  createGuestId,
  createPeerId,
  createRoutedDomainRegistration,
  createRoutedRequestEnvelope,
  createRoutedResponseEnvelope,
} from './lib/routing';

export {
  createBrokerRoutesControlFrame,
  parseRegistrationRequest,
  parseRegistrationResponse,
} from './lib/registration';

export {
  VerserError,
  createVerserError,
} from './lib/errors';

export {
  createVerserEnvelopeParser,
  encodeVerserEnvelope,
  readLeaseRequestMetadataFromStream,
  readLeaseResponseMetadataFromStream,
  readVerserEnvelopeFromStream,
} from './lib/envelope';

export { readExactly } from './lib/stream-readers';

export { readNdjsonLines } from './lib/ndjson';

export { decodeHeaderMap, flattenVerserHeaders } from './lib/header-serialization';

export {
  VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER,
  parseLeaseAcquireTimeoutMs,
} from './lib/protocol-headers';

export { validateVerserHeaders } from './lib/headers';

export {
  toHttp2RequestHeaders,
  fromHttp2RequestHeaders,
  toHttp2ResponseHeaders,
  fromHttp2ResponseHeaders,
  stripHttp2PseudoHeaders,
} from './lib/http2-headers';

export {
  createDevelopmentTlsCertificate,
  getCertificateFingerprint,
  verifyPinnedCertificate,
} from './lib/tls';

export { VERSER_COMMON_PACKAGE_NAME } from './lib/constants';

export {
  VERSER_ENVELOPE_PREFIX_BYTES,
  VERSER_ENVELOPE_TYPES,
  VERSER_ENVELOPE_VERSION,
} from './lib/constants';

export { DEFAULT_MAX_ENVELOPE_METADATA_BYTES, VERSER_LIFECYCLE_EVENTS } from './lib/constants';

export type {
  VerserPeerRole,
  VerserRegistrationRequest,
  VerserRegistrationResponse,
  VerserBrokerRoutesControlFrame,
  VerserBrokerControlFrame,
  VerserClientTlsOptions,
  VerserHostTlsOptions,
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
  VerserGuestId,
} from './lib/types';

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

export { validateVerserHeaders } from './lib/headers';

export {
  toHttp2RequestHeaders,
  fromHttp2RequestHeaders,
  toHttp2ResponseHeaders,
  fromHttp2ResponseHeaders,
  stripHttp2PseudoHeaders,
} from './lib/http2-headers';

export {
  normalizeClientTlsOptions,
  normalizeServerTlsOptions,
  getCertificateFingerprint,
  verifyPinnedCertificate,
} from './lib/tls';

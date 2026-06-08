export type VerserPeerId = string;

export type VerserPeerRole = 'broker' | 'guest';

export type VerserGuestId = string;

export type VerserRequestId = string;

export interface RoutedDomainRegistration {
  readonly targetId: VerserGuestId;
  readonly domain: string;
}

export interface RoutedRequestEnvelope {
  readonly requestId: VerserRequestId;
  readonly sourceId: VerserPeerId;
  readonly targetId: VerserGuestId;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface RoutedResponseEnvelope {
  readonly requestId: VerserRequestId;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
}

export type VerserHeaderValue = string | readonly string[];

export type VerserHeaders = Readonly<Record<string, VerserHeaderValue>>;

export type VerserEnvelopeTypeName = 'request' | 'response' | 'error';

export interface VerserRequestEnvelopeMetadata {
  readonly requestId: VerserRequestId;
  readonly sourceId: VerserPeerId;
  readonly targetId: VerserGuestId;
  readonly method: string;
  readonly path: string;
  readonly headers: VerserHeaders;
  readonly timeoutMs?: number;
}

export interface VerserResponseEnvelopeMetadata {
  readonly requestId: VerserRequestId;
  readonly statusCode: number;
  readonly headers: VerserHeaders;
}

export interface VerserErrorEnvelopeMetadata {
  readonly requestId: VerserRequestId;
  readonly code: VerserErrorCode;
  readonly message: string;
  readonly context?: VerserErrorContext;
}

export type VerserEnvelopeMetadata =
  | VerserRequestEnvelopeMetadata
  | VerserResponseEnvelopeMetadata
  | VerserErrorEnvelopeMetadata;

export interface VerserEnvelopeToEncode {
  readonly type: VerserEnvelopeTypeName;
  readonly metadata: VerserEnvelopeMetadata;
}

export interface ParsedVerserEnvelope {
  readonly type: VerserEnvelopeTypeName;
  readonly metadata: VerserEnvelopeMetadata;
  readonly bodyRemainder: Buffer;
}

export interface VerserEnvelopeParserOptions {
  readonly maxMetadataBytes?: number;
}

export interface VerserStreamReadContext {
  readonly requestId?: string;
  readonly targetId?: string;
  readonly guestId?: string;
  readonly leaseId?: string;
}

export interface VerserEnvelopeStreamReadOptions extends VerserEnvelopeParserOptions {
  readonly context?: VerserStreamReadContext;
}

export interface LeaseResponseMetadataReadOptions extends VerserEnvelopeParserOptions {
  readonly requestId: string;
  readonly targetId: string;
}

export interface LeaseRequestMetadataReadOptions extends VerserEnvelopeParserOptions {
  readonly guestId: string;
  readonly leaseId: string;
}

export interface DevelopmentTlsCertificate {
  readonly cert: string;
  readonly key: string;
}

export interface VerserRegistrationRequest {
  readonly peerId: string;
  readonly role: VerserPeerRole;
  readonly routedDomains?: readonly string[];
}

export interface VerserRegistrationResponse {
  readonly status?: string;
  readonly routes?: readonly RoutedDomainRegistration[];
}

export interface VerserBrokerRoutesControlFrame {
  readonly type: 'routes';
  readonly routes: readonly RoutedDomainRegistration[];
}

export type VerserBrokerControlFrame = VerserBrokerRoutesControlFrame;

export type VerserErrorCode =
  | 'missing-guest'
  | 'disconnected-target'
  | 'timeout'
  | 'stream-failure'
  | 'protocol-error'
  | 'local-handler-failure'
  | 'invalid-registration'
  | 'certificate-verification-failure';

export type VerserErrorContext = Readonly<Record<string, string | number | boolean | undefined>>;

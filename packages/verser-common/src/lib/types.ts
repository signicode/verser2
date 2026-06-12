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

export type VerserHeaderValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

export type VerserHeaderInput =
  | Readonly<Record<string, VerserHeaderValue>>
  | readonly string[]
  | Iterable<readonly [string, VerserHeaderValue]>;

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

export interface VerserCommonBrokerRequest<TBody = unknown> {
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: VerserHeaders;
  readonly body?: TBody;
}

export interface VerserCommonBrokerResponse<TBody> {
  readonly requestId: string;
  readonly statusCode: number;
  readonly headers: VerserHeaders;
  readonly body: TBody;
}

export interface VerserCommonBroker<TRequestBody = unknown, TResponseBody = unknown> {
  getRoutes(): { targetId: string; domain: string }[];
  waitForRoute(domain: string): Promise<void>;
  request(
    request: VerserCommonBrokerRequest<TRequestBody>,
  ): Promise<VerserCommonBrokerResponse<TResponseBody>>;
}

export interface LeaseResponseMetadataReadOptions extends VerserEnvelopeParserOptions {
  readonly requestId: string;
  readonly targetId: string;
}

export interface LeaseRequestMetadataReadOptions extends VerserEnvelopeParserOptions {
  readonly guestId: string;
  readonly leaseId: string;
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

export interface VerserCertificateIdentity {
  readonly commonName?: string;
  readonly dnsNames: readonly string[];
  readonly uriNames: readonly string[];
  readonly fingerprint256: string;
  readonly subject: string;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly raw?: string;
  readonly customExtensions: Readonly<Record<string, string>>;
}

export interface VerserRegistrationAuthorizationContext {
  readonly peerId: VerserPeerId;
  readonly role: VerserPeerRole;
  readonly routedDomains: readonly string[];
  readonly certificate?: VerserCertificateIdentity;
  readonly metadata: Readonly<Record<string, string | number | boolean | undefined>>;
}

export type VerserRegistrationAuthorizationAction =
  | { readonly action: 'allow' }
  | { readonly action: 'close'; readonly reason?: string };

export type VerserRegistrationAuthorizationCallback = (
  context: VerserRegistrationAuthorizationContext,
) => VerserRegistrationAuthorizationAction | Promise<VerserRegistrationAuthorizationAction>;

export interface VerserBrokerRoutesControlFrame {
  readonly type: 'routes';
  readonly routes: readonly RoutedDomainRegistration[];
}

export type VerserHostClientAuthTlsOptions = {
  readonly ca?: string;
  readonly caFile?: string;
  readonly knownExtensionOids?: readonly string[];
  readonly authorizeRegistration?: VerserRegistrationAuthorizationCallback;
};

type VerserPemIdentityOptions = {
  readonly cert: string;
  readonly key: string;
  readonly certFile?: never;
  readonly keyFile?: never;
  readonly pfx?: never;
  readonly pfxFile?: never;
  readonly passphrase?: string;
};

type VerserPemFileIdentityOptions = {
  readonly cert?: never;
  readonly key?: never;
  readonly certFile: string;
  readonly keyFile: string;
  readonly pfx?: never;
  readonly pfxFile?: never;
  readonly passphrase?: string;
};

type VerserPfxIdentityOptions = {
  readonly cert?: never;
  readonly key?: never;
  readonly certFile?: never;
  readonly keyFile?: never;
  readonly pfx: Buffer;
  readonly pfxFile?: never;
  readonly passphrase?: string;
};

type VerserPfxFileIdentityOptions = {
  readonly cert?: never;
  readonly key?: never;
  readonly certFile?: never;
  readonly keyFile?: never;
  readonly pfx?: never;
  readonly pfxFile: string;
  readonly passphrase?: string;
};

export type VerserHostTlsOptions = (
  | VerserPemIdentityOptions
  | VerserPemFileIdentityOptions
  | VerserPfxIdentityOptions
  | VerserPfxFileIdentityOptions
) & {
  readonly clientAuth?: VerserHostClientAuthTlsOptions;
};

type VerserClientTrustOptions = {
  readonly ca?: string;
  readonly caFile?: string;
};

type VerserClientIdentityOptions =
  | Partial<VerserPemIdentityOptions>
  | Partial<VerserPemFileIdentityOptions>
  | Partial<VerserPfxIdentityOptions>
  | Partial<VerserPfxFileIdentityOptions>;

export type VerserClientTlsOptions = VerserClientTrustOptions & VerserClientIdentityOptions;

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

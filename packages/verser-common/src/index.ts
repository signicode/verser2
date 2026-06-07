import { createHash } from 'node:crypto';

import { DEVELOPMENT_CERTIFICATE, DEVELOPMENT_PRIVATE_KEY } from './development-certificate';

export const VERSER_COMMON_PACKAGE_NAME = '@signicode/verser-common';

export type VerserPeerId = string;
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

export interface DevelopmentTlsCertificate {
  readonly cert: string;
  readonly key: string;
}

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

export class VerserError extends Error {
  public readonly code: VerserErrorCode;

  public readonly context: VerserErrorContext;

  public constructor(code: VerserErrorCode, message: string, context: VerserErrorContext = {}) {
    super(formatVerserErrorMessage(code, message, context));
    this.name = 'VerserError';
    this.code = code;
    this.context = context;
  }
}

export const VERSER_LIFECYCLE_EVENTS = {
  connected: 'connected',
  disconnected: 'disconnected',
  registered: 'registered',
  routeAdvertised: 'route-advertised',
  requestStarted: 'request-started',
  requestCompleted: 'request-completed',
  error: 'error',
  closed: 'closed',
} as const;

export const VERSER_ENVELOPE_VERSION = 1;

export const VERSER_ENVELOPE_PREFIX_BYTES = 6;

export const DEFAULT_MAX_ENVELOPE_METADATA_BYTES = 64 * 1024;

export const VERSER_ENVELOPE_TYPES = {
  request: 1,
  response: 2,
  error: 3,
} as const;

export function createGuestId(value: string): VerserGuestId {
  return requireNonEmpty(value, 'guest id');
}

export function createPeerId(value: string): VerserPeerId {
  return requireNonEmpty(value, 'peer id');
}

export function createRoutedDomainRegistration(
  registration: RoutedDomainRegistration,
): RoutedDomainRegistration {
  return {
    targetId: createGuestId(registration.targetId),
    domain: requireNonEmpty(registration.domain, 'routed domain'),
  };
}

export function createRoutedRequestEnvelope(
  envelope: RoutedRequestEnvelope,
): RoutedRequestEnvelope {
  return {
    requestId: requireNonEmpty(envelope.requestId, 'request id'),
    sourceId: createPeerId(envelope.sourceId),
    targetId: createGuestId(envelope.targetId),
    method: requireNonEmpty(envelope.method, 'request method'),
    path: requireNonEmpty(envelope.path, 'request path'),
    headers: { ...envelope.headers },
    timeoutMs: envelope.timeoutMs,
  };
}

export function createRoutedResponseEnvelope(
  envelope: RoutedResponseEnvelope,
): RoutedResponseEnvelope {
  return {
    requestId: requireNonEmpty(envelope.requestId, 'request id'),
    statusCode: requireValidStatusCode(envelope.statusCode),
    headers: { ...envelope.headers },
  };
}

export function createVerserError(
  code: VerserErrorCode,
  message: string,
  context: VerserErrorContext = {},
): VerserError {
  return new VerserError(code, message, context);
}

export function encodeVerserEnvelope(envelope: VerserEnvelopeToEncode): Buffer {
  const envelopeType = VERSER_ENVELOPE_TYPES[envelope.type];
  const metadata = Buffer.from(JSON.stringify(envelope.metadata), 'utf8');
  const prefix = Buffer.alloc(VERSER_ENVELOPE_PREFIX_BYTES);
  prefix[0] = VERSER_ENVELOPE_VERSION;
  prefix[1] = envelopeType;
  prefix.writeUInt32BE(metadata.length, 2);
  return Buffer.concat([prefix, metadata]);
}

export function createVerserEnvelopeParser(options: VerserEnvelopeParserOptions = {}): {
  push(chunk: Buffer): ParsedVerserEnvelope | undefined;
} {
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_ENVELOPE_METADATA_BYTES;
  let buffered = Buffer.alloc(0);

  return {
    push(chunk: Buffer): ParsedVerserEnvelope | undefined {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < VERSER_ENVELOPE_PREFIX_BYTES) {
        return undefined;
      }

      const version = buffered[0];
      if (version !== VERSER_ENVELOPE_VERSION) {
        throw createVerserError('protocol-error', 'Invalid envelope version', { version });
      }

      const type = envelopeTypeNameFromCode(buffered[1]);
      const metadataLength = buffered.readUInt32BE(2);
      if (metadataLength > maxMetadataBytes) {
        throw createVerserError('protocol-error', 'Envelope metadata length exceeds limit', {
          metadataLength,
          maxMetadataBytes,
        });
      }

      const metadataEnd = VERSER_ENVELOPE_PREFIX_BYTES + metadataLength;
      if (buffered.length < metadataEnd) {
        return undefined;
      }

      const metadataBytes = buffered.subarray(VERSER_ENVELOPE_PREFIX_BYTES, metadataEnd);
      const metadata = parseEnvelopeMetadata(metadataBytes, type);
      const bodyRemainder = buffered.subarray(metadataEnd);
      buffered = Buffer.alloc(0);

      return { type, metadata, bodyRemainder };
    },
  };
}

export function validateVerserHeaders(headers: VerserHeaders): Record<string, string | string[]> {
  const validatedHeaders: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (!isValidHttpHeaderName(normalizedName)) {
      throw createVerserError('protocol-error', 'Invalid header name', { header: name });
    }
    if (FORBIDDEN_HTTP1_HEADERS.has(normalizedName)) {
      throw createVerserError('protocol-error', 'Forbidden header for routed metadata', {
        header: normalizedName,
      });
    }

    validatedHeaders[normalizedName] = Array.isArray(value) ? [...value] : String(value);
  }

  return validatedHeaders;
}

export function toHttp2RequestHeaders(
  request: Pick<RoutedRequestEnvelope, 'method' | 'path'>,
): Record<string, string> {
  return {
    ':method': request.method,
    ':path': request.path,
  };
}

export function fromHttp2RequestHeaders(headers: Record<string, string | number | undefined>): {
  method: string;
  path: string;
} {
  return {
    method: requireNonEmpty(String(headers[':method'] ?? ''), 'HTTP/2 :method'),
    path: requireNonEmpty(String(headers[':path'] ?? ''), 'HTTP/2 :path'),
  };
}

export function toHttp2ResponseHeaders(
  response: Pick<RoutedResponseEnvelope, 'statusCode'>,
): Record<string, number> {
  return { ':status': response.statusCode };
}

export function fromHttp2ResponseHeaders(headers: Record<string, string | number | undefined>): {
  statusCode: number;
} {
  return { statusCode: requireValidStatusCode(Number(headers[':status'])) };
}

export function createDevelopmentTlsCertificate(): DevelopmentTlsCertificate {
  return {
    cert: DEVELOPMENT_CERTIFICATE,
    key: DEVELOPMENT_PRIVATE_KEY,
  };
}

export function getCertificateFingerprint(certificate: string): string {
  const normalizedCertificate = certificate.replace(
    /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g,
    '',
  );
  const certificateBytes = Buffer.from(normalizedCertificate, 'base64');
  return `sha256:${createHash('sha256').update(certificateBytes).digest('hex')}`;
}

export function verifyPinnedCertificate(
  certificate: string,
  expectedFingerprint: string,
): { valid: true } | { valid: false; reason: string } {
  if (getCertificateFingerprint(certificate) !== expectedFingerprint) {
    return { valid: false, reason: 'certificate fingerprint mismatch' };
  }

  return { valid: true };
}

function requireNonEmpty(value: string, label: string): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw createVerserError('invalid-registration', `${label} must not be empty`, { field: label });
  }

  return normalizedValue;
}

function requireValidStatusCode(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw createVerserError('protocol-error', 'HTTP status code must be between 100 and 599', {
      statusCode: value,
    });
  }

  return value;
}

function envelopeTypeNameFromCode(code: number): VerserEnvelopeTypeName {
  for (const [name, value] of Object.entries(VERSER_ENVELOPE_TYPES)) {
    if (value === code) {
      return name as VerserEnvelopeTypeName;
    }
  }

  throw createVerserError('protocol-error', 'Unknown envelope type', { envelopeType: code });
}

function parseEnvelopeMetadata(
  metadataBytes: Buffer,
  type: VerserEnvelopeTypeName,
): VerserEnvelopeMetadata {
  try {
    const parsed: unknown = JSON.parse(metadataBytes.toString('utf8'));
    if (!isRecord(parsed)) {
      throw createVerserError('protocol-error', 'Envelope metadata must be a JSON object', {
        type,
      });
    }

    return parsed as unknown as VerserEnvelopeMetadata;
  } catch (error) {
    if (error instanceof VerserError) {
      throw error;
    }
    throw createVerserError('protocol-error', 'Invalid envelope metadata JSON', { type });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FORBIDDEN_HTTP1_HEADERS = new Set(['connection', 'upgrade', 'keep-alive']);

function isValidHttpHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name);
}

function formatVerserErrorMessage(
  code: VerserErrorCode,
  message: string,
  context: VerserErrorContext,
): string {
  const contextPairs = Object.entries(context)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  const contextSuffix = contextPairs.length > 0 ? ` (${contextPairs.join(', ')})` : '';
  return `[${code}] ${message}${contextSuffix}`;
}

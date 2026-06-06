import { createHash } from 'node:crypto';

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

const DEVELOPMENT_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUcGxCKvTlgPifH21ATeizt1HGHscwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYwNjIyNDI1MFoXDTM2MDYw
MzIyNDI1MFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqRpxwuWv4fUnUGep7RaFRPUavG/Ny0hJ0oOFLLwZ/eao
NNi2+bFqSLgYpQ4yPOScWdrf3fKTF6PFgyp3SLks47oAdSrFQM/7saggGKopjkoi
1Ap+yIcM8PMfASWGveV5vL3Em8B9Otv5OiWXKBxWAPmlBbzq9C4Hi/L7yUqwezk/
PAQer858qxvZUbce1ALKtcfrHWVIuF0NGsWQoGV1mgNP20kCMOgzq3dsjxrPWON7
11Ch1rM3FQPiOAew/ntydkOcFhIPnwrqogar8enbuG6fGnyFW7mJFs38eOZ8kzZC
dl++7nNZ1kdaXFCqog6d0rNjexM+FQjMTwdozweEXQIDAQABo1MwUTAdBgNVHQ4E
FgQUXVvjKYexxO2QQ8o4zJvjTK1HigYwHwYDVR0jBBgwFoAUXVvjKYexxO2QQ8o4
zJvjTK1HigYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAXcEs
qZhGjEJp3DDHMrBF8mGOClei3yQ3mcwBsUGJWgZ8qipYKMvkTNIFHwoinBwlAr8I
MH4K3dEu/aHqmX1wHYYjvtgTV/FAQ+q981ChvpBD4bSLvma/AhTgb197sXJfZISb
z5xmuBLdMViOkfw+GcmOu3eJ9rsWsYUBhIox/yt6FlZK1YhhFPWajh/f5+0TrsUH
vK+l9K4yLRD1Ts7BfLM5Q/LWL4q9EORJLNZElrXYfC/CIVqviESRXfr/eZ3dt3UN
GkthF6n+PJK00w0Un9WKuDWwW8GNZtaabp4uqrmli+z5d7/dOQ9R+lbwJaX5GTL5
u/rZeXFivVwmXoY+yg==
-----END CERTIFICATE-----`;

const DEVELOPMENT_PRIVATE_KEY = `REMOVED_TEST_PRIVATE_KEY`;

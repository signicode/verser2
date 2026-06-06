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

const DEVELOPMENT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCpGnHC5a/h9SdQ
Z6ntFoVE9Rq8b83LSEnSg4UsvBn95qg02Lb5sWpIuBilDjI85JxZ2t/d8pMXo8WD
KndIuSzjugB1KsVAz/uxqCAYqimOSiLUCn7Ihwzw8x8BJYa95Xm8vcSbwH062/k6
JZcoHFYA+aUFvOr0LgeL8vvJSrB7OT88BB6vznyrG9lRtx7UAsq1x+sdZUi4XQ0a
xZCgZXWaA0/bSQIw6DOrd2yPGs9Y43vXUKHWszcVA+I4B7D+e3J2Q5wWEg+fCuqi
Bqvx6du4bp8afIVbuYkWzfx45nyTNkJ2X77uc1nWR1pcUKqiDp3Ss2N7Ez4VCMxP
B2jPB4RdAgMBAAECggEAC40ruz65xTYxcXvQrvTsX/mxp1tTKVvuoGDtQ9E091P+
e98Cn3Y/8T1o1ZGYMJ0ElIYakndDwV17HGAra34sHlbyOWQVZb2EudiRxLg5rtIf
+fBzmQV8sVLySb+YqjfW7o6KCS0HgPH43ut6yA8ozYKVhBmpH8qrJ6NkEWvhjVvk
ekL0hQ6nFHLhlC9ALyP1N/Ivn0lIfbh9ciX4+ZMa11cb2GTLd9UyLtiFMQn+EDv8
L7kfOtv8Fl4etJWj1tzDHCno+VySqlGaGMMjl4yjVG5mRlyWEAndtMcTyN0AJNSV
faIQTsBYT3v58fJxSpXAxaxx7Y5VT+tavzws0lFFgQKBgQDXuRvmZ8xL9AauG4qI
Of9qGII5C548e+pkkVu3p63uqLwNde5EkVf+Z3a9Yqk/pretZcdM/CvwkrZp6173
Ck5Xg8pu24o2JaqDFzcO4I9sp2qeLjdFl8sXnCmpePjdT3kvweWU7QCMoi0I+ibg
WFOPgN1k+pgmfdlQHDeQ51ecwQKBgQDIrQ4WcneA481fpRm0zPSTMs1s++3tFJ7t
gF02aAUD6P/J6R2jhXgExZZg4HSf0Xd25L48+w2toN/RGli9qTtRH36XeBrWa8e/
vuQ3pumZXlyp/UpcneFJYqgHLZeA8rTUcGW75npRUPHks5RgLtBa9/DfvyrXzDak
gfBeLmrinQKBgQCB9OEK77MSeqLflnXhVVc6WiNxLD+aXmg5R5xCSoCsyvfnAAmX
QxwIhdnxg5NEZjI3Ap6LEUuDNU8xBfuCxbGmZR25pQZhUlWjfYPMsZmVslG3k032
3dgalBhBIUCDSpJOI/gjvJddIYIR62kqM+u7Ar3dTF4GqkAVU7ph0AxmwQKBgQCM
peXiy7WAS6lMqN2cf63HYWrjQKtgZ/x/v2EVWdByDiMA8/cG/evBhG7CVW7H+Lq/
RNEk0lyi3ccgulOKEot1bxp9tPsyX3YvqO4xJzZAfQd7SQCOa0VT9uaHqWevQ+yD
nIdhK8d9KLtxLIAI7aawq2hSmZzAhOujX0MF74iQbQKBgQCqU+2I+ihn0TnxnjTD
Kw2Ykx1OOoSsXjRiKdXjy4hsqGkda1brb/uIvgRapR5+Yz8Vvv/f3+3N0XCucM4R
yP44r/FNqnZgT/Y2t06u1VhuLzUmbTjBi8FLlmtMUt0hOYZhiSzW6r/qqVg2IEw3
Sf6H52DZ2m9f6uULtz9inv2O7Q==
-----END PRIVATE KEY-----`;

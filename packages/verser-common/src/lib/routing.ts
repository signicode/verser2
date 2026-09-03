import { flattenVerserHeaderPairs } from './header-serialization';
import { sanitizeHttp2ResponseHeaderPairs, validateVerserStatusText } from './headers';
import type {
  RoutedDomainRegistration,
  RoutedRequestEnvelope,
  RoutedResponseEnvelope,
  VerserGuestId,
  VerserPeerId,
} from './types';
import { requireFinalResponseStatusCode, requireNonEmpty } from './utils';

/**
 * Validates and creates a {@link VerserGuestId}.
 *
 * Throws a `VerserError` with code `invalid-registration` if the value is empty
 * after trimming.
 *
 * @param value - The guest identifier string.
 * @returns The trimmed, non-empty guest ID.
 * @throws {VerserError} If the value is empty.
 * @public
 */
export function createGuestId(value: string): VerserGuestId {
  return requireNonEmpty(value, 'guest id');
}

/**
 * Validates and creates a {@link VerserPeerId}.
 *
 * Throws a `VerserError` with code `invalid-registration` if the value is empty
 * after trimming.
 *
 * @param value - The peer identifier string.
 * @returns The trimmed, non-empty peer ID.
 * @throws {VerserError} If the value is empty.
 * @public
 */
export function createPeerId(value: string): VerserPeerId {
  return requireNonEmpty(value, 'peer id');
}

/**
 * Validates and creates a {@link RoutedDomainRegistration}.
 *
 * Both `targetId` and `domain` must be non-empty. Throws `VerserError` with
 * code `invalid-registration` if validation fails.
 *
 * @param registration - The route registration to validate.
 * @returns The validated route registration.
 * @throws {VerserError} If targetId or domain is empty.
 * @public
 */
export function createRoutedDomainRegistration(
  registration: RoutedDomainRegistration,
): RoutedDomainRegistration {
  return {
    targetId: createGuestId(registration.targetId),
    domain: requireNonEmpty(registration.domain, 'routed domain'),
  };
}

/**
 * Normalizes a route domain for hop-local comparisons and cache keys.
 *
 * The normalization is the single canonical form shared by registration
 * binding, the Host route authorizer, and certificate DNS SAN matching:
 * trimmed, lowercased, URL-hostname parsed when possible, with IPv4-style
 * brackets and a single trailing dot removed. It performs no wildcard,
 * suffix, or port handling — exact normalized equality is required.
 *
 * @param value - The domain or authority string to normalize.
 * @returns The normalized domain, or an empty string when no usable hostname
 *   can be derived from the input.
 * @public
 */
export function normalizeVerserRouteDomain(value: string): string {
  const trimmed = String(value ?? '')
    .trim()
    .toLowerCase();
  if (trimmed.length === 0) {
    return '';
  }
  try {
    const hostname = new URL(`http://${trimmed}`).hostname;
    return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  } catch {
    return trimmed.replace(/\.$/, '');
  }
}

/**
 * Resolves a route by exact hostname match.
 *
 * Route matching uses **exact** URL hostname equality. No wildcard or suffix
 * matching is performed. Returns `undefined` if no matching route is found.
 *
 * @param routes - The list of registered routes.
 * @param hostname - The hostname to match (exact equality).
 * @returns The matching route, or `undefined` if not found.
 * @public
 */
export function resolveRouteForHostname(
  routes: readonly RoutedDomainRegistration[],
  hostname: string,
): RoutedDomainRegistration | undefined {
  return routes.find((route) => route.domain === hostname);
}

/**
 * Resolves a route for a full URL by matching its hostname.
 *
 * Delegates to {@link resolveRouteForHostname} using `url.hostname`.
 *
 * @param routes - The list of registered routes.
 * @param url - The URL whose hostname should be matched.
 * @returns The matching route, or `undefined` if not found.
 * @public
 */
export function resolveRouteForUrl(
  routes: readonly RoutedDomainRegistration[],
  url: URL,
): RoutedDomainRegistration | undefined {
  return resolveRouteForHostname(routes, url.hostname);
}

/**
 * Validates and creates a {@link RoutedRequestEnvelope}.
 *
 * Ensures all required fields (`requestId`, `sourceId`, `targetId`, `method`, `path`)
 * are non-empty and the headers are shallow-copied.
 *
 * @param envelope - The request envelope to validate.
 * @returns The validated request envelope.
 * @throws {VerserError} If any required field is empty.
 * @public
 */
export function createRoutedRequestEnvelope(
  envelope: RoutedRequestEnvelope,
): RoutedRequestEnvelope {
  return {
    requestId: requireNonEmpty(envelope.requestId, 'request id'),
    sourceId: createPeerId(envelope.sourceId),
    targetId: createGuestId(envelope.targetId),
    ...(envelope.routeDomain === undefined ? {} : { routeDomain: envelope.routeDomain }),
    method: requireNonEmpty(envelope.method, 'request method'),
    path: requireNonEmpty(envelope.path, 'request path'),
    headers: { ...envelope.headers },
    timeoutMs: envelope.timeoutMs,
  };
}

/**
 * Validates and creates a {@link RoutedResponseEnvelope}.
 *
 * Ensures `requestId` is non-empty and `statusCode` is final (200–599). When
 * `headerPairs` are supplied they are sanitized and authoritatively projected to
 * legacy `headers` with deterministic last-value-wins semantics.
 *
 * @param envelope - The response envelope to validate.
 * @returns The validated response envelope.
 * @throws {VerserError} If the request ID is empty or the status code is invalid.
 * @public
 */
export function createRoutedResponseEnvelope(
  envelope: RoutedResponseEnvelope,
): RoutedResponseEnvelope {
  const headerPairs =
    envelope.headerPairs === undefined
      ? undefined
      : sanitizeHttp2ResponseHeaderPairs(envelope.headerPairs);
  return {
    requestId: requireNonEmpty(envelope.requestId, 'request id'),
    statusCode: requireFinalResponseStatusCode(envelope.statusCode),
    headers:
      headerPairs === undefined ? { ...envelope.headers } : flattenVerserHeaderPairs(headerPairs),
    ...(envelope.statusText === undefined
      ? {}
      : { statusText: validateVerserStatusText(envelope.statusText) }),
    ...(headerPairs === undefined ? {} : { headerPairs }),
  };
}

import type {
  RoutedDomainRegistration,
  RoutedRequestEnvelope,
  RoutedResponseEnvelope,
  VerserGuestId,
  VerserPeerId,
} from './types';
import { requireNonEmpty, requireValidStatusCode } from './utils';

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

export function resolveRouteForHostname(
  routes: readonly RoutedDomainRegistration[],
  hostname: string,
): RoutedDomainRegistration | undefined {
  return routes.find((route) => route.domain === hostname);
}

export function resolveRouteForUrl(
  routes: readonly RoutedDomainRegistration[],
  url: URL,
): RoutedDomainRegistration | undefined {
  return resolveRouteForHostname(routes, url.hostname);
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

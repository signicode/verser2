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

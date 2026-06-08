import { createVerserError } from './errors';
import type {
  RoutedDomainRegistration,
  VerserBrokerRoutesControlFrame,
  VerserPeerRole,
  VerserRegistrationRequest,
  VerserRegistrationResponse,
} from './types';
import { getErrorMessage } from './utils';

export function parseRegistrationRequest(body: string): VerserRegistrationRequest {
  const parsed = JSON.parse(body) as Partial<VerserRegistrationRequest>;
  const role = parsed.role;
  if (role !== 'broker' && role !== 'guest') {
    throw createVerserError('invalid-registration', 'Registration role must be broker or guest', {
      role: String(role ?? ''),
    });
  }

  return {
    peerId: String(parsed.peerId ?? ''),
    role: role as VerserPeerRole,
    routedDomains: parsed.routedDomains ?? [],
  };
}

export function parseRegistrationResponse(
  body: string,
  peerId: string,
  contextIdField: 'peerId' | 'guestId' = 'peerId',
): VerserRegistrationResponse {
  try {
    return JSON.parse(body) as VerserRegistrationResponse;
  } catch (error) {
    throw createVerserError('protocol-error', 'Host returned invalid registration JSON', {
      [contextIdField]: peerId,
      cause: getErrorMessage(error),
    });
  }
}

export function createBrokerRoutesControlFrame(
  routes: readonly RoutedDomainRegistration[],
): VerserBrokerRoutesControlFrame {
  return {
    type: 'routes',
    routes: [...routes],
  };
}

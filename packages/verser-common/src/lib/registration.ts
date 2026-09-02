import { createVerserError } from './errors';
import { normalizeVerserRouteDomain } from './routing';
import type {
  RoutedDomainRegistration,
  VerserBrokerRoutesControlFrame,
  VerserPeerRole,
  VerserRegistrationRequest,
  VerserRegistrationResponse,
} from './types';
import { getErrorMessage } from './utils';

/**
 * Parses and validates a peer registration request body.
 *
 * Expects JSON with `peerId`, `role` (`'broker'` | `'guest'`), optional
 * `routedDomains` array, and an optional `brokerHopDomain` that is accepted
 * only for Brokers. A supplied hop-domain is normalized with
 * {@link normalizeVerserRouteDomain} and stored only after validation; it is
 * omitted entirely when absent. Throws if the role is invalid, if a Guest
 * supplies `brokerHopDomain`, or if a Broker supplies a value that is not a
 * non-empty string.
 *
 * @param body - The raw JSON string from the registration stream.
 * @returns The parsed and validated registration request.
 * @throws {VerserError} With code `invalid-registration` if the role is not `'broker'` or `'guest'`,
 *   or if `brokerHopDomain` is invalid for the supplied role.
 * @public
 */
export function parseRegistrationRequest(body: string): VerserRegistrationRequest {
  const parsed = JSON.parse(body) as Partial<VerserRegistrationRequest>;
  const role = parsed.role;
  if (role !== 'broker' && role !== 'guest') {
    throw createVerserError('invalid-registration', 'Registration role must be broker or guest', {
      role: String(role ?? ''),
    });
  }

  const hasBrokerHopDomain =
    parsed.brokerHopDomain !== undefined && parsed.brokerHopDomain !== null;
  if (hasBrokerHopDomain && role !== 'broker') {
    throw createVerserError(
      'invalid-registration',
      'brokerHopDomain is only valid for broker registrations',
      { role: String(role) },
    );
  }
  let brokerHopDomain: string | undefined;
  if (hasBrokerHopDomain) {
    if (typeof parsed.brokerHopDomain !== 'string') {
      throw createVerserError('invalid-registration', 'brokerHopDomain must be a string', {
        peerId: String(parsed.peerId ?? ''),
      });
    }
    brokerHopDomain = normalizeVerserRouteDomain(parsed.brokerHopDomain);
    if (brokerHopDomain.length === 0) {
      throw createVerserError(
        'invalid-registration',
        'brokerHopDomain must be a non-empty domain',
        {
          peerId: String(parsed.peerId ?? ''),
        },
      );
    }
  }

  return {
    peerId: String(parsed.peerId ?? ''),
    role: role as VerserPeerRole,
    routedDomains: parsed.routedDomains ?? [],
    ...(brokerHopDomain === undefined ? {} : { brokerHopDomain }),
  };
}

/**
 * Parses the Host's registration response JSON.
 *
 * @param body - The raw JSON string from the Host's response.
 * @param peerId - The peer's ID, used in error diagnostics.
 * @param contextIdField - The field name for the context ID in error messages (default `'peerId'`).
 * @returns The parsed registration response.
 * @throws {VerserError} With code `protocol-error` if the response is not valid JSON.
 * @public
 */
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

/**
 * Creates a route-control frame for sending the current route table to Brokers.
 *
 * The Host sends these frames over the Broker control stream. Brokers replace
 * their local route state entirely on receipt — a shorter or empty route list
 * implies retraction of previously advertised routes.
 *
 * @param routes - The current route table.
 * @returns A routes control frame object.
 * @public
 */
export function createBrokerRoutesControlFrame(
  routes: readonly RoutedDomainRegistration[],
): VerserBrokerRoutesControlFrame {
  return {
    type: 'routes',
    routes: routes.map((route) => ({
      targetId: route.targetId,
      domain: route.domain,
    })),
  };
}

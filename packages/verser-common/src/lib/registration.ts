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
 * `routedDomains` array, and an optional `brokerDomain` that is accepted only
 * for Brokers. A supplied Broker domain is normalized with
 * {@link normalizeVerserRouteDomain} and stored only after validation; it is
 * omitted entirely when absent. The legacy `brokerHopDomain` field is a clean
 * replacement: it is rejected whenever the property is present on the parsed
 * body — including a `null` value — rather than accepted as an alias. Throws
 * if the role is invalid, if a Guest supplies `brokerDomain`, or if a Broker
 * supplies a value that is not a non-empty string.
 *
 * @param body - The raw JSON string from the registration stream.
 * @returns The parsed and validated registration request.
 * @throws {VerserError} With code `invalid-registration` if the role is not `'broker'` or `'guest'`,
 *   if the legacy `brokerHopDomain` field is present, or if `brokerDomain` is
 *   invalid for the supplied role.
 * @public
 */
export function parseRegistrationRequest(body: string): VerserRegistrationRequest {
  const parsed = JSON.parse(body) as Partial<VerserRegistrationRequest> & {
    brokerHopDomain?: unknown;
  };
  const role = parsed.role;
  if (role !== 'broker' && role !== 'guest') {
    throw createVerserError('invalid-registration', 'Registration role must be broker or guest', {
      role: String(role ?? ''),
    });
  }

  // Reject the legacy field by own-property presence so a null (or otherwise
  // present-but-empty) `brokerHopDomain` cannot slip through the value check.
  if (Object.prototype.hasOwnProperty.call(parsed, 'brokerHopDomain')) {
    throw createVerserError(
      'invalid-registration',
      'brokerHopDomain is not supported; use brokerDomain',
      { peerId: String(parsed.peerId ?? '') },
    );
  }

  const hasBrokerDomain = parsed.brokerDomain !== undefined && parsed.brokerDomain !== null;
  if (hasBrokerDomain && role !== 'broker') {
    throw createVerserError(
      'invalid-registration',
      'brokerDomain is only valid for broker registrations',
      { role: String(role) },
    );
  }
  let brokerDomain: string | undefined;
  if (hasBrokerDomain) {
    if (typeof parsed.brokerDomain !== 'string') {
      throw createVerserError('invalid-registration', 'brokerDomain must be a string', {
        peerId: String(parsed.peerId ?? ''),
      });
    }
    brokerDomain = normalizeVerserRouteDomain(parsed.brokerDomain);
    if (brokerDomain.length === 0) {
      throw createVerserError('invalid-registration', 'brokerDomain must be a non-empty domain', {
        peerId: String(parsed.peerId ?? ''),
      });
    }
  }

  return {
    peerId: String(parsed.peerId ?? ''),
    role: role as VerserPeerRole,
    routedDomains: parsed.routedDomains ?? [],
    ...(brokerDomain === undefined ? {} : { brokerDomain }),
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

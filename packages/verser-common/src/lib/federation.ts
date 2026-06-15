import { createVerserError } from './errors';
import { createRoutedDomainRegistration } from './routing';
import type {
  FederatedRouteRegistration,
  VerserFederatedRoutesControlFrame,
  VerserHostFederationHandshake,
  VerserHostId,
} from './types';
import { isRecord, requireNonEmpty } from './utils';

/**
 * Validates and creates a {@link VerserHostId}.
 *
 * @public
 */
export function createVerserHostId(value: string): VerserHostId {
  if (typeof value !== 'string') {
    throw createVerserError('protocol-error', 'host id must be a string', {
      field: 'host id',
    });
  }

  return requireNonEmpty(value, 'host id');
}

/**
 * Validates Host federation handshake metadata.
 *
 * @public
 */
export function createVerserHostFederationHandshake(
  handshake: unknown,
): VerserHostFederationHandshake {
  if (!isRecord(handshake)) {
    throw createVerserError('protocol-error', 'Federation handshake must be an object');
  }
  if (handshake.type !== undefined && handshake.type !== 'verser-host-federation-handshake') {
    throw createVerserError('protocol-error', 'Federation handshake type is invalid', {
      type: String(handshake.type),
    });
  }
  if (!Number.isInteger(handshake.protocolVersion) || Number(handshake.protocolVersion) < 1) {
    throw createVerserError('protocol-error', 'Federation protocol version must be positive', {
      protocolVersion: numericContextValue(handshake.protocolVersion),
    });
  }
  assertOptionalBoolean(handshake.importRoutes, 'importRoutes');
  assertOptionalBoolean(handshake.exportRoutes, 'exportRoutes');

  const normalized: VerserHostFederationHandshake = {
    type: 'verser-host-federation-handshake',
    protocolVersion: Number(handshake.protocolVersion),
    hostId: createVerserHostId(handshake.hostId as string),
    maxHopCount: handshake.maxHopCount === undefined ? undefined : Number(handshake.maxHopCount),
    importRoutes: handshake.importRoutes as boolean | undefined,
    exportRoutes: handshake.exportRoutes as boolean | undefined,
  };

  if (normalized.maxHopCount !== undefined && !isValidHopCount(normalized.maxHopCount)) {
    throw createVerserError('protocol-error', 'Federation max hop count must be non-negative', {
      maxHopCount: normalized.maxHopCount,
    });
  }

  return normalized;
}

/**
 * Validates and creates a federated route advertisement.
 *
 * @public
 */
export function createFederatedRouteRegistration(
  registration: unknown,
): FederatedRouteRegistration {
  if (!isRecord(registration)) {
    throw createVerserError('protocol-error', 'Federated route registration must be an object');
  }
  if (!isValidHopCount(registration.hopCount)) {
    throw createVerserError('protocol-error', 'Federated route hop count must be non-negative', {
      hopCount: numericContextValue(registration.hopCount),
    });
  }
  if (registration.source !== 'local' && registration.source !== 'upstream') {
    throw createVerserError('protocol-error', 'Federated route source must be local or upstream', {
      source: String(registration.source),
    });
  }
  if (!Array.isArray(registration.viaHostIds)) {
    throw createVerserError('protocol-error', 'Federated route viaHostIds must be an array', {
      field: 'viaHostIds',
    });
  }

  const route = createRoutedDomainRegistration({
    targetId: registration.targetId as string,
    domain: registration.domain as string,
  });

  return {
    ...route,
    originHostId: createVerserHostId(registration.originHostId as string),
    nextHopHostId: createVerserHostId(registration.nextHopHostId as string),
    hopCount: Number(registration.hopCount),
    viaHostIds: registration.viaHostIds.map((hostId) => createVerserHostId(hostId as string)),
    source: registration.source,
  };
}

/**
 * Returns whether a federated route would revisit the supplied Host ID.
 *
 * @public
 */
export function isFederatedRouteLoop(
  route: Pick<FederatedRouteRegistration, 'viaHostIds' | 'originHostId'>,
  hostId: string,
): boolean {
  const normalizedHostId = createVerserHostId(hostId);
  return route.originHostId === normalizedHostId || route.viaHostIds.includes(normalizedHostId);
}

/**
 * Returns whether a federated route exceeds the configured maximum hop count.
 *
 * @public
 */
export function exceedsFederatedRouteHopLimit(
  route: Pick<FederatedRouteRegistration, 'hopCount'>,
  maxHopCount: number,
): boolean {
  if (!isValidHopCount(maxHopCount)) {
    throw createVerserError('protocol-error', 'Federation max hop count must be non-negative', {
      maxHopCount,
    });
  }

  return route.hopCount > maxHopCount;
}

/**
 * Creates a Host-to-Host federated routes control frame.
 *
 * @public
 */
export function createFederatedRoutesControlFrame(
  routes: readonly FederatedRouteRegistration[],
): VerserFederatedRoutesControlFrame {
  return {
    type: 'federated-routes',
    routes: routes.map(createFederatedRouteRegistration),
  };
}

function isValidHopCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw createVerserError('protocol-error', `Federation ${field} must be a boolean`, {
      field,
    });
  }
}

function numericContextValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

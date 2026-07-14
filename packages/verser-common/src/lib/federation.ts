import { createVerserError } from './errors';
import { createRoutedDomainRegistration } from './routing';
import type {
  FederatedRouteRegistration,
  VerserErrorCode,
  VerserFederatedRoutesControlFrame,
  VerserHostFederationHandshake,
  VerserHostId,
} from './types';
import { isRecord, requireNonEmpty } from './utils';

/** Version negotiated by the dedicated Host-to-Host VWS stream. */
export const FEDERATION_VWS_VERSION = 1;

/** Dedicated, versioned Host-to-Host VWS stream endpoint. */
export const FEDERATION_VWS_PATH = '/verser/host/federation/websocket';

export interface FederationVwsOpen {
  readonly type: 'open';
  readonly version: typeof FEDERATION_VWS_VERSION;
  readonly sourceId: string;
  readonly targetId: string;
  readonly domain: string;
  readonly path: string;
  readonly protocol?: string;
  readonly originHostId: VerserHostId;
  readonly viaHostIds: readonly VerserHostId[];
  readonly hopCount: number;
}

export interface FederationVwsAccept {
  readonly type: 'accept';
  readonly version: typeof FEDERATION_VWS_VERSION;
  readonly protocol?: string;
}

export interface FederationVwsOpenInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly domain: string;
  readonly path: string;
  readonly protocol?: string;
  readonly originHostId: string;
  readonly viaHostIds: readonly string[];
  readonly hopCount: number;
}

export interface FederationVwsError {
  readonly type: 'error';
  readonly version: typeof FEDERATION_VWS_VERSION;
  readonly message: string;
  readonly code?: VerserErrorCode;
}

export function createFederationVwsOpen(input: FederationVwsOpenInput): FederationVwsOpen {
  if (!isRecord(input) || typeof input.sourceId !== 'string' || input.sourceId.length === 0) {
    throw createVerserError('protocol-error', 'Federation VWS open source id is required');
  }
  if (typeof input.targetId !== 'string' || input.targetId.length === 0) {
    throw createVerserError('protocol-error', 'Federation VWS open target id is required');
  }
  if (typeof input.domain !== 'string' || input.domain.length === 0) {
    throw createVerserError('protocol-error', 'Federation VWS open domain is required');
  }
  if (typeof input.path !== 'string' || input.path.length === 0) {
    throw createVerserError('protocol-error', 'Federation VWS open path is required');
  }
  if (!isValidHopCount(input.hopCount) || !Array.isArray(input.viaHostIds)) {
    throw createVerserError('protocol-error', 'Federation VWS route metadata is invalid');
  }
  if (input.protocol !== undefined && typeof input.protocol !== 'string') {
    throw createVerserError('protocol-error', 'Federation VWS protocol must be a string');
  }
  return {
    type: 'open',
    version: FEDERATION_VWS_VERSION,
    sourceId: input.sourceId,
    targetId: input.targetId,
    domain: input.domain,
    path: input.path,
    ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    originHostId: createVerserHostId(input.originHostId),
    viaHostIds: input.viaHostIds.map((hostId) => createVerserHostId(hostId)),
    hopCount: input.hopCount,
  };
}

export function createFederationVwsAccept(input: { protocol?: string } = {}): FederationVwsAccept {
  const { protocol } = input;
  if (protocol !== undefined && typeof protocol !== 'string') {
    throw createVerserError('protocol-error', 'Federation VWS accepted protocol must be a string');
  }
  return {
    type: 'accept',
    version: FEDERATION_VWS_VERSION,
    ...(protocol === undefined ? {} : { protocol }),
  };
}

export function createFederationVwsError(
  message: string,
  code: VerserErrorCode = 'protocol-error',
): FederationVwsError {
  if (typeof message !== 'string' || message.length === 0) {
    throw createVerserError('protocol-error', 'Federation VWS error message is required');
  }
  return { type: 'error', version: FEDERATION_VWS_VERSION, message, code };
}

/** Creates the stable error used when a peer never returns accept/error. */
export function createFederationVwsNegotiationFailure(
  context: {
    targetId?: string;
    domain?: string;
  } = {},
): never {
  throw createVerserError(
    'websocket-negotiation-failed',
    'Federation VWS negotiation response was not received',
    context,
  );
}

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

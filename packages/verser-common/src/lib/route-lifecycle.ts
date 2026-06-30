import { createVerserError } from './errors';
import type {
  VerserBrokerRouteLifecycleControlFrame,
  VerserGuestDomainRevocationResult,
  VerserGuestRevocationRequest,
  VerserGuestRevocationResponse,
  VerserRouteEventReason,
  VerserRouteGeneration,
  VerserRouteLifecycleEvent,
  VerserRouteLifecycleEventType,
} from './types';
import { requireNonEmpty } from './utils';

const VALID_EVENT_TYPES: readonly VerserRouteLifecycleEventType[] = [
  'added',
  'removed',
  'changed',
  'degraded',
];

const VALID_EVENT_REASONS: readonly VerserRouteEventReason[] = [
  'registered',
  'revoked',
  'disconnected',
  'reconnected',
  'restored',
  'timeout',
  'updated',
];

/**
 * Creates a {@link VerserRouteGeneration} with an auto-generated generation id
 * and optional session id.
 *
 * @param options - Optional generation and session identifiers.
 * @returns A validated route generation metadata object.
 * @public
 */
export function createVerserRouteGeneration(options?: {
  generationId?: string;
  sessionId?: string;
}): VerserRouteGeneration {
  const generationId =
    options?.generationId ?? `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (typeof generationId !== 'string' || generationId.trim().length === 0) {
    throw createVerserError('protocol-error', 'generationId must be a non-empty string', {
      field: 'generationId',
    });
  }

  return {
    generationId: generationId.trim(),
    ...(options?.sessionId !== undefined && options.sessionId.trim().length > 0
      ? { sessionId: options.sessionId.trim() }
      : {}),
  };
}

/**
 * Validates and creates a {@link VerserRouteLifecycleEvent}.
 *
 * @param event - The lifecycle event input.
 * @returns A validated lifecycle event.
 * @throws {VerserError} If required fields are missing or invalid.
 * @public
 */
export function createRouteLifecycleEvent(
  event: Omit<VerserRouteLifecycleEvent, 'generation'> & {
    generation?: { generationId?: string; sessionId?: string };
  },
): VerserRouteLifecycleEvent {
  if (!VALID_EVENT_TYPES.includes(event.type as VerserRouteLifecycleEventType)) {
    throw createVerserError('protocol-error', 'Invalid route lifecycle event type', {
      type: String(event.type),
    });
  }

  if (
    event.reason !== undefined &&
    !VALID_EVENT_REASONS.includes(event.reason as VerserRouteEventReason)
  ) {
    throw createVerserError('protocol-error', 'Invalid route lifecycle event reason', {
      reason: String(event.reason),
    });
  }

  return {
    type: event.type as VerserRouteLifecycleEventType,
    targetId: requireNonEmpty(event.targetId, 'route lifecycle event targetId'),
    domain: requireNonEmpty(event.domain, 'route lifecycle event domain'),
    ...(event.reason !== undefined ? { reason: event.reason as VerserRouteEventReason } : {}),
    ...(event.generation !== undefined
      ? { generation: createVerserRouteGeneration(event.generation) }
      : {}),
  };
}

/**
 * Creates a {@link VerserBrokerRouteLifecycleControlFrame} from lifecycle events.
 *
 * @param events - The lifecycle events to include in the frame.
 * @returns A validated route lifecycle control frame.
 * @throws {VerserError} If any event is invalid.
 * @public
 */
export function createBrokerRouteLifecycleControlFrame(
  events: readonly (Omit<VerserRouteLifecycleEvent, 'generation'> & {
    generation?: { generationId?: string; sessionId?: string };
  })[],
): VerserBrokerRouteLifecycleControlFrame {
  return {
    type: 'route-lifecycle',
    events: events.map(createRouteLifecycleEvent),
  };
}

/**
 * Validates and creates a {@link VerserGuestRevocationRequest}.
 *
 * @param request - The raw revocation request input.
 * @returns A validated revocation request.
 * @throws {VerserError} If domains array is empty or contains invalid entries.
 * @public
 */
export function createGuestRevocationRequest(request: {
  domains: readonly string[];
}): VerserGuestRevocationRequest {
  if (!Array.isArray(request.domains) || request.domains.length === 0) {
    throw createVerserError(
      'revocation-failed',
      'Revocation request must include at least one domain',
      { domains: String(request.domains) },
    );
  }

  return {
    domains: request.domains.map((domain) => requireNonEmpty(domain, 'revocation domain')),
  };
}

/**
 * Creates a {@link VerserGuestRevocationResponse}.
 *
 * @param response - The response status and optional details.
 * @returns A validated revocation response.
 * @throws {VerserError} If the status is invalid.
 * @public
 */
export function createGuestRevocationResponse(response: {
  status: 'ack' | 'partial' | 'error';
  message?: string;
  failedDomains?: readonly { domain: string; error?: string }[];
}): VerserGuestRevocationResponse {
  if (response.status !== 'ack' && response.status !== 'partial' && response.status !== 'error') {
    throw createVerserError('protocol-error', 'Invalid revocation response status', {
      status: String(response.status),
    });
  }

  const failedDomains: readonly VerserGuestDomainRevocationResult[] | undefined =
    response.failedDomains !== undefined && response.failedDomains.length > 0
      ? response.failedDomains.map((fd) => ({
          domain: requireNonEmpty(fd.domain, 'revocation failure domain'),
          ...(fd.error !== undefined ? { error: fd.error } : {}),
        }))
      : undefined;

  return {
    status: response.status,
    ...(response.message !== undefined ? { message: response.message } : {}),
    ...(failedDomains !== undefined ? { failedDomains } : {}),
  };
}

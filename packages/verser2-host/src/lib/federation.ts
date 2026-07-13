/**
 * Host-internal federation and upstream-link helpers.
 *
 * Provides shared types, handshake/timeout utilities, stream opening helpers,
 * route frame handling, lifecycle forwarding/tagging, and federated incoming
 * request handling.
 *
 * @internal
 * This module is private to the Host implementation. It must not import
 * {@link NodeHttp2VerserHost} (no circular dependencies).
 */

import * as http2 from 'node:http2';
import { text as readStreamText } from 'node:stream/consumers';

import {
  FEDERATION_VWS_PATH,
  FEDERATION_VWS_VERSION,
  type FederatedRouteRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserBrokerRouteLifecycleControlFrame,
  type VerserError,
  type VerserHostId,
  type VerserRouteLifecycleEvent,
  createFederatedRoutesControlFrame,
  createFederationVwsNegotiationFailure,
  createVerserError,
  createVerserHostFederationHandshake,
  createVerserHostId,
  decodeVwsFrame,
  encodeJsonLine,
  encodeVerserEnvelope,
  flattenVerserHeaders,
  readLeaseRequestMetadataFromStream,
  readNdjsonLines,
  readVwsLine,
  sanitizeHttp2ResponseHeaders,
  validateVerserHeaders,
} from '@signicode/verser-common';

import type { LocalDispatchRequest } from './local-peers';
import type { VerserHostLifecycleEvent, VerserLocalBrokerResponse } from './types';
import { toVerserError } from './utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 1000;

export const FEDERATION_DISPATCH_REQUEST_PATH = '/verser/host/federation/dispatch-request';

// ---------------------------------------------------------------------------
// Shared federation types
// ---------------------------------------------------------------------------

export type FederationRequestStream = http2.ServerHttp2Stream | http2.ClientHttp2Stream;

export interface AcquiredFederatedRequestStream {
  readonly stream: FederationRequestStream;
  readonly via: 'inbound-federation' | 'upstream-link';
  readonly hostId: string;
}

// ---------------------------------------------------------------------------
// Handshake/timeout utilities
// ---------------------------------------------------------------------------

export function waitForUpstreamHandshakeResponse(
  stream: http2.ClientHttp2Stream,
  upstreamId: string,
): Promise<http2.IncomingHttpHeaders> {
  return new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
    let responded = false;
    const timeout = setTimeout(() => {
      cleanup();
      stream.close(http2.constants.NGHTTP2_CANCEL);
      reject(
        createVerserError('upstream-unavailable', 'Upstream federation handshake timed out', {
          upstreamId,
        }),
      );
    }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off('response', onResponse);
      stream.off('error', onError);
      stream.off('aborted', onAborted);
      stream.off('close', onClose);
    };
    const onResponse = (headers: http2.IncomingHttpHeaders): void => {
      responded = true;
      cleanup();
      resolve(headers);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(
        createVerserError('upstream-unavailable', 'Upstream federation handshake failed', {
          upstreamId,
          cause: error.message,
        }),
      );
    };
    const onAborted = (): void => {
      cleanup();
      reject(
        createVerserError('upstream-unavailable', 'Upstream federation handshake was aborted', {
          upstreamId,
        }),
      );
    };
    const onClose = (): void => {
      if (responded) {
        return;
      }
      cleanup();
      reject(
        createVerserError('upstream-unavailable', 'Upstream federation handshake closed early', {
          upstreamId,
        }),
      );
    };

    stream.once('response', onResponse);
    stream.once('error', onError);
    stream.once('aborted', onAborted);
    stream.once('close', onClose);
  });
}

export function withUpstreamHandshakeTimeout<T>(
  promise: Promise<T>,
  stream: http2.ClientHttp2Stream,
  upstreamId: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      reject(
        createVerserError('upstream-unavailable', 'Upstream federation handshake timed out', {
          upstreamId,
        }),
      );
    }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function getUpstreamRejectionReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      reason?: string;
      status?: string;
      error?: { message?: string };
    };
    return (
      parsed.reason ?? parsed.error?.message ?? parsed.status ?? 'Upstream Host federation rejected'
    );
  } catch {
    return body.trim() || 'Upstream Host federation rejected';
  }
}

export function getUpstreamHandshakeHostId(body: string, upstreamId: string): VerserHostId {
  try {
    const parsed = JSON.parse(body) as { hostId?: unknown };
    if (typeof parsed.hostId === 'string') {
      return createVerserHostId(parsed.hostId);
    }
  } catch (error) {
    throw createVerserError('protocol-error', 'Upstream federation response has invalid Host ID', {
      upstreamId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  throw createVerserError('protocol-error', 'Upstream federation response missing Host ID', {
    upstreamId,
  });
}

// ---------------------------------------------------------------------------
// Upstream handshake
// ---------------------------------------------------------------------------

export async function sendUpstreamHandshake(
  session: http2.ClientHttp2Session,
  upstreamId: string,
  localHostId: VerserHostId,
  maxHopCount?: number,
): Promise<VerserHostId> {
  const stream = session.request({
    ':method': 'POST',
    ':path': '/verser/host/federation',
    'content-type': 'application/json',
  });
  const response = waitForUpstreamHandshakeResponse(stream, upstreamId);
  stream.end(
    JSON.stringify(
      createVerserHostFederationHandshake({
        hostId: localHostId,
        protocolVersion: 1,
        maxHopCount,
        importRoutes: true,
        exportRoutes: true,
      }),
    ),
  );

  const [headers, body] = await withUpstreamHandshakeTimeout(
    Promise.all([response, readStreamText(stream)]),
    stream,
    upstreamId,
  );
  const statusCode = Number(headers[':status'] ?? 0);
  if (statusCode >= 200 && statusCode < 300) {
    return getUpstreamHandshakeHostId(body, upstreamId);
  }

  throw createVerserError('authorization-denied', getUpstreamRejectionReason(body), {
    upstreamId,
    statusCode,
  });
}

// ---------------------------------------------------------------------------
// Stream opening helpers
// ---------------------------------------------------------------------------

export async function openUpstreamRouteStream(
  session: http2.ClientHttp2Session,
  upstreamId: string,
  localHostId: VerserHostId,
  callbacks: { onFrame: (frame: unknown) => void; onError: (error: VerserError) => void },
): Promise<http2.ClientHttp2Stream> {
  const stream = session.request({
    ':method': 'POST',
    ':path': '/verser/host/federation/routes',
    'x-verser-host-id': localHostId,
  });
  const headers = await waitForUpstreamHandshakeResponse(stream, upstreamId);
  const statusCode = Number(headers[':status'] ?? 0);
  if (statusCode < 200 || statusCode >= 300) {
    stream.close(http2.constants.NGHTTP2_CANCEL);
    throw createVerserError('upstream-unavailable', 'Upstream federation route stream rejected', {
      upstreamId,
      statusCode,
    });
  }

  readNdjsonLines<unknown>(
    stream,
    (frame) => callbacks.onFrame(frame),
    (error) => callbacks.onError(error),
  );
  return stream;
}

export async function openUpstreamRequestStream(
  session: http2.ClientHttp2Session,
  upstreamId: string,
  localHostId: VerserHostId,
): Promise<http2.ClientHttp2Stream> {
  const stream = session.request({
    ':method': 'POST',
    ':path': '/verser/host/federation/request',
    'x-verser-host-id': localHostId,
  });
  const headers = await waitForUpstreamHandshakeResponse(stream, upstreamId);
  const statusCode = Number(headers[':status'] ?? 0);
  if (statusCode < 200 || statusCode >= 300) {
    stream.close(http2.constants.NGHTTP2_CANCEL);
    throw createVerserError('upstream-unavailable', 'Upstream federation request stream rejected', {
      upstreamId,
      statusCode,
    });
  }

  return stream;
}

/** Opens the dedicated, versioned Host-to-Host VWS stream. */
export async function openUpstreamFederationVwsStream(
  session: http2.ClientHttp2Session,
  upstreamId: string,
  localHostId: VerserHostId,
): Promise<http2.ClientHttp2Stream> {
  const stream = session.request({
    ':method': 'POST',
    ':path': FEDERATION_VWS_PATH,
    'content-type': 'application/x-ndjson',
    'x-verser-host-id': localHostId,
    'x-verser-federation-vws-version': String(FEDERATION_VWS_VERSION),
  });
  const headers = await waitForUpstreamHandshakeResponse(stream, upstreamId);
  const statusCode = Number(headers[':status'] ?? 0);
  if (statusCode < 200 || statusCode >= 300) {
    stream.close(http2.constants.NGHTTP2_CANCEL);
    throw createVerserError('upstream-unavailable', 'Upstream federation VWS stream rejected', {
      upstreamId,
      statusCode,
    });
  }
  return stream;
}

/** Reads the first federation-VWS negotiation response without buffering traffic. */
export async function readFederationVwsNegotiation(
  stream: FederationRequestStream,
  context: { targetId?: string; domain?: string } = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cancel = (): void => {
    if ('close' in stream && typeof stream.close === 'function') {
      stream.close(http2.constants.NGHTTP2_CANCEL);
    } else {
      stream.destroy();
    }
  };
  const line = new Promise<string>((resolve, reject) => {
    // biome-ignore lint/style/useConst: timer is cleared by cleanup before assignment completes
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const onAbort = (): void => {
      cancel();
      finish(
        createVerserError('stream-failure', 'Federation VWS negotiation was cancelled', context),
      );
    };
    timer = setTimeout(() => {
      cancel();
      try {
        createFederationVwsNegotiationFailure(context);
      } catch (error) {
        finish(error as Error);
      }
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    readVwsLine(stream).then(
      (value) => finish(undefined, value),
      (error: unknown) => {
        const oversized =
          typeof error === 'object' &&
          error !== null &&
          'closeCode' in error &&
          (error as { closeCode?: unknown }).closeCode === 1009;
        if (oversized) {
          finish(
            createVerserError(
              'protocol-error',
              error instanceof Error
                ? error.message
                : 'Federation VWS negotiation frame exceeds the maximum size',
              { ...context, cause: error instanceof Error ? error.message : String(error) },
            ),
          );
          return;
        }
        try {
          createFederationVwsNegotiationFailure(context);
        } catch (failure) {
          finish(failure as Error);
        }
      },
    );
  });
  const response = await line;
  const frame = (() => {
    try {
      return decodeVwsFrame(response);
    } catch (error) {
      throw createVerserError(
        'protocol-error',
        error instanceof Error ? error.message : 'Invalid federation VWS negotiation response',
        context,
      );
    }
  })();
  const version = (frame as { version?: unknown }).version;
  if (version !== FEDERATION_VWS_VERSION) {
    throw createVerserError('protocol-error', 'Federation VWS protocol version mismatch', {
      ...context,
      version: typeof version === 'number' ? version : undefined,
    });
  }
  if (frame.type === 'error') {
    throw createVerserError('protocol-error', frame.message, context);
  }
  if (frame.type !== 'accept') {
    throw createVerserError('protocol-error', 'Expected federation VWS accept response', context);
  }
  return frame.protocol;
}

export async function openUpstreamDispatchRequestStream(
  session: http2.ClientHttp2Session,
  upstreamId: string,
  localHostId: VerserHostId,
  extraContext?: Record<string, unknown>,
): Promise<http2.ClientHttp2Stream> {
  const stream = session.request({
    ':method': 'POST',
    ':path': FEDERATION_DISPATCH_REQUEST_PATH,
    'x-verser-host-id': localHostId,
  });
  const headers = await waitForUpstreamHandshakeResponse(stream, upstreamId);
  const statusCode = Number(headers[':status'] ?? 0);
  if (statusCode < 200 || statusCode >= 300) {
    stream.close(http2.constants.NGHTTP2_CANCEL);
    throw createVerserError(
      'upstream-unavailable',
      'Upstream federation dispatch request stream rejected',
      {
        upstreamId,
        statusCode,
        ...extraContext,
      },
    );
  }

  return stream;
}

// ---------------------------------------------------------------------------
// Route frame handling
// ---------------------------------------------------------------------------

/**
 * Callbacks required by {@link handleFederatedRouteFrame}.
 *
 * Passed by reference so the Host retains coordination of route registry
 * mutations, lifecycle emission, and forwarding.
 */
export interface FederatedRouteFrameCallbacks {
  setImportedRoutes(ownerId: string, routes: readonly FederatedRouteRegistration[]): void;
  advertiseRouteLifecycleEvents(
    events: VerserRouteLifecycleEvent[],
    skipFederation?: boolean,
  ): void;
  forwardLifecycleEventsExcluding(
    excludedOwnerId: string,
    frame: VerserBrokerRouteLifecycleControlFrame,
  ): void;
  removeImportedRoute(ownerId: string, targetId: string, domain: string): void;
}

/**
 * Processes a federated route control frame received on a route stream.
 *
 * Handles `federated-routes` and `route-lifecycle` frame types with loop
 * detection via the provided seen-IDs set.
 */
export function handleFederatedRouteFrame(
  ownerId: string,
  frame: unknown,
  seenFederationLifecycleEventIds: Set<string>,
  callbacks: FederatedRouteFrameCallbacks,
): void {
  if (typeof frame !== 'object' || frame === null || !('type' in frame)) {
    throw createVerserError('protocol-error', 'Invalid federated routes control frame', {
      ownerId,
    });
  }

  if (frame.type === 'federated-routes') {
    if (!('routes' in frame) || !Array.isArray(frame.routes)) {
      throw createVerserError(
        'protocol-error',
        'Invalid federated routes control frame: missing routes array',
        { ownerId },
      );
    }
    callbacks.setImportedRoutes(ownerId, frame.routes as FederatedRouteRegistration[]);
    return;
  }

  if (frame.type === 'route-lifecycle') {
    const lifecycleFrame = frame as {
      events?: readonly unknown[];
      _eid?: string;
    };

    // Loop detection: if this frame carries a unique event ID and we have
    // already seen it, skip processing entirely to prevent infinite loops
    // in cyclic federation topologies.
    if (lifecycleFrame._eid !== undefined) {
      if (seenFederationLifecycleEventIds.has(lifecycleFrame._eid)) {
        return; // Already processed this event — discard duplicate
      }
      // Bounded set: clear when exceeding threshold to prevent unbounded growth.
      if (seenFederationLifecycleEventIds.size >= 10000) {
        seenFederationLifecycleEventIds.clear();
      }
      seenFederationLifecycleEventIds.add(lifecycleFrame._eid);
    }

    if (!lifecycleFrame.events || !Array.isArray(lifecycleFrame.events)) {
      throw createVerserError(
        'protocol-error',
        'Invalid federated route-lifecycle control frame: missing events array',
        { ownerId },
      );
    }

    // Validate incoming events
    const events: VerserRouteLifecycleEvent[] = [];
    for (const rawEvent of lifecycleFrame.events) {
      if (
        typeof rawEvent !== 'object' ||
        rawEvent === null ||
        !('type' in rawEvent) ||
        typeof (rawEvent as Record<string, unknown>).type !== 'string' ||
        !('targetId' in rawEvent) ||
        !('domain' in rawEvent)
      ) {
        throw createVerserError('protocol-error', 'Invalid federated route-lifecycle event', {
          ownerId,
        });
      }
      events.push(rawEvent as VerserRouteLifecycleEvent);
    }

    // Forward to local Brokers
    callbacks.advertiseRouteLifecycleEvents(events, true);

    // Forward to all OTHER federated peers (excluding the sender) to enable
    // transitive multi-hop propagation without echoing back to the sender.
    // The forwarded frame carries the same _eid so downstream peers can also
    // detect duplicates.
    callbacks.forwardLifecycleEventsExcluding(
      ownerId,
      frame as VerserBrokerRouteLifecycleControlFrame,
    );

    // For 'removed' events, eagerly remove the route from our imported
    // set so it is no longer available for routing between the lifecycle
    // event and the next full federated-routes snapshot.
    for (const event of events) {
      if (event.type === 'removed') {
        callbacks.removeImportedRoute(ownerId, event.targetId, event.domain);
      }
    }
    return;
  }

  throw createVerserError('protocol-error', 'Invalid federated routes control frame', {
    ownerId,
    type: String(frame.type),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle forwarding/tagging
// ---------------------------------------------------------------------------

/**
 * Forwards a lifecycle JSON line to all federated peers except the specified
 * excluded owner.
 */
export function forwardFederatedLifecycleEventsExcluding(
  excludedOwnerId: string,
  lifecycleJson: string,
  upstreamLinks: Iterable<{
    readonly remoteHostId: string;
    readonly routeStream: { readonly closed: boolean; write(data: string): void };
  }>,
  inboundFederationHosts: Iterable<{
    readonly hostId: string;
    readonly routeStream?: { readonly closed: boolean; write(data: string): void };
  }>,
): void {
  for (const link of upstreamLinks) {
    if (link.remoteHostId !== excludedOwnerId && !link.routeStream.closed) {
      link.routeStream.write(lifecycleJson);
    }
  }

  for (const link of inboundFederationHosts) {
    if (
      link.hostId !== excludedOwnerId &&
      link.routeStream !== undefined &&
      !link.routeStream.closed
    ) {
      link.routeStream.write(lifecycleJson);
    }
  }
}

/**
 * Tags a lifecycle control frame with a unique event ID for loop detection.
 * Mutates the frame in-place (adds `_eid`).
 *
 * @returns The tagged frame and the updated counter value.
 */
export function tagFederatedLifecycleFrame(
  frame: VerserBrokerRouteLifecycleControlFrame,
  hostId: string,
  seenIds: Set<string>,
  counter: number,
): { taggedFrame: VerserBrokerRouteLifecycleControlFrame & { _eid: string }; nextCounter: number } {
  const nextCounter = counter + 1;
  const eid = `${hostId}:${nextCounter}`;
  // Record the ID immediately so the originating Host discards its own
  // event if it returns via a federation cycle.
  if (seenIds.size >= 10000) {
    seenIds.clear();
  }
  seenIds.add(eid);
  const taggedFrame = frame as VerserBrokerRouteLifecycleControlFrame & { _eid: string };
  taggedFrame._eid = eid;
  return { taggedFrame, nextCounter };
}

// ---------------------------------------------------------------------------
// Federated incoming request handling
// ---------------------------------------------------------------------------

/**
 * Handles an incoming federated request on a federation stream.
 *
 * Reads the request metadata, routes to a local Guest handler, writes the
 * response envelope, and pipes the response body.
 *
 * @param stream - The federation request stream.
 * @param peerHostId - The remote Host peer ID.
 * @param localHostId - The local Host ID (used for metadata guest ID).
 * @param routeFn - Function to route a local dispatch request.
 * @param emitLifecycle - Function to emit a lifecycle event.
 */
export async function handleFederatedIncomingRequestStream(
  stream: FederationRequestStream,
  peerHostId: string,
  localHostId: VerserHostId,
  routeFn: (request: LocalDispatchRequest) => Promise<VerserLocalBrokerResponse>,
  emitLifecycle: (event: VerserHostLifecycleEvent) => void,
): Promise<void> {
  let requestId: string | undefined;
  let targetId: string | undefined;
  let localSettled = false;
  let cleanupStreamListeners = (): void => {};
  try {
    const metadata = await readLeaseRequestMetadataFromStream(stream, {
      guestId: localHostId,
      leaseId: peerHostId,
    });
    requestId = metadata.requestId;
    targetId = metadata.targetId;
    const controller = new AbortController();
    const makeStreamFailure = (): Error =>
      createVerserError('stream-failure', 'Federated request stream was cancelled or failed', {
        peerHostId,
        requestId,
        targetId,
        rstCode:
          'rstCode' in stream
            ? String((stream as http2.ServerHttp2Stream).rstCode ?? 'unknown')
            : undefined,
      });
    const abortLocalFromStream = (): void => {
      if (localSettled) return;
      controller.abort(makeStreamFailure());
    };
    const cancelLocalOnClose = (): void => {
      if (localSettled) return;
      controller.abort(makeStreamFailure());
    };
    cleanupStreamListeners = (): void => {
      stream.off('aborted', abortLocalFromStream);
      stream.off('error', abortLocalFromStream);
      stream.off('close', cancelLocalOnClose);
    };
    stream.once('aborted', abortLocalFromStream);
    stream.once('error', abortLocalFromStream);
    stream.once('close', cancelLocalOnClose);
    const response = await routeFn({
      requestId: metadata.requestId,
      sourceId: metadata.sourceId,
      targetId: metadata.targetId,
      routeDomain: metadata.routeDomain,
      method: metadata.method,
      path: metadata.path,
      headers: flattenVerserHeaders(validateVerserHeaders(metadata.headers)),
      body: stream,
      leaseAcquireTimeoutMs: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
      signal: controller.signal,
    });
    stream.write(
      encodeVerserEnvelope({
        type: 'response',
        metadata: {
          requestId: response.requestId,
          statusCode: response.statusCode,
          headers: flattenVerserHeaders(
            validateVerserHeaders(sanitizeHttp2ResponseHeaders(response.headers)),
          ),
        },
      }),
    );
    response.body.once('error', () => {
      cleanupStreamListeners();
      if (!stream.closed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    response.body.once('close', cleanupStreamListeners);
    response.body.once('end', () => {
      localSettled = true;
      cleanupStreamListeners();
    });
    response.body.pipe(stream);
  } catch (error) {
    localSettled = true;
    cleanupStreamListeners();
    const verserError = toVerserError(error);
    emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: verserError });
    if (requestId !== undefined && targetId !== undefined && !stream.closed) {
      stream.end(
        encodeVerserEnvelope({
          type: 'error',
          metadata: {
            requestId,
            targetId,
            code: verserError.code,
            message: verserError.message,
            context: verserError.context,
          },
        }),
      );
      return;
    }
    if (!stream.closed) {
      stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  }
}

// ---------------------------------------------------------------------------
// Federated route writing
// ---------------------------------------------------------------------------

/**
 * Writes a federated routes control frame to a stream for the given peer.
 */
export function writeFederatedRoutes(
  stream: { write(data: string | Buffer): void },
  peerHostId: string,
  getRoutesForExport: (peerHostId: string) => readonly FederatedRouteRegistration[],
): void {
  stream.write(encodeJsonLine(createFederatedRoutesControlFrame(getRoutesForExport(peerHostId))));
}

import * as http2 from 'node:http2';
import { PassThrough } from 'node:stream';

import {
  type FederatedRouteRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserErrorEnvelopeMetadata,
  type VerserPeerId,
  type VerserResponseEnvelopeMetadata,
  createPeerId,
  createVerserError,
  decodeHeaderMap,
  encodeVerserEnvelope,
  flattenVerserHeaders,
  parseLeaseAcquireTimeoutMs,
  readLeaseResponseMetadataFromStream,
  readVerserEnvelopeFromStream,
  sanitizeHttp2ResponseHeaders,
  toVerserErrorCode,
  validateVerserHeaders,
} from '@signicode/verser-common';

import type { AcquiredFederatedRequestStream, FederationRequestStream } from './federation';
import type { GuestLeaseStream } from './lease-pool';
import {
  type LocalBrokerState,
  type LocalDispatchRequest,
  dispatchLocalGuestRequest,
  toReadableBody,
} from './local-peers';
import type {
  VerserHostLifecycleEvent,
  VerserLocalBrokerRequest,
  VerserLocalBrokerResponse,
  VerserLocalGuestRequestListener,
} from './types';
import { toVerserError } from './utils';

function normalizeRequestedDomain(value: string): string {
  const authority = value.trim();
  try {
    const hostname = new URL(`http://${authority}`).hostname.toLowerCase();
    return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  } catch {
    return authority.toLowerCase().replace(/\.$/, '');
  }
}

/** Minimal peer info needed by the routing functions. */
export interface PeerInfo {
  readonly role: string;
  readonly transport?: string;
  readonly localGuest?: { readonly listener: VerserLocalGuestRequestListener };
}

// ---------------------------------------------------------------------------
// Callbacks for Host operations
// ---------------------------------------------------------------------------

/**
 * Callback interface that the Host must provide so broker-routing functions
 * can access Host-owned state without importing the Host class.
 */
export interface BrokerRoutingCallbacks {
  /** Look up a registered peer by ID. */
  getPeer(id: string): PeerInfo | undefined;

  /** Emit a lifecycle event. */
  emitLifecycle(event: VerserHostLifecycleEvent): void;

  /** Get route candidates from the registry for federated fallback. */
  getRouteCandidates(targetId: string): Iterable<FederatedRouteRegistration>;

  /** Try to acquire an idle lease without queuing. */
  tryAcquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream | undefined>;

  /** Acquire a lease, queuing if no idle lease is available. */
  acquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream>;

  /** Try to acquire a federated request stream for forwarding. */
  tryAcquireFederatedRequestStream(
    hostId: string,
    timeoutMs: number,
  ): Promise<AcquiredFederatedRequestStream | undefined>;

  /** Track an AbortController under a peer ID for cleanup on disconnect. */
  trackController(peerId: VerserPeerId, controller: AbortController): void;

  /** Remove an AbortController from tracking. */
  untrackController(peerId: VerserPeerId, controller: AbortController): void;
}

// ---------------------------------------------------------------------------
// Helper: read federated response metadata from a stream
// ---------------------------------------------------------------------------

/**
 * Reads a Verser envelope from a federation stream and validates it is a
 * `response` or `error` type. Used by both H2 Broker and local Broker
 * federation paths.
 */
async function readFederatedResponseMetadata(
  stream: FederationRequestStream,
  options: { readonly requestId: string; readonly targetId: string },
): Promise<VerserResponseEnvelopeMetadata> {
  const parsed = await readVerserEnvelopeFromStream(stream, {
    context: { requestId: options.requestId, targetId: options.targetId },
  });

  if (parsed.type === 'response') {
    return parsed.metadata as VerserResponseEnvelopeMetadata;
  }

  if (parsed.type === 'error') {
    const errorMetadata = parsed.metadata as VerserErrorEnvelopeMetadata;
    throw createVerserError(toVerserErrorCode(errorMetadata.code), errorMetadata.message, {
      targetId: options.targetId,
      requestId: options.requestId,
      ...(errorMetadata.context ?? {}),
    });
  }

  throw createVerserError('protocol-error', 'Federated request returned a non-response envelope', {
    targetId: options.targetId,
    requestId: options.requestId,
  });
}

// ---------------------------------------------------------------------------
// H2 Broker → Host: route over federation stream
// ---------------------------------------------------------------------------

/**
 * Forwards an H2 Broker request through an acquired federation stream.
 *
 * Pipes the incoming Broker stream to the federation stream, reads response
 * metadata, then pipes the federation stream response back to the Broker
 * stream. Handles cancellation propagation (aborted/reset streams) and
 * cleanup.
 */
async function routeH2BrokerRequestOverFederationStream(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  requestStream: FederationRequestStream,
  requestId: string,
  targetId: string,
): Promise<void> {
  let completed = false;
  const cancelForwarding = (): void => {
    if (!completed && !requestStream.closed) {
      requestStream.close(http2.constants.NGHTTP2_CANCEL);
    }
  };
  const cleanupCancellation = (): void => {
    stream.off('aborted', cancelForwarding);
    stream.off('close', cancelOnReset);
    stream.off('error', cancelForwarding);
  };
  const cancelOnReset = (): void => {
    // Once response metadata has been delivered, a Broker close can be a
    // graceful-looking HTTP/2 close rather than an `aborted` event.  The
    // federation request is still live in that case, so close it unless the
    // forwarding operation has already completed.
    cancelForwarding();
  };
  stream.once('aborted', cancelForwarding);
  stream.once('close', cancelOnReset);
  stream.once('error', cancelForwarding);
  const responsePromise = readFederatedResponseMetadata(requestStream, {
    requestId,
    targetId,
  });
  requestStream.write(
    encodeVerserEnvelope({
      type: 'request',
      metadata: {
        requestId,
        sourceId: String(headers['x-verser-source-id'] ?? ''),
        targetId,
        method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
        path: String(headers['x-verser-path'] ?? '/'),
        headers: flattenVerserHeaders(
          validateVerserHeaders(decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}'))),
        ),
      },
    }),
  );
  stream.once('error', (error) => requestStream.destroy(error));
  stream.pipe(requestStream);

  try {
    const responseMetadata = await responsePromise;
    stream.respond({
      ':status': responseMetadata.statusCode,
      ...validateVerserHeaders(sanitizeHttp2ResponseHeaders(responseMetadata.headers)),
    });
    requestStream.once('error', () => {
      if (!stream.closed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    requestStream.pipe(stream);
    stream.once('finish', () => {
      completed = true;
      cleanupCancellation();
    });
  } finally {
    if (stream.writableEnded || stream.closed) {
      cleanupCancellation();
    }
  }
}

// ---------------------------------------------------------------------------
// H2 Broker → Host: route over lease stream
// ---------------------------------------------------------------------------

/**
 * Routes an H2 Broker request over an acquired Guest lease stream.
 *
 * Writes the request envelope, pipes the Broker stream into the lease,
 * reads the response, and pipes the lease response back to the Broker
 * stream. Handles cancellation from the Broker side.
 */
async function routeBrokerRequestOverLease(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  lease: GuestLeaseStream,
  requestId: string,
  targetId: string,
): Promise<void> {
  let completed = false;

  const cleanupCancellation = (): void => {
    stream.off('aborted', cancelLease);
    stream.off('error', cancelLease);
  };

  const cancelLease = (): void => {
    if (completed || lease.stream.closed) {
      return;
    }
    cleanupCancellation();
    // Unpipe so the lease stream no longer receives body data from the
    // cancelled Broker stream before we close it.
    stream.unpipe(lease.stream);
    if (!lease.stream.closed) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  };

  stream.once('aborted', cancelLease);
  stream.once('error', cancelLease);

  const responsePromise = readLeaseResponseMetadataFromStream(lease.stream, {
    requestId,
    targetId,
  });
  lease.stream.write(
    encodeVerserEnvelope({
      type: 'request',
      metadata: {
        requestId,
        sourceId: String(headers['x-verser-source-id'] ?? ''),
        targetId,
        method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
        path: String(headers['x-verser-path'] ?? '/'),
        headers: flattenVerserHeaders(
          validateVerserHeaders(decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}'))),
        ),
      },
    }),
  );
  stream.pipe(lease.stream);

  const responseMetadata = await responsePromise;
  stream.respond({
    ':status': responseMetadata.statusCode,
    ...validateVerserHeaders(sanitizeHttp2ResponseHeaders(responseMetadata.headers)),
  });

  // After response headers are sent, pipe the response body.
  // Guest-side errors during response use NGHTTP2_INTERNAL_ERROR to
  // distinguish from Broker-originated CANCEL in diagnostics.
  lease.stream.once('error', () => {
    completed = true;
    if (!stream.closed) {
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    }
  });
  lease.stream.once('close', () => {
    completed = true;
    cleanupCancellation();
  });
  lease.stream.pipe(stream);
  stream.once('finish', () => {
    completed = true;
    cleanupCancellation();
  });
  stream.once('error', () => {
    completed = true;
    cleanupCancellation();
  });
}

// ---------------------------------------------------------------------------
// H2 Broker → Host: route to local Guest
// ---------------------------------------------------------------------------

/**
 * Routes an H2 Broker request to a locally-attached Guest.
 *
 * Sets up cancellation propagation from the Broker stream to the local
 * dispatch AbortController, calls `routeLocalRequestDispatch`, responds
 * on the Broker stream with the response status/headers, and pipes the
 * response body.
 */
async function routeH2BrokerRequestToLocalGuest(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  requestId: string,
  targetId: VerserPeerId,
  callbacks: BrokerRoutingCallbacks,
): Promise<void> {
  const controller = new AbortController();
  let completed = false;
  const cancelLocalDispatch = (): void => {
    if (!completed) {
      controller.abort();
    }
  };
  const cleanupCancellation = (): void => {
    stream.off('aborted', cancelLocalDispatch);
    stream.off('error', cancelLocalDispatch);
    stream.off('close', cancelLocalDispatch);
  };
  stream.once('aborted', cancelLocalDispatch);
  stream.once('error', cancelLocalDispatch);
  stream.once('close', cancelLocalDispatch);

  try {
    const response = await routeLocalRequestDispatch(
      {
        requestId,
        sourceId: String(headers['x-verser-source-id'] ?? ''),
        targetId,
        method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
        path: String(headers['x-verser-path'] ?? '/'),
        headers: flattenVerserHeaders(
          validateVerserHeaders(decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}'))),
        ),
        body: stream,
        leaseAcquireTimeoutMs: parseLeaseAcquireTimeoutMs(headers),
        signal: controller.signal,
      },
      callbacks,
    );
    stream.respond({
      ':status': response.statusCode,
      ...validateVerserHeaders(sanitizeHttp2ResponseHeaders(response.headers)),
    });
    response.body.once('error', () => {
      if (!stream.closed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    response.body.pipe(stream);
    stream.once('finish', () => {
      completed = true;
      cleanupCancellation();
    });
  } catch (error) {
    cleanupCancellation();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// H2 Broker → Host: main Broker request routing
// ---------------------------------------------------------------------------

/**
 * Routes an incoming H2 Broker request to the target Guest.
 *
 * If the target is registered and remote, acquires a lease (with queuing).
 * If the target is registered and local, delegates to
 * `routeH2BrokerRequestToLocalGuest`. If the target is not registered,
 * attempts federated fallback.
 */
export async function routeBrokerRequest(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  callbacks: BrokerRoutingCallbacks,
): Promise<void> {
  const targetId = String(headers['x-verser-target-id'] ?? '');
  const requestId = String(headers['x-verser-request-id'] ?? `req-${Date.now()}`);
  const target = callbacks.getPeer(targetId);

  if (target === undefined) {
    if (
      await tryRouteH2BrokerRequestToFederatedHost(stream, headers, requestId, targetId, callbacks)
    ) {
      return;
    }
    throw createVerserError('missing-guest', 'Target Guest is not registered', { targetId });
  }
  if (target.role !== 'guest') {
    throw createVerserError('missing-guest', 'Target peer is not a Guest', { targetId });
  }
  const requestedHeaders = decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}'));
  const requestedDomainValue = requestedHeaders.host ?? requestedHeaders[':authority'];
  const requestedDomain =
    requestedDomainValue === undefined ? undefined : normalizeRequestedDomain(requestedDomainValue);
  if (
    requestedDomain !== undefined &&
    !Array.from(callbacks.getRouteCandidates(targetId)).some(
      (candidate) => normalizeRequestedDomain(candidate.domain) === requestedDomain,
    )
  ) {
    throw createVerserError('missing-guest', 'Target Guest route is not available', {
      targetId,
      domain: requestedDomain,
    });
  }
  if (target.transport === 'local') {
    await routeH2BrokerRequestToLocalGuest(
      stream,
      headers,
      requestId,
      createPeerId(targetId),
      callbacks,
    );
    return;
  }
  const lease = await callbacks.tryAcquireLease(
    createPeerId(targetId),
    requestId,
    parseLeaseAcquireTimeoutMs(headers),
  );
  if (lease !== undefined) {
    await routeBrokerRequestOverLease(stream, headers, lease, requestId, targetId);
    return;
  }

  const queuedLease = await callbacks.acquireLease(
    createPeerId(targetId),
    requestId,
    parseLeaseAcquireTimeoutMs(headers),
  );
  await routeBrokerRequestOverLease(stream, headers, queuedLease, requestId, targetId);
}

// ---------------------------------------------------------------------------
// H2 Broker → Host: try federated fallback
// ---------------------------------------------------------------------------

/**
 * Attempts to forward an H2 Broker request to a federated Host when the
 * target Guest is not locally registered.
 *
 * Iterates upstream route candidates and tries to acquire a federated
 * request stream for each candidate. On success, forwards the request
 * via `routeH2BrokerRequestOverFederationStream`.
 *
 * @returns `true` if the request was forwarded to a federated host,
 *          `false` if no upstream candidates exist.
 * @throws `upstream-unavailable` if candidates exist but none are reachable.
 */
async function tryRouteH2BrokerRequestToFederatedHost(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  requestId: string,
  targetId: string,
  callbacks: BrokerRoutingCallbacks,
): Promise<boolean> {
  let hadUpstreamCandidate = false;
  const unavailableCandidates: Array<{
    readonly domain: string;
    readonly originHostId: string;
    readonly nextHopHostId: string;
    readonly hopCount: number;
  }> = [];
  for (const candidate of callbacks.getRouteCandidates(targetId)) {
    if (candidate.source !== 'upstream') {
      continue;
    }
    hadUpstreamCandidate = true;
    unavailableCandidates.push({
      domain: candidate.domain,
      originHostId: candidate.originHostId,
      nextHopHostId: candidate.nextHopHostId,
      hopCount: candidate.hopCount,
    });
    const acquired = await callbacks.tryAcquireFederatedRequestStream(
      candidate.nextHopHostId,
      parseLeaseAcquireTimeoutMs(headers),
    );
    if (acquired === undefined) {
      continue;
    }

    await routeH2BrokerRequestOverFederationStream(
      stream,
      headers,
      acquired.stream,
      requestId,
      targetId,
    );
    return true;
  }

  if (hadUpstreamCandidate) {
    throw createVerserError('upstream-unavailable', 'No federated route candidates are available', {
      targetId,
      direction: 'federated-candidates',
      candidateCount: unavailableCandidates.length,
      nextHopHostIds: unavailableCandidates.map((candidate) => candidate.nextHopHostId).join(','),
      originHostIds: unavailableCandidates.map((candidate) => candidate.originHostId).join(','),
      domains: unavailableCandidates.map((candidate) => candidate.domain).join(','),
    });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Local Broker → Host: entry point for local Broker requests
// ---------------------------------------------------------------------------

/**
 * Routes a local Broker request to a target Guest.
 *
 * Validates the broker is not closed, constructs a {@link LocalDispatchRequest},
 * and delegates to {@link routeLocalRequestDispatch}.
 */
export async function routeLocalBrokerRequest(
  sourceId: VerserPeerId,
  broker: LocalBrokerState,
  request: VerserLocalBrokerRequest,
  callbacks: BrokerRoutingCallbacks,
): Promise<VerserLocalBrokerResponse> {
  if (broker.closed) {
    return Promise.reject(createVerserError('disconnected-target', 'Local Broker is closed'));
  }

  const requestId = `${sourceId}-${++broker.requestCounter}`;
  const targetId = createPeerId(request.targetId);
  const body = toReadableBody(request.body);
  return routeLocalRequestDispatch(
    {
      requestId,
      sourceId,
      targetId,
      method: request.method,
      path: request.path,
      headers: flattenVerserHeaders(validateVerserHeaders(request.headers ?? {})),
      body,
      leaseAcquireTimeoutMs: parseLeaseAcquireTimeoutMs({
        'x-verser-lease-acquire-timeout-ms': request.leaseAcquireTimeoutMs,
      }),
    },
    callbacks,
  );
}

// ---------------------------------------------------------------------------
// Local Broker → Host: dispatch a local request to the target Guest
// ---------------------------------------------------------------------------

/**
 * Dispatches a local request to a known target Guest.
 *
 * If the target is a local Guest, calls `routeLocalRequestToAttachedGuest`.
 * If the target is an H2 Guest, calls `routeLocalRequestToH2Guest`.
 * Sets up cancellation propagation (AbortController) and lifecycle events.
 * Falls back to `tryRouteLocalRequestToFederatedHost` if the peer is not
 * registered or is not a Guest.
 */
export async function routeLocalRequestDispatch(
  request: LocalDispatchRequest,
  callbacks: BrokerRoutingCallbacks,
): Promise<VerserLocalBrokerResponse> {
  const target = callbacks.getPeer(request.targetId);
  const controller = new AbortController();
  const cancelFromUpstream = (): void => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) {
    controller.abort(request.signal.reason);
  } else {
    request.signal?.addEventListener('abort', cancelFromUpstream, { once: true });
  }
  callbacks.trackController(request.sourceId, controller);
  callbacks.trackController(request.targetId, controller);
  const dispatchRequest = { ...request, signal: controller.signal };
  let response: VerserLocalBrokerResponse | undefined;
  const untrackController = (): void => {
    request.signal?.removeEventListener('abort', cancelFromUpstream);
    callbacks.untrackController(request.sourceId, controller);
    callbacks.untrackController(request.targetId, controller);
  };

  try {
    if (target === undefined || target.role !== 'guest') {
      const forwarded = await tryRouteLocalRequestToFederatedHost(dispatchRequest, callbacks);
      if (forwarded !== undefined) {
        response = forwarded;
      } else {
        throw createVerserError('missing-guest', 'Target Guest is not registered', {
          targetId: request.targetId,
        });
      }
    } else {
      const requestedDomainValue = request.headers.host ?? request.headers[':authority'];
      const requestedDomain =
        requestedDomainValue === undefined
          ? undefined
          : normalizeRequestedDomain(requestedDomainValue);
      if (
        requestedDomain !== undefined &&
        !Array.from(callbacks.getRouteCandidates(request.targetId)).some(
          (candidate) => normalizeRequestedDomain(candidate.domain) === requestedDomain,
        )
      ) {
        throw createVerserError('missing-guest', 'Target Guest has no active route', {
          targetId: request.targetId,
          domain: requestedDomain,
        });
      }
      callbacks.emitLifecycle({
        name: VERSER_LIFECYCLE_EVENTS.requestStarted,
        peerId: request.targetId,
        role: 'guest',
      });
      if (target.transport === 'local') {
        if (target.localGuest === undefined) {
          throw createVerserError('disconnected-target', 'Target local Guest is not attached', {
            targetId: request.targetId,
          });
        }
        response = await routeLocalRequestToAttachedGuest(
          dispatchRequest,
          target.localGuest.listener,
        );
      } else {
        response = await routeLocalRequestToH2Guest(dispatchRequest, callbacks);
      }
      callbacks.emitLifecycle({
        name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
        peerId: request.targetId,
        role: 'guest',
      });
    }
    const cancelResponse = (): void => {
      response?.body.destroy(
        createVerserError('disconnected-target', 'Local peer disconnected during request', {
          requestId: request.requestId,
          targetId: request.targetId,
          sourceId: request.sourceId,
        }),
      );
    };
    response.body.once('close', untrackController);
    response.body.once('end', untrackController);
    response.body.once('error', untrackController);
    controller.signal.addEventListener('abort', cancelResponse, { once: true });
    return response;
  } catch (error) {
    const verserError = toVerserError(error);
    callbacks.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.error,
      peerId: request.targetId,
      role: 'guest',
      error: verserError,
    });
    throw verserError;
  } finally {
    if (response === undefined) {
      untrackController();
    }
  }
}

// ---------------------------------------------------------------------------
// Local Broker → Host: dispatch to attached (local) Guest
// ---------------------------------------------------------------------------

/**
 * Dispatches a request directly to a locally-attached Guest's handler.
 */
async function routeLocalRequestToAttachedGuest(
  request: LocalDispatchRequest,
  listener: VerserLocalGuestRequestListener,
): Promise<VerserLocalBrokerResponse> {
  return dispatchLocalGuestRequest(request, listener);
}

// ---------------------------------------------------------------------------
// Local Broker → Host: route to H2 Guest via lease
// ---------------------------------------------------------------------------

/**
 * Dispatches a request to an H2-connected Guest by acquiring a lease stream,
 * writing the request envelope, piping the body, reading the response
 * metadata, and returning the response with the lease stream as the body.
 *
 * Handles cancellation from the upstream signal.
 */
async function routeLocalRequestToH2Guest(
  request: LocalDispatchRequest,
  callbacks: BrokerRoutingCallbacks,
): Promise<VerserLocalBrokerResponse> {
  const lease = await callbacks.acquireLease(
    request.targetId,
    request.requestId,
    request.leaseAcquireTimeoutMs,
  );
  const cancelLease = (): void => {
    if (!lease.stream.closed) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  };
  if (request.signal?.aborted) {
    cancelLease();
    throw createVerserError('disconnected-target', 'Local peer disconnected during request', {
      requestId: request.requestId,
      targetId: request.targetId,
      sourceId: request.sourceId,
    });
  }
  request.signal?.addEventListener('abort', cancelLease, { once: true });
  const responsePromise = readLeaseResponseMetadataFromStream(lease.stream, {
    requestId: request.requestId,
    targetId: request.targetId,
  });
  lease.stream.write(
    encodeVerserEnvelope({
      type: 'request',
      metadata: {
        requestId: request.requestId,
        sourceId: request.sourceId,
        targetId: request.targetId,
        method: request.method,
        path: request.path,
        headers: flattenVerserHeaders(validateVerserHeaders(request.headers)),
      },
    }),
  );
  request.body.once('error', (error) => lease.stream.destroy(error));
  request.body.pipe(lease.stream);
  try {
    const metadata = await responsePromise;
    return {
      requestId: request.requestId,
      statusCode: metadata.statusCode,
      headers: flattenVerserHeaders(
        validateVerserHeaders(sanitizeHttp2ResponseHeaders(metadata.headers)),
      ),
      body: lease.stream,
    };
  } finally {
    request.signal?.removeEventListener('abort', cancelLease);
  }
}

// ---------------------------------------------------------------------------
// Local Broker → Host: try federated fallback for local request
// ---------------------------------------------------------------------------

/**
 * Attempts to forward a local Broker request to a federated Host when the
 * target Guest is not locally registered.
 *
 * Iterates upstream route candidates and tries to acquire a federated
 * request stream for each. On success, forwards the request via
 * `routeLocalRequestOverFederationStream`.
 *
 * @returns The response if forwarded, `undefined` if no upstream candidates.
 * @throws `upstream-unavailable` if candidates exist but none are reachable.
 */
async function tryRouteLocalRequestToFederatedHost(
  request: LocalDispatchRequest,
  callbacks: BrokerRoutingCallbacks,
): Promise<VerserLocalBrokerResponse | undefined> {
  let hadUpstreamCandidate = false;
  const unavailableCandidates: Array<{
    readonly domain: string;
    readonly originHostId: string;
    readonly nextHopHostId: string;
    readonly hopCount: number;
  }> = [];
  for (const candidate of callbacks.getRouteCandidates(request.targetId)) {
    if (candidate.source !== 'upstream') {
      continue;
    }
    hadUpstreamCandidate = true;
    unavailableCandidates.push({
      domain: candidate.domain,
      originHostId: candidate.originHostId,
      nextHopHostId: candidate.nextHopHostId,
      hopCount: candidate.hopCount,
    });
    const acquired = await callbacks.tryAcquireFederatedRequestStream(
      candidate.nextHopHostId,
      request.leaseAcquireTimeoutMs,
    );
    if (acquired === undefined) {
      continue;
    }

    return routeLocalRequestOverFederationStream(request, acquired.stream);
  }

  if (hadUpstreamCandidate) {
    throw createVerserError('upstream-unavailable', 'No federated route candidates are available', {
      targetId: request.targetId,
      direction: 'federated-candidates',
      candidateCount: unavailableCandidates.length,
      nextHopHostIds: unavailableCandidates.map((candidate) => candidate.nextHopHostId).join(','),
      originHostIds: unavailableCandidates.map((candidate) => candidate.originHostId).join(','),
      domains: unavailableCandidates.map((candidate) => candidate.domain).join(','),
    });
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Local Broker → Host: route local request over federation stream
// ---------------------------------------------------------------------------

/**
 * Forwards a local Broker request through an acquired federation stream.
 *
 * Writes the request envelope, pipes the request body, reads response
 * metadata, and pipes the federation stream response body back.
 */
async function routeLocalRequestOverFederationStream(
  request: LocalDispatchRequest,
  requestStream: FederationRequestStream,
): Promise<VerserLocalBrokerResponse> {
  const body = new PassThrough();
  const destroyBody = body.destroy.bind(body);
  body.destroy = (error?: Error): PassThrough => {
    if (error !== undefined && !(error instanceof Error)) {
      return destroyBody(
        createVerserError('stream-failure', 'Federated response stream failed', {
          requestId: request.requestId,
          targetId: request.targetId,
          cause: String(error),
        }),
      );
    }
    return destroyBody(error);
  };
  let settled = false;
  let responseBodyActive = false;
  let responseData: ((chunk: Buffer) => void) | undefined;
  let responseEnd: (() => void) | undefined;
  let responseError: ((error: Error) => void) | undefined;
  let responseClose: (() => void) | undefined;
  let bodyEnded = false;
  let bodyErrored = false;
  const requestBodyError = (error: Error): void => {
    requestStream.destroy(error);
  };
  const abortFederatedRequest = (): void => {
    if (settled || requestStream.closed) {
      return;
    }
    const reason = request.signal?.reason;
    request.body.unpipe(requestStream);
    request.body.destroy(reason instanceof Error ? reason : undefined);
    requestStream.close(http2.constants.NGHTTP2_CANCEL);
    body.destroy(
      reason instanceof Error
        ? reason
        : createVerserError('stream-failure', 'Federated request was cancelled', {
            requestId: request.requestId,
            targetId: request.targetId,
          }),
    );
  };
  request.signal?.addEventListener('abort', abortFederatedRequest, { once: true });
  const responsePromise = readFederatedResponseMetadata(requestStream, {
    requestId: request.requestId,
    targetId: request.targetId,
  });
  requestStream.write(
    encodeVerserEnvelope({
      type: 'request',
      metadata: {
        requestId: request.requestId,
        sourceId: request.sourceId,
        targetId: request.targetId,
        method: request.method,
        path: request.path,
        headers: flattenVerserHeaders(validateVerserHeaders(request.headers)),
      },
    }),
  );
  request.body.once('error', requestBodyError);
  request.body.pipe(requestStream);
  try {
    const metadata = await responsePromise;
    responseBodyActive = true;
    const cleanup = (): void => {
      settled = true;
      request.signal?.removeEventListener('abort', abortFederatedRequest);
      if (responseData !== undefined) requestStream.off('data', responseData);
      if (responseEnd !== undefined) requestStream.off('end', responseEnd);
      if (responseError !== undefined) requestStream.off('error', responseError);
      if (responseClose !== undefined) requestStream.off('close', responseClose);
      request.body.off('error', requestBodyError);
      request.body.unpipe(requestStream);
    };
    body.once('end', () => {
      bodyEnded = true;
      cleanup();
    });
    body.once('close', () => {
      if (!bodyEnded && !bodyErrored && !requestStream.closed) {
        requestStream.close(http2.constants.NGHTTP2_CANCEL);
      }
      cleanup();
    });
    body.once('error', () => {
      bodyErrored = true;
      if (!requestStream.closed) {
        requestStream.close(http2.constants.NGHTTP2_CANCEL);
      }
      cleanup();
    });
    responseData = (chunk: Buffer): void => {
      if (!body.write(chunk)) {
        requestStream.pause();
        body.once('drain', () => requestStream.resume());
      }
    };
    responseEnd = (): void => {
      body.end();
    };
    responseError = (error: Error): void => {
      body.destroy(
        createVerserError('stream-failure', 'Federated response stream failed', {
          requestId: request.requestId,
          targetId: request.targetId,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    };
    responseClose = (): void => {
      if (
        'rstCode' in requestStream &&
        (requestStream as http2.ServerHttp2Stream).rstCode !== http2.constants.NGHTTP2_NO_ERROR
      ) {
        body.destroy(
          createVerserError('stream-failure', 'Federated response stream was reset', {
            requestId: request.requestId,
            targetId: request.targetId,
            rstCode: String((requestStream as http2.ServerHttp2Stream).rstCode),
          }),
        );
      } else {
        body.end();
      }
    };
    requestStream.on('data', responseData);
    requestStream.once('end', responseEnd);
    requestStream.once('error', responseError);
    requestStream.once('close', responseClose);

    return {
      requestId: request.requestId,
      statusCode: metadata.statusCode,
      headers: flattenVerserHeaders(
        validateVerserHeaders(sanitizeHttp2ResponseHeaders(metadata.headers)),
      ),
      body,
    };
  } finally {
    // Keep the abort listener installed while the response body is being
    // consumed.  It is removed by the body terminal events above.
    if (!settled && !responseBodyActive) {
      settled = true;
      request.signal?.removeEventListener('abort', abortFederatedRequest);
    }
  }
}

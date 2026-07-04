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
    if (stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR) {
      cancelForwarding();
    }
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
  const cancelLease = (): void => {
    if (!completed && !lease.stream.closed) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  };
  stream.once('aborted', cancelLease);
  stream.once('error', cancelLease);
  stream.once('close', cancelLease);

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
  lease.stream.once('error', () => {
    if (!stream.closed) {
      stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  });
  lease.stream.pipe(stream);
  stream.once('finish', () => {
    completed = true;
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
  if (target === undefined || target.role !== 'guest') {
    const forwarded = await tryRouteLocalRequestToFederatedHost(request, callbacks);
    if (forwarded !== undefined) {
      return forwarded;
    }
    throw createVerserError('missing-guest', 'Target Guest is not registered', {
      targetId: request.targetId,
    });
  }

  callbacks.emitLifecycle({
    name: VERSER_LIFECYCLE_EVENTS.requestStarted,
    peerId: request.targetId,
    role: 'guest',
  });
  const controller = new AbortController();
  const cancelFromUpstream = (): void => controller.abort();
  if (request.signal?.aborted) {
    controller.abort();
  } else {
    request.signal?.addEventListener('abort', cancelFromUpstream, { once: true });
  }
  callbacks.trackController(request.sourceId, controller);
  callbacks.trackController(request.targetId, controller);
  let response: VerserLocalBrokerResponse | undefined;
  const untrackController = (): void => {
    request.signal?.removeEventListener('abort', cancelFromUpstream);
    callbacks.untrackController(request.sourceId, controller);
    callbacks.untrackController(request.targetId, controller);
  };
  try {
    if (target.transport === 'local') {
      if (target.localGuest === undefined) {
        throw createVerserError('disconnected-target', 'Target local Guest is not attached', {
          targetId: request.targetId,
        });
      }
      response = await routeLocalRequestToAttachedGuest(
        { ...request, signal: controller.signal },
        target.localGuest.listener,
      );
    } else {
      response = await routeLocalRequestToH2Guest(
        { ...request, signal: controller.signal },
        callbacks,
      );
    }
    callbacks.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
      peerId: request.targetId,
      role: 'guest',
    });
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
  request.body.once('error', (error) => requestStream.destroy(error));
  request.body.pipe(requestStream);
  const metadata = await responsePromise;
  requestStream.pipe(body);
  requestStream.once('end', () => body.end());
  requestStream.once('error', (error) => body.destroy(error));
  requestStream.once('close', () => body.end());

  return {
    requestId: request.requestId,
    statusCode: metadata.statusCode,
    headers: flattenVerserHeaders(
      validateVerserHeaders(sanitizeHttp2ResponseHeaders(metadata.headers)),
    ),
    body,
  };
}

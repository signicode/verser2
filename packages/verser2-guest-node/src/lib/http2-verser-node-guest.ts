import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import type { Readable } from 'node:stream';

import {
  VERSER_GUEST_REVOCATION_PATH,
  VERSER_LIFECYCLE_EVENTS,
  VWS_MAX_FRAME_BYTES,
  createGuestId,
  createGuestRevocationRequest,
  createGuestRevocationResponse,
  createRoutedRequestEnvelope,
  createVerserError,
  encodeVerserEnvelope,
  flattenVerserHeaders,
  getErrorMessage,
  normalizeClientTlsOptions,
  readLeaseRequestMetadataFromStream,
  readNdjsonLines,
  readVwsLine,
  validateVerserHeaders,
} from '@signicode/verser-common';
import { toVerserError } from './error-utils';
import { requestJson } from './http2-client-utils';
import { MinimalIncomingMessage, MinimalServerResponse } from './minimal-http';
import { NativeVerserWebSocket, markNativeVerserWebSocketOpen } from './native-websocket';
import type {
  NodeRequestListener,
  VerserNativeWebSocketHandler,
  VerserNodeGuest,
  VerserNodeGuestDispatchRequest,
  VerserNodeGuestDispatchResponse,
  VerserNodeGuestLifecycleEvent,
  VerserNodeGuestOptions,
  VerserWebSocketAcceptResult,
  VerserWebSocketHandler,
} from './types';
import { VerserWebSocket, acceptVerserWebSocket } from './verser-websocket';

type GuestLeaseState = 'opening' | 'waiting' | 'active';
type GuestRevocationResponse = ReturnType<typeof createGuestRevocationResponse>;
type GuestLeaseRequestMetadata = Awaited<ReturnType<typeof readLeaseRequestMetadataFromStream>>;

interface GuestLeaseStream {
  readonly leaseId: string;
  readonly stream: http2.ClientHttp2Stream;
  state: GuestLeaseState;
}

export class Http2VerserNodeGuest implements VerserNodeGuest {
  private readonly options: VerserNodeGuestOptions;

  private readonly lifecycle = new EventEmitter({ captureRejections: true });

  private session?: http2.ClientHttp2Session;

  private controlStream?: http2.ClientHttp2Stream;

  private readonly leaseStreams = new Map<string, GuestLeaseStream>();

  private leaseCounter = 0;

  private closing = false;

  private listener?: NodeRequestListener;

  private attachedDomain?: string;

  private wsHandler?: VerserWebSocketHandler;

  private nativeWsHandler?: VerserNativeWebSocketHandler;

  private wsDomain?: string;

  private readonly wsLeaseStreams = new Set<http2.ClientHttp2Stream>();

  public constructor(options: VerserNodeGuestOptions) {
    this.options = options;
    createGuestId(options.guestId);
  }

  public get connected(): boolean {
    return this.session !== undefined && !this.session.closed && !this.session.destroyed;
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const tls = normalizeClientTlsOptions(this.options.tls);
    const session = http2.connect(this.options.hostUrl, tls ?? {});
    this.session = session;
    this.closing = false;

    session.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
    session.on('close', () => {
      this.session = undefined;
      this.leaseStreams.clear();
      this.wsLeaseStreams.clear();
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.disconnected });
    });

    await once(session, 'connect');
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected });
    await this.register();
    this.openControlStream(session);
    this.maintainLeasePool();
    this.maintainWsLeasePool();
  }

  public attachWebSocket(handler: VerserWebSocketHandler, domain?: string): this {
    this.wsHandler = handler;
    this.wsDomain = domain ?? this.options.guestId;
    return this;
  }

  public attachNativeWebSocket(handler: VerserNativeWebSocketHandler, domain?: string): this {
    this.nativeWsHandler = handler;
    this.wsDomain = domain ?? this.options.guestId;
    return this;
  }

  public async close(reason = 'guest-close'): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }

    this.closing = true;
    this.controlStream?.close();
    this.closeLeaseStreams();
    this.closeWsLeaseStreams();
    session.close();
    await once(session, 'close');
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.closed, reason });
  }

  public attach(
    serverOrListener: http.Server | NodeRequestListener,
    domain = this.options.guestId,
  ): this {
    if (serverOrListener instanceof http.Server) {
      const requestListeners = serverOrListener.listeners('request');
      const listener = requestListeners[0];
      if (listener === undefined) {
        throw createVerserError(
          'local-handler-failure',
          'Attached HTTP server has no request listener',
          {
            guestId: this.options.guestId,
          },
        );
      }
      this.listener = listener as unknown as NodeRequestListener;
      this.attachedDomain = domain;
      return this;
    }

    this.listener = serverOrListener;
    this.attachedDomain = domain;
    return this;
  }

  public dispatchRoutedRequest(
    request: VerserNodeGuestDispatchRequest,
  ): Promise<VerserNodeGuestDispatchResponse> {
    const listener = this.listener;
    const envelope = createRoutedRequestEnvelope(request);
    if (listener === undefined) {
      return Promise.reject(
        createVerserError('local-handler-failure', 'No local HTTP handler is attached', {
          guestId: this.options.guestId,
          requestId: envelope.requestId,
        }),
      );
    }

    const localRequest = new MinimalIncomingMessage(request);
    const localResponse = new MinimalServerResponse(
      undefined,
      undefined,
      this.options.maxResponseBytes,
    );

    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.requestStarted,
      requestId: envelope.requestId,
    });

    return new Promise((resolve, reject) => {
      localResponse.once('error', reject);
      localResponse.once('finish', () => {
        const response = localResponse.toDispatchResponse(envelope.requestId);
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
          requestId: envelope.requestId,
        });
        resolve(response);
      });

      try {
        listener(localRequest, localResponse);
      } catch (error) {
        const verserError = createVerserError('local-handler-failure', getErrorMessage(error), {
          guestId: this.options.guestId,
          requestId: envelope.requestId,
          path: envelope.path,
        });
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.error,
          requestId: envelope.requestId,
          error: verserError,
        });
        reject(verserError);
      }
    });
  }

  public onLifecycle(listener: (event: VerserNodeGuestLifecycleEvent) => void): () => void {
    this.lifecycle.on('event', listener);
    return () => this.lifecycle.off('event', listener);
  }

  public async revokeRoutes(domains: readonly string[]): Promise<GuestRevocationResponse> {
    const session = this.session;
    if (session === undefined || session.closed || session.destroyed) {
      throw createVerserError('disconnected-target', 'Guest is not connected', {
        guestId: this.options.guestId,
      });
    }

    // Validate domains locally
    createGuestRevocationRequest({ domains });

    // Send revocation request to Host
    const responsePromise = new Promise<GuestRevocationResponse>((resolve, reject) => {
      const stream = session.request({
        ':method': 'POST',
        ':path': VERSER_GUEST_REVOCATION_PATH,
        'x-verser-peer-id': this.options.guestId,
        'content-type': 'application/json',
      });

      let body = '';

      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        body += chunk;
      });
      stream.on('end', () => {
        if (body.length === 0) {
          reject(
            createVerserError('revocation-failed', 'Host returned empty revocation response', {
              guestId: this.options.guestId,
            }),
          );
          return;
        }
        try {
          const parsed = JSON.parse(body) as GuestRevocationResponse;
          resolve(createGuestRevocationResponse(parsed));
        } catch (error) {
          reject(
            createVerserError('revocation-failed', 'Host returned invalid revocation response', {
              guestId: this.options.guestId,
              body,
            }),
          );
        }
      });
      stream.on('error', (error) => {
        reject(
          createVerserError('revocation-failed', 'Revocation request failed', {
            guestId: this.options.guestId,
            cause: error.message,
          }),
        );
      });

      stream.write(JSON.stringify({ domains }));
      stream.end();
    });

    return responsePromise;
  }

  private async register(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      throw createVerserError('disconnected-target', 'Guest is not connected', {
        guestId: this.options.guestId,
      });
    }

    const response = await requestJson(
      session,
      {
        peerId: this.options.guestId,
        role: 'guest',
        routedDomains: this.getRoutedDomains(),
      },
      this.options.guestId,
    );

    if (response.status !== 'registered') {
      throw createVerserError('invalid-registration', 'Host did not register Guest', {
        guestId: this.options.guestId,
      });
    }

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered });
  }

  private emitLifecycle(event: Omit<VerserNodeGuestLifecycleEvent, 'guestId'>): void {
    this.lifecycle.emit('event', { guestId: this.options.guestId, ...event });
  }

  private openControlStream(session: http2.ClientHttp2Session): void {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/guest/control',
      'x-verser-peer-id': this.options.guestId,
    });
    this.controlStream = stream;
    readNdjsonLines(stream, () => {
      // Guest control stream body routing was removed; keep stream open for coordination.
    });
  }

  private maintainLeasePool(): void {
    const session = this.session;
    if (session === undefined || this.closing || session.closed || session.destroyed) {
      return;
    }

    const minWaitingStreams = this.normalizedMinWaitingStreams();
    const maxOpenStreams = this.normalizedMaxOpenStreams();
    while (
      this.countLeases('waiting') + this.countLeases('opening') < minWaitingStreams &&
      this.leaseStreams.size < maxOpenStreams
    ) {
      this.openLeaseStream(session);
    }
  }

  private openLeaseStream(session: http2.ClientHttp2Session): void {
    const leaseId = `${this.options.guestId}-lease-${++this.leaseCounter}`;
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': this.options.guestId,
      'x-verser-lease-id': leaseId,
    });
    const lease: GuestLeaseStream = { leaseId, stream, state: 'opening' };
    this.leaseStreams.set(leaseId, lease);
    const timeout =
      this.options.leaseAcquireTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            this.emitLifecycle({
              name: VERSER_LIFECYCLE_EVENTS.error,
              error: createVerserError('timeout', 'Lease stream was not accepted before timeout', {
                guestId: this.options.guestId,
                leaseId,
                timeoutMs: this.options.leaseAcquireTimeoutMs ?? 0,
              }),
            });
            stream.close();
          }, this.options.leaseAcquireTimeoutMs);

    stream.once('response', (headers) => {
      clearTimeout(timeout);
      if (Number(headers[':status']) === 200) {
        lease.state = 'waiting';
        this.maintainLeasePool();
        return;
      }

      stream.close();
    });
    stream.on('close', () => {
      clearTimeout(timeout);
      this.leaseStreams.delete(leaseId);
      if (!this.closing) {
        this.maintainLeasePool();
      }
    });
    stream.on('error', (error) => {
      clearTimeout(timeout);
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
    this.handleLeaseStream(lease).catch((error: unknown) => {
      if (this.closing) {
        return;
      }
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      stream.close();
    });
  }

  private async handleLeaseStream(lease: GuestLeaseStream): Promise<void> {
    const metadata = await readLeaseRequestMetadataFromStream(lease.stream, {
      guestId: this.options.guestId,
      leaseId: lease.leaseId,
      maxMetadataBytes: this.options.maxMetadataBytes,
    });
    lease.state = 'active';
    await this.dispatchLeasedRequest(metadata, lease);
  }

  private dispatchLeasedRequest(
    metadata: GuestLeaseRequestMetadata,
    lease: GuestLeaseStream,
  ): Promise<void> {
    const listener = this.listener;
    if (listener === undefined) {
      lease.stream.end(
        encodeVerserEnvelope({
          type: 'error',
          metadata: {
            requestId: metadata.requestId,
            code: 'local-handler-failure',
            message: 'No local HTTP handler is attached',
            context: { guestId: this.options.guestId, requestId: metadata.requestId },
          },
        }),
      );
      return Promise.resolve();
    }

    const request = {
      requestId: metadata.requestId,
      sourceId: metadata.sourceId,
      targetId: metadata.targetId,
      routeDomain: metadata.routeDomain,
      method: metadata.method,
      path: metadata.path,
      headers: flattenVerserHeaders(validateVerserHeaders(metadata.headers)),
      body: [],
    } as VerserNodeGuestDispatchRequest;
    const localRequest = new MinimalIncomingMessage(request, lease.stream as Readable);
    const localResponse = new MinimalServerResponse(metadata.requestId, lease.stream);

    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.requestStarted,
      requestId: metadata.requestId,
    });

    return new Promise((resolve, reject) => {
      let completed = false;
      // Track whether we initiated the lease cancellation ourselves (e.g.
      // handler threw after response start). When we close the lease stream
      // with CANCEL, the same client-side H2 stream receives the RST and
      // triggers 'aborted', which would re-emit a spurious error on the
      // already-ended request. We suppress that case.
      let selfCancelled = false;
      const complete = (): void => {
        if (completed) return;
        completed = true;
        resolve();
      };

      localResponse.once('finish', () => {
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
          requestId: metadata.requestId,
        });
        complete();
      });
      localResponse.once('error', (err) => {
        completed = true;
        reject(err);
      });

      // Detect H2 RST cancellation from the remote peer (e.g. Broker abort)
      // and propagate as an 'error' event on the handler's request stream.
      // Note: lease stream emits 'end' (from pipe cleanup) BEFORE 'aborted',
      // so the PassThrough may have already ended normally by the time
      // we detect the RST. We emit 'error' directly instead of calling
      // destroy() because destroy() on an already-ended stream is a no-op.
      lease.stream.once('aborted', () => {
        if (completed || selfCancelled) return;
        const rst = lease.stream.rstCode;
        if (rst !== undefined && rst !== http2.constants.NGHTTP2_NO_ERROR) {
          const cancelError = createVerserError(
            'stream-failure',
            'Request stream was cancelled by the remote peer',
            {
              requestId: metadata.requestId,
              leaseId: lease.leaseId,
              rstCode: String(rst),
            },
          );
          localRequest.emit('error', cancelError);
        }
      });
      lease.stream.once('close', () => {
        complete();
      });

      try {
        listener(localRequest, localResponse);
      } catch (error) {
        const verserError = createVerserError('local-handler-failure', getErrorMessage(error), {
          guestId: this.options.guestId,
          requestId: metadata.requestId,
          path: metadata.path,
        });
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.error,
          requestId: metadata.requestId,
          error: verserError,
        });
        if (localResponse.headersStarted) {
          selfCancelled = true;
          lease.stream.close(http2.constants.NGHTTP2_CANCEL);
          resolve();
          return;
        }
        lease.stream.end(
          encodeVerserEnvelope({
            type: 'error',
            metadata: {
              requestId: metadata.requestId,
              code: verserError.code,
              message: verserError.message,
              context: verserError.context,
            },
          }),
        );
        resolve();
      }
    });
  }

  private closeLeaseStreams(): void {
    for (const lease of this.leaseStreams.values()) {
      lease.stream.close();
    }
    this.leaseStreams.clear();
  }

  private countLeases(state: GuestLeaseState): number {
    return [...this.leaseStreams.values()].filter((lease) => lease.state === state).length;
  }

  private normalizedMinWaitingStreams(): number {
    return Math.max(0, Math.floor(this.options.minWaitingStreams ?? 1));
  }

  private normalizedMaxOpenStreams(): number {
    return Math.max(0, Math.floor(this.options.maxOpenStreams ?? 16));
  }

  private getRoutedDomains(): readonly string[] {
    const domains: string[] = [];
    if (this.attachedDomain !== undefined) {
      domains.push(this.attachedDomain);
    }
    if (this.wsDomain !== undefined && !domains.includes(this.wsDomain)) {
      domains.push(this.wsDomain);
    }
    if (domains.length > 0) {
      return domains;
    }
    return this.options.routedDomains ?? [];
  }

  // ---------------------------------------------------------------------------
  // WebSocket lease streams
  // ---------------------------------------------------------------------------

  /**
   * Maintains one idle WebSocket lease stream when a WS handler is attached.
   */
  private maintainWsLeasePool(): void {
    if ((this.wsHandler === undefined && this.nativeWsHandler === undefined) || this.closing) {
      return;
    }
    const session = this.session;
    if (session === undefined || session.closed || session.destroyed) {
      return;
    }
    // Keep one spare lease while an accepted WebSocket occupies another
    // stream. The Host enforces the per-Guest idle cap.
    if (this.wsLeaseStreams.size < 4) {
      this.openWsLeaseStream(session);
    }
  }

  /**
   * Opens a WebSocket lease stream to `/verser/guest/websocket-lease`.
   */
  private openWsLeaseStream(session: http2.ClientHttp2Session): void {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/guest/websocket-lease',
      'x-verser-peer-id': this.options.guestId,
    });
    this.wsLeaseStreams.add(stream);

    stream.once('response', (headers) => {
      if (Number(headers[':status']) !== 200) {
        this.wsLeaseStreams.delete(stream);
        stream.close();
        return;
      }
      // Stream accepted — now read the VWS open frame
      this.maintainWsLeasePool();
      this.handleWsLeaseStream(stream).catch((error: unknown) => {
        if (this.closing) {
          return;
        }
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.error,
          error: toVerserError(error),
        });
        this.wsLeaseStreams.delete(stream);
        stream.close();
        this.maintainWsLeasePool();
      });
    });

    stream.on('close', () => {
      this.wsLeaseStreams.delete(stream);
      if (!this.closing) {
        this.maintainWsLeasePool();
      }
    });

    stream.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
  }

  /**
   * Reads the VWS/1 open frame from a WS lease stream, creates a
   * WebSocket, calls the handler to decide accept/reject, and sends
   * the appropriate response (accept or error).
   */
  private async handleWsLeaseStream(stream: http2.ClientHttp2Stream): Promise<void> {
    // Read one VWS line — the open frame (uses shared bounded parser, fix 5/6)
    const openLine = await readVwsLine(stream, VWS_MAX_FRAME_BYTES);
    const openFrame: Record<string, unknown> = JSON.parse(openLine);
    if (openFrame.type !== 'open') {
      throw createVerserError(
        'protocol-error',
        `Expected VWS open frame, got ${String(openFrame.type)}`,
      );
    }

    if (
      typeof openFrame.domain !== 'string' ||
      (openFrame.path !== undefined && typeof openFrame.path !== 'string') ||
      (openFrame.protocol !== undefined && typeof openFrame.protocol !== 'string')
    ) {
      throw createVerserError('protocol-error', 'Malformed VWS open frame');
    }
    const domain = openFrame.domain;
    const path = openFrame.path ?? '/';
    const requestedProtocol = openFrame.protocol ?? '';

    // Create the WebSocket (no accept sent yet)
    const ws = new VerserWebSocket(stream, requestedProtocol);

    // Call the handler to decide accept/reject
    const handler = this.wsHandler;
    const nativeHandler = this.nativeWsHandler;
    let nativeWs: NativeVerserWebSocket | undefined;
    let acceptResult: VerserWebSocketAcceptResult | undefined;
    if (nativeHandler !== undefined) {
      nativeWs = new NativeVerserWebSocket(ws, false);
      try {
        acceptResult =
          (await nativeHandler({ domain, path, protocol: requestedProtocol }, nativeWs)) ??
          undefined;
      } catch (error) {
        const failure = toVerserError(error);
        this.writeWebSocketError(stream, failure);
        stream.close();
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.error,
          error: toVerserError(error),
        });
        return;
      }
    } else if (handler !== undefined) {
      acceptResult =
        (await handler({ domain, path, protocol: requestedProtocol }, ws)) ?? undefined;
    }

    // Accept or reject based on handler decision
    if (acceptResult === false || acceptResult === null) {
      this.writeWebSocketError(
        stream,
        createVerserError('missing-guest', 'WebSocket endpoint is unavailable', {
          guestId: this.options.guestId,
          domain,
          path,
          status: 404,
        }),
      );
      stream.close();
      return;
    }

    // Accept
    const acceptProtocol =
      acceptResult !== undefined && typeof acceptResult === 'object' && 'protocol' in acceptResult
        ? (acceptResult as { protocol?: string }).protocol
        : requestedProtocol;
    if (acceptProtocol !== undefined && typeof acceptProtocol !== 'string') {
      throw createVerserError('protocol-error', 'Malformed WebSocket accept protocol');
    }
    if (
      acceptProtocol !== undefined &&
      acceptProtocol !== '' &&
      acceptProtocol !== requestedProtocol
    ) {
      throw createVerserError(
        'protocol-error',
        'Guest-selected WebSocket subprotocol was not offered by the Broker',
      );
    }
    acceptVerserWebSocket(ws, acceptProtocol);
    if (nativeWs !== undefined) markNativeVerserWebSocketOpen(nativeWs);
    this.maintainWsLeasePool();
  }

  private writeWebSocketError(
    stream: http2.ClientHttp2Stream,
    error: ReturnType<typeof toVerserError>,
  ): void {
    stream.write(
      `${JSON.stringify({
        type: 'error',
        code: error.code,
        message: error.message,
        context: error.context,
      })}\n`,
    );
  }

  /**
   * Closes all WebSocket lease streams.
   */
  private closeWsLeaseStreams(): void {
    for (const stream of this.wsLeaseStreams) {
      stream.close();
    }
    this.wsLeaseStreams.clear();
  }
}

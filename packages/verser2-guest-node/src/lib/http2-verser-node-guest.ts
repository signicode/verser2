import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import type { Readable } from 'node:stream';

import {
  VERSER_LIFECYCLE_EVENTS,
  createDevelopmentTlsCertificate,
  createGuestId,
  createRoutedRequestEnvelope,
  createVerserError,
  encodeVerserEnvelope,
  flattenVerserHeaders,
  getErrorMessage,
  readLeaseRequestMetadataFromStream,
  readNdjsonLines,
  validateVerserHeaders,
} from '@signicode/verser-common';
import { toVerserError } from './error-utils';
import { requestJson } from './http2-client-utils';
import { MinimalIncomingMessage, MinimalServerResponse } from './minimal-http';
import type {
  NodeRequestListener,
  VerserNodeGuest,
  VerserNodeGuestDispatchRequest,
  VerserNodeGuestDispatchResponse,
  VerserNodeGuestLifecycleEvent,
  VerserNodeGuestOptions,
} from './types';

type GuestLeaseState = 'opening' | 'waiting' | 'active';

interface GuestLeaseStream {
  readonly leaseId: string;
  readonly stream: http2.ClientHttp2Stream;
  state: GuestLeaseState;
}

export class Http2VerserNodeGuest implements VerserNodeGuest {
  private readonly options: VerserNodeGuestOptions;

  private readonly lifecycle = new EventEmitter();

  private session?: http2.ClientHttp2Session;

  private controlStream?: http2.ClientHttp2Stream;

  private readonly leaseStreams = new Map<string, GuestLeaseStream>();

  private leaseCounter = 0;

  private closing = false;

  private listener?: NodeRequestListener;

  private attachedDomain?: string;

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

    const certificate = createDevelopmentTlsCertificate();
    const session = http2.connect(this.options.hostUrl, { ca: certificate.cert });
    this.session = session;
    this.closing = false;

    session.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
    session.on('close', () => {
      this.session = undefined;
      this.leaseStreams.clear();
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.disconnected });
    });

    await once(session, 'connect');
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected });
    await this.register();
    this.openControlStream(session);
    this.maintainLeasePool();
  }

  public async close(reason = 'guest-close'): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }

    this.closing = true;
    this.controlStream?.close();
    this.closeLeaseStreams();
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
    const localResponse = new MinimalServerResponse();

    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.requestStarted,
      requestId: envelope.requestId,
    });

    return new Promise((resolve, reject) => {
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
    readNdjsonLines<unknown>(stream, () => {
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
    metadata: import('@signicode/verser-common').VerserRequestEnvelopeMetadata,
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
      localResponse.once('finish', () => {
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
          requestId: metadata.requestId,
        });
        resolve();
      });
      localResponse.once('error', reject);
      lease.stream.once('close', resolve);

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
    if (this.attachedDomain !== undefined) {
      return [this.attachedDomain];
    }

    return this.options.routedDomains ?? [];
  }
}

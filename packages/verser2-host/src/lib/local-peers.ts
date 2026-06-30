import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { PassThrough, Readable } from 'node:stream';

import {
  type RoutedDomainRegistration,
  type VerserPeerId,
  createRoutedResponseEnvelope,
  createVerserError,
  flattenVerserHeaders,
  sanitizeHttp2ResponseHeaders,
  validateVerserHeaders,
} from '@signicode/verser-common';
import type {
  VerserLocalBrokerRequest,
  VerserLocalBrokerResponse,
  VerserLocalGuestOptions,
  VerserLocalGuestRequestListener,
} from './types';

export interface LocalGuestState {
  readonly listener: VerserLocalGuestRequestListener;
}

export interface LocalBrokerState {
  routes: RoutedDomainRegistration[];
  routeWaiters: Map<string, LocalRouteWaiter[]>;
  requestCounter: number;
  closed: boolean;
  routeChangeEmitter: EventEmitter;
}

interface LocalRouteWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface LocalDispatchRequest {
  readonly requestId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Readable;
  readonly leaseAcquireTimeoutMs: number;
  readonly signal?: AbortSignal;
}

type LocalRequest = Readable & {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
};

class LocalIncomingMessage extends PassThrough implements LocalRequest {
  public readonly method: string;

  public readonly url: string;

  public readonly headers: Record<string, string>;

  public constructor(request: LocalDispatchRequest) {
    super();
    this.method = request.method;
    this.url = request.path;
    this.headers = request.headers;
    this.on('error', () => {
      // The dispatch promise installs its own error listener while the response
      // is pending. Keep a fallback listener so cancellation after response
      // headers does not surface as an unhandled stream error.
    });
    const onAbort = (): void => {
      this.destroy(createDisconnectedError(request));
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    this.once('close', () => request.signal?.removeEventListener('abort', onAbort));
    request.body.once('error', (error) => this.destroy(error));
    request.body.pipe(this);
  }
}

class LocalServerResponse extends EventEmitter {
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly bodyStream = new PassThrough();

  private started = false;

  public get headersStarted(): boolean {
    return this.started;
  }

  public setHeader(name: string, value: string | number | boolean): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  public getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  public writeHead(
    statusCode: number,
    headers: Record<string, string | number | boolean> = {},
  ): this {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
    return this;
  }

  public write(chunk: string | Buffer, encoding: BufferEncoding = 'utf8'): boolean {
    this.start();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    return this.bodyStream.write(buffer);
  }

  public flushHeaders(): void {
    this.start();
  }

  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    } else {
      this.start();
    }
    this.bodyStream.end();
    this.emit('finish');
    return this;
  }

  public toBrokerResponse(requestId: string): VerserLocalBrokerResponse {
    const sanitizedHeaders = sanitizeHttp2ResponseHeaders(Object.fromEntries(this.headers));
    const envelope = createRoutedResponseEnvelope({
      requestId,
      statusCode: this.statusCode,
      headers: flattenVerserHeaders(validateVerserHeaders(sanitizedHeaders)),
    });
    return {
      requestId: envelope.requestId,
      statusCode: envelope.statusCode,
      headers: envelope.headers,
      body: this.bodyStream,
    };
  }

  public fail(error: Error): void {
    this.bodyStream.destroy(error);
    this.emit('error', error);
  }

  private start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.emit('response');
  }
}

export function createLocalBrokerState(routes: RoutedDomainRegistration[]): LocalBrokerState {
  return {
    routes,
    routeWaiters: new Map(),
    requestCounter: 0,
    closed: false,
    routeChangeEmitter: new EventEmitter(),
  };
}

export function updateLocalBrokerRoutes(
  broker: LocalBrokerState,
  routes: RoutedDomainRegistration[],
): void {
  if (broker.closed) {
    return;
  }
  broker.routes = [...routes];
  for (const route of routes) {
    for (const waiter of broker.routeWaiters.get(route.domain) ?? []) {
      waiter.resolve();
    }
    broker.routeWaiters.delete(route.domain);
  }
}

export function waitForLocalBrokerRoute(broker: LocalBrokerState, domain: string): Promise<void> {
  if (broker.closed) {
    return Promise.reject(createVerserError('disconnected-target', 'Local Broker is closed'));
  }
  if (broker.routes.some((route) => route.domain === domain)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    broker.routeWaiters.set(domain, [
      ...(broker.routeWaiters.get(domain) ?? []),
      { resolve, reject },
    ]);
  });
}

export function closeLocalBrokerState(broker: LocalBrokerState, reason: string): void {
  if (broker.closed) {
    return;
  }
  broker.closed = true;
  broker.routes = [];
  broker.routeChangeEmitter.removeAllListeners();
  const error = createVerserError('disconnected-target', 'Local Broker is closed', { reason });
  for (const waiters of broker.routeWaiters.values()) {
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
  broker.routeWaiters.clear();
}

/**
 * Emits a route lifecycle event on a local Broker's change emitter.
 *
 * Updates the Broker's route snapshot before emitting the event, so the
 * listener sees the current route state. Supports 'added', 'removed',
 * 'degraded', and 'changed' event types.
 *
 * @param broker - The local Broker state.
 * @param event - The route lifecycle event to emit.
 */
export function emitLocalBrokerRouteChange(
  broker: LocalBrokerState,
  event: {
    readonly type: string;
    readonly targetId: string;
    readonly domain: string;
    readonly reason?: string;
  },
): void {
  if (broker.closed) {
    return;
  }

  // Update the route snapshot based on the event type before emitting.
  if (event.type === 'added' || event.type === 'changed') {
    const existingIndex = broker.routes.findIndex(
      (r) => r.targetId === event.targetId && r.domain === event.domain,
    );
    if (existingIndex >= 0) {
      broker.routes[existingIndex] = { targetId: event.targetId, domain: event.domain };
    } else {
      broker.routes.push({ targetId: event.targetId, domain: event.domain });
    }
    // Resolve any waiters for this domain
    for (const waiter of broker.routeWaiters.get(event.domain) ?? []) {
      waiter.resolve();
    }
    broker.routeWaiters.delete(event.domain);
  } else if (event.type === 'removed') {
    broker.routes = broker.routes.filter(
      (r) => !(r.targetId === event.targetId && r.domain === event.domain),
    );
  } else if (event.type === 'degraded') {
    // Degraded routes remain in the snapshot but are marked as degraded.
    // Add if not already present.
    const existingIndex = broker.routes.findIndex(
      (r) => r.targetId === event.targetId && r.domain === event.domain,
    );
    if (existingIndex < 0) {
      broker.routes.push({ targetId: event.targetId, domain: event.domain });
    }
  }

  broker.routeChangeEmitter.emit('route-change', event);
}

export function toReadableBody(body: VerserLocalBrokerRequest['body']): Readable {
  if (body === undefined) {
    return Readable.from([]);
  }
  if (body instanceof Readable) {
    return body;
  }
  return Readable.from(body);
}

export function extractLocalGuestListener(
  peerId: VerserPeerId,
  serverOrListener: VerserLocalGuestOptions['listener'],
): VerserLocalGuestRequestListener {
  if (serverOrListener instanceof http.Server) {
    const listener = serverOrListener.listeners('request')[0];
    if (listener === undefined) {
      throw createVerserError(
        'local-handler-failure',
        'Attached HTTP server has no request listener',
        {
          guestId: peerId,
        },
      );
    }
    return listener as unknown as VerserLocalGuestRequestListener;
  }

  return serverOrListener;
}

export function dispatchLocalGuestRequest(
  request: LocalDispatchRequest,
  listener: VerserLocalGuestRequestListener,
): Promise<VerserLocalBrokerResponse> {
  const localRequest = new LocalIncomingMessage(request);
  const localResponse = new LocalServerResponse();
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectBeforeResponse = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveResponse = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(localResponse.toBrokerResponse(request.requestId));
    };
    const failBeforeResponse = (error: unknown): void => {
      rejectBeforeResponse(createLocalHandlerError(request, error));
    };
    const failRequestStream = (error: unknown): void => {
      const streamError = createVerserError('stream-failure', getErrorMessage(error), {
        requestId: request.requestId,
        targetId: request.targetId,
      });
      if (localResponse.headersStarted) {
        localResponse.fail(streamError);
        return;
      }
      rejectBeforeResponse(streamError);
    };
    const abort = (): void => {
      const error = createDisconnectedError(request);
      localRequest.destroy(error);
      if (localResponse.headersStarted) {
        localResponse.fail(error);
        return;
      }
      rejectBeforeResponse(error);
    };
    const cleanup = (): void => {
      localRequest.off('error', failRequestStream);
      request.signal?.removeEventListener('abort', abort);
    };

    localRequest.once('error', failRequestStream);
    if (request.signal?.aborted) {
      abort();
      return;
    }
    request.signal?.addEventListener('abort', abort, { once: true });
    localResponse.once('response', resolveResponse);
    localResponse.once('error', (error) => {
      if (!localResponse.headersStarted) {
        failBeforeResponse(error);
      }
    });

    try {
      listener(localRequest, localResponse);
    } catch (error) {
      const verserError = createLocalHandlerError(request, error);
      if (localResponse.headersStarted) {
        localResponse.fail(verserError);
        resolveResponse();
        return;
      }
      rejectBeforeResponse(verserError);
    }
  });
}

function createDisconnectedError(request: LocalDispatchRequest): Error {
  return createVerserError('disconnected-target', 'Local peer disconnected during request', {
    requestId: request.requestId,
    targetId: request.targetId,
    sourceId: request.sourceId,
  });
}

function createLocalHandlerError(request: LocalDispatchRequest, error: unknown): Error {
  return createVerserError('local-handler-failure', getErrorMessage(error), {
    targetId: request.targetId,
    requestId: request.requestId,
    path: request.path,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

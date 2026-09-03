import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import * as http2 from 'node:http2';
import { PassThrough, Readable } from 'node:stream';

import {
  type RoutedDomainRegistration,
  VerserError,
  type VerserHeaderPair,
  type VerserPeerId,
  type VerserSerializedHeaderMap,
  createRoutedResponseEnvelope,
  createVerserError,
  requireFinalResponseStatusCode,
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
  readonly routeDomain?: string;
  readonly method: string;
  readonly path: string;
  readonly headers: VerserSerializedHeaderMap;
  readonly body: Readable;
  readonly leaseAcquireTimeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * Hop-local previous-hop domain for requests arriving through a federation
   * link (the incoming resolved route/open domain). Present only in a
   * federation context; an empty string marks a federated request that
   * arrived without a hop-domain baton, which the route authorizer denies.
   * Broker-originated requests resolve the hop domain from the Broker's
   * persisted registration instead.
   */
  readonly previousHopDomain?: string;
}

type LocalRequest = Readable & {
  readonly method: string;
  readonly url: string;
  readonly headers: VerserSerializedHeaderMap;
};

class LocalIncomingMessage extends PassThrough implements LocalRequest {
  private onAbortListener?: () => void;
  public readonly method: string;

  public readonly url: string;

  public readonly headers: VerserSerializedHeaderMap;

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
      const error = createRequestAbortError(request);
      // A federated request can be cancelled after the request pipe has
      // already ended while the Guest handler is still running.  destroy()
      // is then a no-op; explicitly deliver the structured error so the
      // handler observes the cancellation without creating an unhandled error.
      if (this.readableEnded || this.destroyed) {
        this.emit('error', error);
      } else {
        this.destroy(error);
      }
    };
    this.onAbortListener = onAbort;
    request.signal?.addEventListener('abort', onAbort, { once: true });
    request.body.once('error', (error) => {
      this.destroy(
        request.signal?.aborted || isHttp2CancelError(error)
          ? createRequestAbortError(request)
          : error,
      );
    });
    request.body.pipe(this);
  }

  public disposeAbortListener(request: LocalDispatchRequest): void {
    if (this.onAbortListener !== undefined) {
      request.signal?.removeEventListener('abort', this.onAbortListener);
      this.onAbortListener = undefined;
    }
  }
}

class LocalServerResponse extends EventEmitter {
  public statusCode = 200;

  public statusMessage?: string;

  private readonly headers = new Map<string, string | string[]>();

  /** Exact response-header emission order, including interleaved duplicate names. */
  private readonly headerPairs: VerserHeaderPair[] = [];

  private readonly bodyStream = new PassThrough();

  private started = false;

  private commitFailed = false;

  private canonicalResponse?: Omit<VerserLocalBrokerResponse, 'body'>;

  public constructor(private readonly requestId: string) {
    super({ captureRejections: true });
  }

  public get headersStarted(): boolean {
    return this.started;
  }

  public setHeader(name: string, value: ResponseHeaderValue): this {
    const [normalizedName, normalizedValue] = normalizeResponseHeader(name, value);
    this.headers.set(normalizedName, normalizedValue);
    this.removeHeaderPairs(normalizedName);
    this.headerPairs.push(
      ...(Array.isArray(normalizedValue) ? normalizedValue : [normalizedValue]).map(
        (item): VerserHeaderPair => [normalizedName, item],
      ),
    );
    this.canonicalResponse = undefined;
    return this;
  }

  public getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  public appendHeader(name: string, value: ResponseHeaderValue): this {
    const [normalizedName, values] = normalizeResponseHeaderValues(name, value);
    const existing = this.getHeader(normalizedName);
    this.headers.set(
      normalizedName,
      existing === undefined
        ? values.length === 1
          ? values[0]
          : values
        : [...(Array.isArray(existing) ? existing : [existing]), ...values],
    );
    this.headerPairs.push(...values.map((item): VerserHeaderPair => [normalizedName, item]));
    this.canonicalResponse = undefined;
    return this;
  }

  public writeHead(statusCode: number, headers?: ResponseHeaders): this;
  public writeHead(statusCode: number, statusMessage: undefined, headers: ResponseHeaders): this;
  public writeHead(statusCode: number, statusMessage?: string, headers?: ResponseHeaders): this;
  public writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | ResponseHeaders,
    headers?: ResponseHeaders,
  ): this {
    const responseHeaders =
      typeof statusMessageOrHeaders === 'string'
        ? (headers ?? {})
        : (headers ?? statusMessageOrHeaders ?? {});
    requireFinalResponseStatusCode(statusCode);
    if (typeof statusMessageOrHeaders === 'string')
      validateHeaderValue('statusMessage', statusMessageOrHeaders);
    const nextHeaders = new Map(this.headers);
    const nextPairs = [...this.headerPairs];
    if (Array.isArray(responseHeaders)) {
      const replaced = new Set<string>();
      for (const [name, value] of responseHeaders) {
        const [normalizedName, normalizedValue] = normalizeResponseHeader(name, value);
        if (replaced.has(normalizedName)) {
          appendResponseHeader(nextHeaders, nextPairs, normalizedName, normalizedValue);
        } else {
          setResponseHeader(nextHeaders, nextPairs, normalizedName, normalizedValue);
          replaced.add(normalizedName);
        }
      }
    } else {
      for (const [name, value] of Object.entries(responseHeaders)) {
        const [normalizedName, normalizedValue] = normalizeResponseHeader(name, value);
        setResponseHeader(nextHeaders, nextPairs, normalizedName, normalizedValue);
      }
    }
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders;
    this.headers.clear();
    for (const [name, value] of nextHeaders) this.headers.set(name, value);
    this.headerPairs.splice(0, this.headerPairs.length, ...nextPairs);
    this.canonicalResponse = undefined;
    return this;
  }

  public write(chunk: string | Buffer, encoding: BufferEncoding = 'utf8'): boolean {
    if (!this.commitResponse()) return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    return this.bodyStream.write(buffer);
  }

  public flushHeaders(): void {
    this.commitResponse();
  }

  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (this.commitFailed) return this;
    if (chunk !== undefined) {
      this.write(chunk, encoding);
      if (this.commitFailed) return this;
    } else if (!this.commitResponse()) {
      return this;
    }
    this.bodyStream.end();
    this.emit('finish');
    return this;
  }

  public toBrokerResponse(requestId: string): VerserLocalBrokerResponse {
    const envelope = this.canonicalResponse ?? this.createCanonicalResponse(requestId);
    return {
      requestId: envelope.requestId,
      statusCode: envelope.statusCode,
      headers: envelope.headers,
      ...(envelope.statusText === undefined ? {} : { statusText: envelope.statusText }),
      ...(envelope.headerPairs === undefined ? {} : { headerPairs: envelope.headerPairs }),
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
    this.createCanonicalResponse(this.requestId);
    this.started = true;
    this.emit('response');
  }

  private commitResponse(): boolean {
    if (this.commitFailed) return false;
    try {
      this.start();
      return true;
    } catch (error) {
      this.commitFailed = true;
      this.emit('error', error);
      return false;
    }
  }

  private createCanonicalResponse(requestId: string): Omit<VerserLocalBrokerResponse, 'body'> {
    if (this.statusMessage !== undefined) validateHeaderValue('statusMessage', this.statusMessage);
    const envelope = createRoutedResponseEnvelope({
      requestId,
      statusCode: this.statusCode,
      headers: {},
      ...(this.statusMessage === undefined ? {} : { statusText: this.statusMessage }),
      headerPairs: this.toHeaderPairs(),
    });
    this.canonicalResponse = envelope;
    return envelope;
  }

  private toHeaderPairs(): VerserHeaderPair[] {
    return [...this.headerPairs];
  }

  private removeHeaderPairs(name: string): void {
    for (let index = this.headerPairs.length - 1; index >= 0; index -= 1) {
      if (this.headerPairs[index][0] === name) {
        this.headerPairs.splice(index, 1);
      }
    }
  }
}

type ResponseHeaderValue = string | number | boolean | readonly (string | number | boolean)[];
type ResponseHeaders =
  | Record<string, ResponseHeaderValue>
  | readonly (readonly [string, ResponseHeaderValue])[];

export function createLocalBrokerState(routes: RoutedDomainRegistration[]): LocalBrokerState {
  const routeChangeEmitter = new EventEmitter({ captureRejections: true });
  routeChangeEmitter.on('error', () => {
    // Route-change listeners are observational; rejected async listeners must
    // not destabilize local routing state updates.
  });
  return {
    routes,
    routeWaiters: new Map(),
    requestCounter: 0,
    closed: false,
    routeChangeEmitter,
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
  broker.routeChangeEmitter.removeAllListeners('route-change');
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
  const localResponse = new LocalServerResponse(request.requestId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectBeforeResponse = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      localRequest.disposeAbortListener(request);
      reject(error);
    };
    const resolveResponse = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const brokerResponse = localResponse.toBrokerResponse(request.requestId);
      const dispose = (): void => localRequest.disposeAbortListener(request);
      brokerResponse.body.once('end', dispose);
      brokerResponse.body.once('close', dispose);
      brokerResponse.body.once('error', dispose);
      resolve(brokerResponse);
    };
    const failBeforeResponse = (error: unknown): void => {
      rejectBeforeResponse(createLocalHandlerError(request, error));
    };
    const failRequestStream = (error: unknown): void => {
      // Preserve VerserError instances so H2 cancel/disconnected-target errors
      // are not swallowed by the generic stream-failure wrapper.
      const streamError =
        error instanceof VerserError
          ? error
          : createVerserError('stream-failure', getErrorMessage(error), {
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
      // Use the signal reason when available (set by controller.abort(reason)
      // in the federation boundary), so structured errors like stream-failure
      // propagate through dispatch rejection paths. Fall back to the default
      // disconnected error for direct (non-federated) abort paths.
      const error = createRequestAbortError(request);
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

function createRequestAbortError(request: LocalDispatchRequest): Error {
  const reason = request.signal?.reason;
  if (reason instanceof VerserError && reason.code === 'stream-failure') {
    return reason;
  }
  return createDisconnectedError(request);
}

function isHttp2CancelError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown };
  const code = err.code;

  // Numeric H2 error codes (NGHTTP2_CANCEL, NGHTTP2_REFUSED_STREAM)
  if (
    code === http2.constants.NGHTTP2_CANCEL ||
    code === http2.constants.NGHTTP2_REFUSED_STREAM ||
    code === 20
  ) {
    return true;
  }

  // String error code emitted by Node.js http2 module
  if (code === 'ERR_HTTP2_STREAM_ERROR') {
    return true;
  }

  return false;
}

function createLocalHandlerError(request: LocalDispatchRequest, error: unknown): Error {
  if (error instanceof VerserError && error.code === 'protocol-error') {
    return error;
  }
  return createVerserError('local-handler-failure', getErrorMessage(error), {
    targetId: request.targetId,
    requestId: request.requestId,
    path: request.path,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeResponseHeader(
  name: string,
  value: ResponseHeaderValue,
): [string, string | string[]] {
  const [normalizedName, values] = normalizeResponseHeaderValues(name, value);
  return [normalizedName, Array.isArray(value) ? values : values[0]];
}

function normalizeResponseHeaderValues(
  name: string,
  value: ResponseHeaderValue,
): [string, string[]] {
  validateHeaderName(name);
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  for (const item of values) validateHeaderValue(name, item);
  return [name.toLowerCase(), values];
}

function setResponseHeader(
  headers: Map<string, string | string[]>,
  pairs: VerserHeaderPair[],
  name: string,
  value: string | string[],
): void {
  headers.set(name, value);
  removeResponseHeaderPairs(pairs, name);
  pairs.push(
    ...(Array.isArray(value) ? value : [value]).map((item): VerserHeaderPair => [name, item]),
  );
}

function appendResponseHeader(
  headers: Map<string, string | string[]>,
  pairs: VerserHeaderPair[],
  name: string,
  value: string | string[],
): void {
  const values = Array.isArray(value) ? value : [value];
  const existing = headers.get(name);
  headers.set(
    name,
    existing === undefined
      ? values.length === 1
        ? values[0]
        : values
      : [...(Array.isArray(existing) ? existing : [existing]), ...values],
  );
  pairs.push(...values.map((item): VerserHeaderPair => [name, item]));
}

function removeResponseHeaderPairs(pairs: VerserHeaderPair[], name: string): void {
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    if (pairs[index][0] === name) pairs.splice(index, 1);
  }
}

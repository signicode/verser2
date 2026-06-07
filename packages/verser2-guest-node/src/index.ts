import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { buffer as readStreamBuffer, text as readStreamText } from 'node:stream/consumers';

import {
  type RoutedRequestEnvelope,
  type RoutedResponseEnvelope,
  VERSER_LIFECYCLE_EVENTS,
  type VerserError,
  type VerserErrorCode,
  type VerserRequestEnvelopeMetadata,
  createDevelopmentTlsCertificate,
  createGuestId,
  createRoutedRequestEnvelope,
  createRoutedResponseEnvelope,
  createVerserError,
  encodeVerserEnvelope,
  readLeaseRequestMetadataFromStream,
  readNdjsonLines,
} from '@signicode/verser-common';

export const VERSER2_GUEST_NODE_PACKAGE_NAME = '@signicode/verser2-guest-node';

export interface VerserNodeGuestOptions {
  readonly hostUrl: string;
  readonly guestId: string;
  readonly routedDomains?: readonly string[];
  readonly minWaitingStreams?: number;
  readonly maxOpenStreams?: number;
  readonly leaseAcquireTimeoutMs?: number;
  readonly maxMetadataBytes?: number;
}

export interface VerserNodeGuestLifecycleEvent {
  readonly name: string;
  readonly guestId: string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly error?: VerserError;
}

export interface VerserNodeGuestDispatchRequest extends RoutedRequestEnvelope {
  readonly body: readonly (string | Buffer)[];
}

export interface VerserNodeGuestDispatchResponse extends RoutedResponseEnvelope {
  readonly body: Buffer;
}

export interface VerserBrokerOptions {
  readonly hostUrl: string;
  readonly brokerId: string;
}

export interface VerserBrokerRequest {
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: readonly Buffer[] | Readable;
}

export interface VerserBrokerResponse extends RoutedResponseEnvelope {
  readonly body: Readable;
}

export interface VerserBroker {
  readonly sessionCount: number;
  readonly routedRequestCount: number;
  connect(): Promise<void>;
  close(reason?: string): Promise<void>;
  createAgent(): http.Agent;
  getRoutes(): { targetId: string; domain: string }[];
  waitForRoute(domain: string): Promise<void>;
  request(request: VerserBrokerRequest): Promise<VerserBrokerResponse>;
}

export interface VerserNodeGuest {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(reason?: string): Promise<void>;
  attach(serverOrListener: http.Server | NodeRequestListener, domain?: string): this;
  dispatchRoutedRequest(
    request: VerserNodeGuestDispatchRequest,
  ): Promise<VerserNodeGuestDispatchResponse>;
  onLifecycle(listener: (event: VerserNodeGuestLifecycleEvent) => void): () => void;
}

export type NodeRequestListener = (
  request: MinimalIncomingMessage,
  response: MinimalServerResponse,
) => void;

type GuestLeaseState = 'opening' | 'waiting' | 'active';

interface GuestLeaseStream {
  readonly leaseId: string;
  readonly stream: http2.ClientHttp2Stream;
  state: GuestLeaseState;
}

export function createVerserNodeGuest(options: VerserNodeGuestOptions): VerserNodeGuest {
  return new Http2VerserNodeGuest(options);
}

export function createVerserBroker(options: VerserBrokerOptions): VerserBroker {
  return new Http2VerserBroker(options);
}

export class MinimalIncomingMessage extends PassThrough {
  public readonly method: string;

  public readonly url: string;

  public readonly headers: Record<string, string>;

  public constructor(request: VerserNodeGuestDispatchRequest, source?: Readable) {
    super();
    this.method = request.method;
    this.url = request.path;
    this.headers = request.headers;

    const bodySource = source ?? Readable.from(request.body);
    bodySource.once('error', (error) => this.destroy(error));
    bodySource.pipe(this);
  }
}

export class MinimalServerResponse extends EventEmitter {
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly chunks: Buffer[] = [];

  private readonly requestId?: string;

  private readonly output?: http2.ClientHttp2Stream;

  private responseStarted = false;

  public constructor(requestId?: string, output?: http2.ClientHttp2Stream) {
    super();
    this.requestId = requestId;
    this.output = output;
    output?.on('drain', () => this.emit('drain'));
    output?.on('error', (error) => this.emit('error', error));
  }

  public get headersStarted(): boolean {
    return this.responseStarted;
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
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.output === undefined) {
      this.chunks.push(buffer);
      return true;
    }

    this.startStreamingResponse();
    return this.output.write(buffer);
  }

  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    } else if (this.output !== undefined) {
      this.startStreamingResponse();
    }
    this.output?.end();
    this.emit('finish');
    return this;
  }

  public toDispatchResponse(requestId: string): VerserNodeGuestDispatchResponse {
    return {
      ...createRoutedResponseEnvelope({
        requestId,
        statusCode: this.statusCode,
        headers: Object.fromEntries(this.headers),
      }),
      body: Buffer.concat(this.chunks),
    };
  }

  private startStreamingResponse(): void {
    const output = this.output;
    if (output === undefined || this.responseStarted) {
      return;
    }
    this.responseStarted = true;
    output.write(
      encodeVerserEnvelope({
        type: 'response',
        metadata: {
          requestId: this.requestId ?? '',
          statusCode: this.statusCode,
          headers: Object.fromEntries(this.headers),
        },
      }),
    );
  }
}

class Http2VerserNodeGuest implements VerserNodeGuest {
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
    if (listener === undefined) {
      return Promise.reject(
        createVerserError('local-handler-failure', 'No local HTTP handler is attached', {
          guestId: this.options.guestId,
          requestId: request.requestId,
        }),
      );
    }

    const envelope = createRoutedRequestEnvelope(request);
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
      // Guest control stream body routing was removed; keep the stream open for coordination.
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

    stream.once('response', (headers) => {
      if (Number(headers[':status']) === 200) {
        lease.state = 'waiting';
        this.maintainLeasePool();
        return;
      }

      stream.close();
    });
    stream.on('close', () => {
      this.leaseStreams.delete(leaseId);
      if (!this.closing) {
        this.maintainLeasePool();
      }
    });
    stream.on('error', (error) => {
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
    metadata: VerserRequestEnvelopeMetadata,
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

    const request: VerserNodeGuestDispatchRequest = {
      requestId: metadata.requestId,
      sourceId: metadata.sourceId,
      targetId: metadata.targetId,
      method: metadata.method,
      path: metadata.path,
      headers: flattenHeaders(metadata.headers),
      body: [],
    };
    const localRequest = new MinimalIncomingMessage(request, lease.stream);
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

class Http2VerserBroker implements VerserBroker {
  private readonly options: VerserBrokerOptions;

  private session?: http2.ClientHttp2Session;

  private controlStream?: http2.ClientHttp2Stream;

  private routes: { targetId: string; domain: string }[] = [];

  private routeWaiters = new Map<string, (() => void)[]>();

  private requestCounter = 0;

  public constructor(options: VerserBrokerOptions) {
    this.options = options;
  }

  public get sessionCount(): number {
    return this.session === undefined ? 0 : 1;
  }

  public get routedRequestCount(): number {
    return this.requestCounter;
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined && !this.session.closed) {
      return;
    }
    const certificate = createDevelopmentTlsCertificate();
    const session = http2.connect(this.options.hostUrl, { ca: certificate.cert });
    this.session = session;
    await once(session, 'connect');
    await this.register(session);
  }

  public async close(_reason = 'broker-close'): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    this.controlStream?.close();
    session.close();
    await once(session, 'close');
    this.session = undefined;
  }

  public getRoutes(): { targetId: string; domain: string }[] {
    return [...this.routes];
  }

  public createAgent(): http.Agent {
    return new VerserBrokerAgent(this);
  }

  public waitForRoute(domain: string): Promise<void> {
    if (this.routes.some((route) => route.domain === domain)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.routeWaiters.set(domain, [...(this.routeWaiters.get(domain) ?? []), resolve]);
    });
  }

  public request(request: VerserBrokerRequest): Promise<VerserBrokerResponse> {
    const session = this.session;
    if (session === undefined) {
      return Promise.reject(createVerserError('disconnected-target', 'Broker is not connected'));
    }

    const requestId = `${this.options.brokerId}-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const stream = session.request({
        ':method': 'POST',
        ':path': '/verser/request',
        'x-verser-request-id': requestId,
        'x-verser-source-id': this.options.brokerId,
        'x-verser-target-id': request.targetId,
        'x-verser-method': request.method,
        'x-verser-path': request.path,
        'x-verser-headers': JSON.stringify(request.headers ?? {}),
      });
      let statusCode = 200;
      let responseHeaders: Record<string, string> = {};
      stream.on('response', (headers) => {
        statusCode = Number(headers[':status'] ?? 200);
        responseHeaders = normalHeaders(headers);
        if (statusCode < 400) {
          resolve({ requestId, statusCode, headers: responseHeaders, body: stream });
          return;
        }
        readResponseBody(stream).then(
          (body) => reject(errorFromBody(body, request.targetId)),
          reject,
        );
      });
      stream.on('error', reject);
      stream.on('end', () => {
        if (statusCode >= 400) {
          return;
        }
      });
      if (request.body instanceof Readable) {
        request.body.once('error', reject);
        request.body.pipe(stream);
        return;
      }
      for (const chunk of request.body ?? []) {
        stream.write(chunk);
      }
      stream.end();
    });
  }

  private async register(session: http2.ClientHttp2Session): Promise<void> {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    this.controlStream = stream;
    readNdjsonLines<BrokerControlFrame>(stream, (frame) => this.handleControlFrame(frame));
    stream.end(JSON.stringify({ peerId: this.options.brokerId, role: 'broker' }));
    await this.waitForRegistration();
  }

  private waitForRegistration(): Promise<void> {
    return new Promise((resolve) => {
      const unregister = this.waitForFrame(() => {
        unregister();
        resolve();
      });
    });
  }

  private waitForFrame(listener: () => void): () => void {
    this.frameEmitter.on('frame', listener);
    return () => this.frameEmitter.off('frame', listener);
  }

  private handleControlFrame(frame: BrokerControlFrame): void {
    if ('routes' in frame) {
      this.routes = frame.routes;
      for (const route of this.routes) {
        for (const resolve of this.routeWaiters.get(route.domain) ?? []) {
          resolve();
        }
        this.routeWaiters.delete(route.domain);
      }
    }
    this.frameEmitter.emit('frame');
  }

  private readonly frameEmitter = new EventEmitter();
}

class VerserBrokerAgent extends http.Agent {
  public readonly protocol = 'http:';

  private readonly broker: Http2VerserBroker;

  public constructor(broker: Http2VerserBroker) {
    super({ keepAlive: false });
    this.broker = broker;
  }

  public addRequest(request: http.ClientRequest, options: http.RequestOptions): void {
    const hostname = String(options.hostname ?? options.host ?? '');
    const route = this.broker.getRoutes().find((candidate) => candidate.domain === hostname);
    if (route === undefined) {
      process.nextTick(() => {
        const error = new Error(`No Verser route advertised for host ${hostname}`);
        request.emit('error', error);
        request.destroy(error);
      });
      return;
    }

    const socket = new VerserBrokerSocket(this.broker, route.targetId, options);
    request.onSocket(socket as unknown as never);
    request.once('finish', () => {
      socket.forwardRequestOnce();
    });
  }
}

class VerserBrokerSocket extends Duplex {
  public override writable = true;

  public override readable = true;

  public connecting = false;

  private readonly broker: Http2VerserBroker;

  private readonly targetId: string;

  private readonly options: http.RequestOptions;

  private requestBuffer = Buffer.alloc(0);

  private bodyStream?: PassThrough;

  private chunkDecoder?: ChunkedBodyDecoder;

  private expectedBodyBytes = 0;

  private receivedBodyBytes = 0;

  private forwardingStarted = false;

  public constructor(broker: Http2VerserBroker, targetId: string, options: http.RequestOptions) {
    super();
    this.broker = broker;
    this.targetId = targetId;
    this.options = options;
    process.nextTick(() => this.emit('connect'));
  }

  public override _read(): void {
    // Response bytes are pushed after the Broker response is available.
  }

  public override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.consumeRequestBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  public override _final(callback: () => void): void {
    this.bodyStream?.end();
    callback();
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.bodyStream?.end();
    callback(error);
  }

  public setTimeout(_timeout: number, callback?: () => void): this {
    if (callback !== undefined) {
      this.once('timeout', callback);
    }
    return this;
  }

  public setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  public setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }

  public forwardRequestOnce(): void {
    if (this.forwardingStarted) {
      return;
    }
    this.forwardingStarted = true;
    this.forwardRequest().catch((error: unknown) => {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async forwardRequest(): Promise<void> {
    const bodyStream = this.bodyStream ?? new PassThrough();
    this.bodyStream = bodyStream;
    const requestHeaders = this.options.headers;
    const response = await this.broker.request({
      targetId: this.targetId,
      method: String(this.options.method ?? 'GET'),
      path: String(this.options.path ?? '/'),
      headers: normalizeRequestHeaders(
        Array.isArray(requestHeaders)
          ? undefined
          : (requestHeaders as http.OutgoingHttpHeaders | undefined),
      ),
      body: bodyStream,
    });
    this.push(serializeHttpResponseHead(response));
    response.body.pipe(this.createResponseSink());
    response.body.on('error', (error) => this.destroy(error));
  }

  private createResponseSink(): Writable {
    return new Writable({
      write: (chunk: Buffer | string, encoding, callback): void => {
        this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
      },
      final: (callback): void => {
        this.bodyStream?.end();
        this.push(null);
        process.nextTick(() => this.destroy());
        callback();
      },
    });
  }

  private consumeRequestBytes(chunk: Buffer): void {
    if (this.bodyStream !== undefined) {
      this.writeBodyBytes(chunk);
      return;
    }

    this.requestBuffer = Buffer.concat([this.requestBuffer, chunk]);
    const separatorIndex = this.requestBuffer.indexOf('\r\n\r\n', 0, 'latin1');
    if (separatorIndex === -1) {
      return;
    }

    const headerText = this.requestBuffer.slice(0, separatorIndex).toString('latin1');
    const bodyStart = separatorIndex + 4;
    const firstBodyChunk = this.requestBuffer.subarray(bodyStart);
    this.requestBuffer = Buffer.alloc(0);
    this.bodyStream = new PassThrough();
    this.expectedBodyBytes = parseContentLength(headerText);
    const isChunked = /transfer-encoding:\s*chunked/i.test(headerText);
    if (isChunked) {
      this.chunkDecoder = new ChunkedBodyDecoder(this.bodyStream);
    }

    this.forwardRequestOnce();
    if (firstBodyChunk.length > 0) {
      this.writeBodyBytes(firstBodyChunk);
    }

    const expectsBody = this.expectedBodyBytes > 0 || isChunked;
    if (!expectsBody) {
      this.bodyStream.end();
    }
  }

  private writeBodyBytes(chunk: Buffer): void {
    if (this.bodyStream === undefined) {
      return;
    }

    if (this.chunkDecoder !== undefined) {
      this.chunkDecoder.write(chunk);
      return;
    }

    if (this.expectedBodyBytes > 0) {
      const remaining = this.expectedBodyBytes - this.receivedBodyBytes;
      const toWrite = chunk.subarray(0, remaining);
      this.receivedBodyBytes += toWrite.length;
      if (toWrite.length > 0) {
        this.bodyStream.write(toWrite);
      }
      if (this.receivedBodyBytes >= this.expectedBodyBytes) {
        this.bodyStream.end();
      }
      return;
    }

    this.bodyStream.write(chunk);
  }
}

class ChunkedBodyDecoder {
  private pending = Buffer.alloc(0);

  private expectedChunkBytes: number | undefined;

  public constructor(private readonly output: PassThrough) {}

  public write(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.flush();
  }

  private flush(): void {
    while (this.pending.length > 0) {
      if (this.expectedChunkBytes === undefined) {
        const lineEnd = this.pending.indexOf('\r\n', 0, 'latin1');
        if (lineEnd === -1) {
          return;
        }
        const size = Number.parseInt(this.pending.subarray(0, lineEnd).toString('ascii'), 16);
        this.pending = this.pending.subarray(lineEnd + 2);
        if (size === 0 || !Number.isFinite(size)) {
          this.output.end();
          this.pending = Buffer.alloc(0);
          return;
        }
        this.expectedChunkBytes = size;
      }

      if (this.pending.length < this.expectedChunkBytes + 2) {
        return;
      }
      this.output.write(this.pending.subarray(0, this.expectedChunkBytes));
      this.pending = this.pending.subarray(this.expectedChunkBytes + 2);
      this.expectedChunkBytes = undefined;
    }
  }
}

interface BrokerControlFrame {
  readonly routes: { targetId: string; domain: string }[];
}

function requestJson(
  session: http2.ClientHttp2Session,
  payload: Record<string, string | readonly string[]>,
  guestId: string,
): Promise<{ status?: string }> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    readStreamText(stream).then((body) => {
      try {
        resolve(JSON.parse(body) as { status?: string });
      } catch (error) {
        reject(
          createVerserError('protocol-error', 'Host returned invalid registration JSON', {
            guestId,
            cause: getErrorMessage(error),
          }),
        );
      }
    }, reject);
    stream.end(JSON.stringify(payload));
  });
}

function normalHeaders(headers: http2.IncomingHttpHeaders): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith(':') && typeof value === 'string') {
      normalizedHeaders[key] = value;
    }
  }
  return normalizedHeaders;
}

function errorFromBody(body: Buffer, targetId: string): VerserError {
  const parsed = JSON.parse(body.toString('utf8')) as {
    error?: {
      code?: string;
      message?: string;
      context?: Record<string, string | number | boolean>;
    };
  };
  const code = toVerserErrorCode(parsed.error?.code);
  return createVerserError(code, parsed.error?.message ?? 'Broker request failed', {
    targetId,
    ...(parsed.error?.context ?? {}),
  });
}

function toVerserErrorCode(code: string | undefined): VerserErrorCode {
  if (
    code === 'missing-guest' ||
    code === 'disconnected-target' ||
    code === 'timeout' ||
    code === 'stream-failure' ||
    code === 'protocol-error' ||
    code === 'local-handler-failure' ||
    code === 'invalid-registration' ||
    code === 'certificate-verification-failure'
  ) {
    return code;
  }

  return 'local-handler-failure';
}

function normalizeRequestHeaders(
  headers: http.OutgoingHttpHeaders | undefined,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') {
      normalizedHeaders[key] = value;
    } else if (typeof value === 'number') {
      normalizedHeaders[key] = String(value);
    } else if (Array.isArray(value)) {
      normalizedHeaders[key] = value.join(', ');
    }
  }
  return normalizedHeaders;
}

function flattenHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  const flattenedHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    flattenedHeaders[headerName] =
      typeof headerValue === 'string' ? headerValue : headerValue.join(',');
  }
  return flattenedHeaders;
}

function parseContentLength(headerText: string): number {
  const match = /content-length:\s*(\d+)/i.exec(headerText);
  if (match === null) {
    return 0;
  }

  return Number.parseInt(match[1], 10);
}

function serializeHttpResponseHead(response: VerserBrokerResponse): Buffer {
  const headers = { ...response.headers };
  const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  return Buffer.from(`HTTP/1.1 ${response.statusCode} OK\r\n${headerLines.join('\r\n')}\r\n\r\n`);
}

function readResponseBody(stream: http2.ClientHttp2Stream): Promise<Buffer> {
  return readStreamBuffer(stream);
}

function once(emitter: EventEmitter, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, () => resolve());
    emitter.once('error', reject);
  });
}

function toVerserError(error: unknown): VerserError {
  return createVerserError('protocol-error', getErrorMessage(error), { guestId: 'unknown' });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

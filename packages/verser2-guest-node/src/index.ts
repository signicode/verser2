import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import { Duplex, Readable } from 'node:stream';

import {
  type RoutedRequestEnvelope,
  type RoutedResponseEnvelope,
  VERSER_LIFECYCLE_EVENTS,
  type VerserError,
  createDevelopmentTlsCertificate,
  createGuestId,
  createRoutedRequestEnvelope,
  createRoutedResponseEnvelope,
  createVerserError,
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
  readonly body?: readonly Buffer[];
}

export interface VerserBrokerResponse extends RoutedResponseEnvelope {
  readonly body: Buffer;
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

export class MinimalIncomingMessage extends Readable {
  public readonly method: string;

  public readonly url: string;

  public readonly headers: Record<string, string>;

  private readonly body: readonly (string | Buffer)[];

  public constructor(request: VerserNodeGuestDispatchRequest) {
    super();
    this.method = request.method;
    this.url = request.path;
    this.headers = request.headers;
    this.body = request.body;
  }

  public override _read(): void {
    for (const chunk of this.body) {
      this.push(chunk);
    }
    this.push(null);
  }
}

export class MinimalServerResponse extends EventEmitter {
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly chunks: Buffer[] = [];

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
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return true;
  }

  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    }
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
    readJsonLines<HostRequestFrame>(stream, (frame) => {
      if (frame.type === 'request') {
        this.handleControlRequest(frame, stream).catch((error: unknown) => {
          writeJsonLine(stream, {
            type: 'handler-error',
            requestId: frame.requestId,
            error: { code: 'local-handler-failure', message: getErrorMessage(error) },
          });
        });
      }
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

  private async handleControlRequest(
    frame: HostRequestFrame,
    stream: http2.ClientHttp2Stream,
  ): Promise<void> {
    try {
      const response = await this.dispatchRoutedRequest({
        requestId: frame.requestId,
        sourceId: frame.sourceId,
        targetId: frame.targetId,
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: [Buffer.from(frame.bodyBase64, 'base64')],
      });
      writeJsonLine(stream, {
        type: 'response-start',
        requestId: response.requestId,
        statusCode: response.statusCode,
        headers: response.headers,
      });
      writeJsonLine(stream, {
        type: 'response-body',
        requestId: response.requestId,
        bodyBase64: response.body.toString('base64'),
      });
      writeJsonLine(stream, { type: 'response-end', requestId: response.requestId });
    } catch (error) {
      const verserError = error as VerserError;
      writeJsonLine(stream, {
        type: 'handler-error',
        requestId: frame.requestId,
        error: {
          code: verserError.code ?? 'local-handler-failure',
          message: getErrorMessage(error),
        },
      });
    }
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
      const bodyChunks: Buffer[] = [];
      let statusCode = 200;
      let responseHeaders: Record<string, string> = {};
      stream.on('response', (headers) => {
        statusCode = Number(headers[':status'] ?? 200);
        responseHeaders = normalHeaders(headers);
      });
      stream.on('data', (chunk: Buffer | string) => {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => {
        const body = Buffer.concat(bodyChunks);
        if (statusCode >= 400) {
          reject(errorFromBody(body, request.targetId));
          return;
        }
        resolve({ requestId, statusCode, headers: responseHeaders, body });
      });
      stream.on('error', reject);
      for (const chunk of request.body ?? []) {
        stream.write(chunk);
      }
      stream.end();
    });
  }

  private async register(session: http2.ClientHttp2Session): Promise<void> {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    this.controlStream = stream;
    readJsonLines<BrokerControlFrame>(stream, (frame) => this.handleControlFrame(frame));
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

  private readonly requestChunks: Buffer[] = [];

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
    this.requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    this.forwardIfNoBodyRequest();
    callback();
  }

  public override _final(callback: () => void): void {
    callback();
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
      body: [extractHttpRequestBody(Buffer.concat(this.requestChunks))],
    });
    this.push(serializeHttpResponse(response));
    this.push(null);
    process.nextTick(() => this.destroy());
  }

  private forwardIfNoBodyRequest(): void {
    const serializedRequest = Buffer.concat(this.requestChunks);
    const separatorIndex = serializedRequest.indexOf('\r\n\r\n', 0, 'latin1');
    if (separatorIndex === -1) {
      return;
    }

    const headerText = serializedRequest.slice(0, separatorIndex).toString('latin1');
    const expectsBody =
      /content-length:\s*[1-9]/i.test(headerText) || /transfer-encoding:/i.test(headerText);
    if (!expectsBody) {
      this.forwardRequestOnce();
    }
  }
}

interface HostRequestFrame {
  readonly type: 'request';
  readonly requestId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly bodyBase64: string;
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
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.on('end', () => {
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
    });
    stream.on('error', reject);
    stream.end(JSON.stringify(payload));
  });
}

function readJsonLines<T>(stream: EventEmitter, onFrame: (frame: T) => void): void {
  let pending = '';
  const readable = stream as http2.ClientHttp2Stream;
  readable.setEncoding('utf8');
  readable.on('data', (chunk: string) => {
    pending += chunk;
    let lineBreak = pending.indexOf('\n');
    while (lineBreak !== -1) {
      const line = pending.slice(0, lineBreak);
      pending = pending.slice(lineBreak + 1);
      if (line.length > 0) {
        onFrame(JSON.parse(line) as T);
      }
      lineBreak = pending.indexOf('\n');
    }
  });
}

function writeJsonLine(stream: http2.ClientHttp2Stream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
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
  const code = parsed.error?.code === 'missing-guest' ? 'missing-guest' : 'local-handler-failure';
  return createVerserError(code, parsed.error?.message ?? 'Broker request failed', {
    targetId,
    ...(parsed.error?.context ?? {}),
  });
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

function extractHttpRequestBody(serializedRequest: Buffer): Buffer {
  const separator = Buffer.from('\r\n\r\n');
  const separatorIndex = serializedRequest.indexOf(separator);
  if (separatorIndex === -1) {
    return Buffer.alloc(0);
  }

  const headerText = serializedRequest.slice(0, separatorIndex).toString('latin1');
  const body = serializedRequest.slice(separatorIndex + separator.length);
  if (/transfer-encoding:\s*chunked/i.test(headerText)) {
    return decodeChunkedBody(body);
  }

  return body;
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset, 'latin1');
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(body.slice(offset, lineEnd).toString('ascii'), 16);
    if (size === 0 || !Number.isFinite(size)) {
      break;
    }
    const chunkStart = lineEnd + 2;
    chunks.push(body.slice(chunkStart, chunkStart + size));
    offset = chunkStart + size + 2;
  }

  return Buffer.concat(chunks);
}

function serializeHttpResponse(response: VerserBrokerResponse): Buffer {
  const headers = {
    ...response.headers,
    'content-length': String(response.body.length),
  };
  const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  return Buffer.concat([
    Buffer.from(`HTTP/1.1 ${response.statusCode} OK\r\n${headerLines.join('\r\n')}\r\n\r\n`),
    response.body,
  ]);
}

function once(emitter: EventEmitter, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, () => resolve());
    emitter.once('error', reject);
  });
}

function toVerserError(error: Error): VerserError {
  return createVerserError('protocol-error', error.message, { guestId: 'unknown' });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

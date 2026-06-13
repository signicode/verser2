import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import { PassThrough, Readable } from 'node:stream';
import { text as readStreamText } from 'node:stream/consumers';
import type { TLSSocket } from 'node:tls';

import {
  type RoutedDomainRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserCertificateIdentity,
  type VerserError,
  type VerserPeerId,
  type VerserPeerRole,
  type VerserRegistrationAuthorizationContext,
  type VerserRegistrationRequest,
  type VerserRegistrationResponse,
  createBrokerRoutesControlFrame,
  createPeerId,
  createRoutedDomainRegistration,
  createVerserError,
  decodeHeaderMap,
  encodeVerserEnvelope,
  extractCertificateIdentity,
  flattenVerserHeaders,
  normalizeHostClientAuthTlsOptions,
  normalizeServerTlsOptions,
  parseLeaseAcquireTimeoutMs,
  parseRegistrationRequest,
  readLeaseResponseMetadataFromStream,
  readNdjsonLines,
  validateVerserHeaders,
} from '@signicode/verser-common';
import { sendError, writeJsonLine } from './http2-io';
import type {
  VerserHost,
  VerserHostLifecycleEvent,
  VerserHostOptions,
  VerserHostRegistrationRequest,
  VerserLocalBrokerHandle,
  VerserLocalBrokerOptions,
  VerserLocalBrokerRequest,
  VerserLocalBrokerResponse,
  VerserLocalGuestHandle,
  VerserLocalGuestOptions,
  VerserLocalGuestRequestListener,
} from './types';
import { toVerserError } from './utils';

interface RegisteredPeer {
  readonly peerId: VerserPeerId;
  readonly role: VerserPeerRole;
  readonly transport: 'h2' | 'local';
  readonly session?: http2.Http2Session;
  readonly controlStream?: http2.ServerHttp2Stream;
  readonly localGuest?: LocalGuestState;
  readonly localBroker?: LocalBrokerState;
}

interface LocalGuestState {
  readonly listener: VerserLocalGuestRequestListener;
}

interface LocalBrokerState {
  routes: RoutedDomainRegistration[];
  routeWaiters: Map<string, (() => void)[]>;
  requestCounter: number;
  closed: boolean;
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
    request.body.once('error', (error) => this.destroy(error));
    request.body.pipe(this);
  }
}

interface LocalDispatchRequest {
  readonly requestId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Readable;
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
    return {
      requestId,
      statusCode: this.statusCode,
      headers: flattenVerserHeaders(validateVerserHeaders(Object.fromEntries(this.headers))),
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

interface GuestLeaseStream {
  readonly guestId: VerserPeerId;
  readonly leaseId: string;
  readonly stream: http2.ServerHttp2Stream;
  active: boolean;
}

interface QueuedLeaseAcquisition {
  readonly guestId: VerserPeerId;
  readonly requestId: string;
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (lease: GuestLeaseStream) => void;
  readonly reject: (error: VerserError) => void;
}

/**
 * TLS HTTP/2 server implementation of the {@link VerserHost} interface.
 *
 * Accepts outbound connections from Guests (registering route domains) and Brokers
 * (discovering routes and issuing requests). See {@link VerserHost} for the full
 * API contract and supported paths.
 *
 * @remarks
 * - Creates a Node `http2.createSecureServer` with TLS.
 * - Listens on `127.0.0.1` port `0` (ephemeral) by default.
 * - Handles only the four Verser protocol paths (`/verser/register`,
 *   `/verser/guest/control`, `/verser/guest/lease`, `/verser/request`).
 * - Peer sessions are tracked for lifecycle management; duplicate peer IDs
 *   are rejected at registration time.
 * - Lease streams are managed as an idle pool; when a Broker request arrives,
 *   the Host acquires a lease from the pool (or queues the request waiting for one).
 * - Route changes are advertised to all connected Brokers via NDJSON control frames.
 *
 * @internal
 */
export class NodeHttp2VerserHost implements VerserHost {
  private readonly options: VerserHostOptions;

  private readonly lifecycle = new EventEmitter();

  private readonly peers = new Map<VerserPeerId, RegisteredPeer>();

  private readonly sessions = new Set<http2.ServerHttp2Session>();

  private readonly idleLeases = new Map<VerserPeerId, GuestLeaseStream[]>();

  private readonly activeLeases = new Map<string, GuestLeaseStream>();

  private readonly queuedLeaseAcquisitions = new Map<VerserPeerId, QueuedLeaseAcquisition[]>();

  private readonly guestRegistrations = new Map<VerserPeerId, RoutedDomainRegistration[]>();

  private server?: http2.Http2SecureServer;

  public constructor(options: VerserHostOptions) {
    this.options = options;
  }

  /**
   * {@inheritDoc VerserHost.running}
   */
  public get running(): boolean {
    return this.server !== undefined;
  }

  /**
   * {@inheritDoc VerserHost.address}
   */
  public get address(): import('node:net').AddressInfo {
    const server = this.server;
    if (server === undefined) {
      throw createVerserError('protocol-error', 'Verser Host is not listening');
    }

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw createVerserError('protocol-error', 'Verser Host is not listening');
    }

    return address;
  }

  /**
   * {@inheritDoc VerserHost.start}
   */
  public async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    const certificate = normalizeServerTlsOptions(this.options.tls);
    const clientAuth = normalizeHostClientAuthTlsOptions(this.options.tls?.clientAuth);
    const server = http2.createSecureServer({
      cert: certificate.cert,
      key: certificate.key,
      pfx: certificate.pfx,
      passphrase: certificate.passphrase,
      ca: clientAuth?.ca,
      requestCert: clientAuth?.requestCert,
      rejectUnauthorized: clientAuth?.rejectUnauthorized,
    });

    server.on('session', (session) => this.trackSession(session));
    server.on('stream', (stream, headers) => {
      this.handleStream(stream, headers).catch((error: unknown) => {
        const verserError = toVerserError(error);
        this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: verserError });
        sendError(stream, verserError);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.server = server;
  }

  /**
   * {@inheritDoc VerserHost.reloadTlsCertificate}
   */
  public reloadTlsCertificate(): void {
    if (this.server === undefined) {
      throw new Error('Host is not running; cannot reload TLS certificate.');
    }

    const certificate = normalizeServerTlsOptions(this.options.tls);
    this.server.setSecureContext(certificate);
  }

  /**
   * {@inheritDoc VerserHost.close}
   */
  public async close(reason = 'host-close'): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }

    this.server = undefined;

    for (const peer of this.peers.values()) {
      peer.controlStream?.close(http2.constants.NGHTTP2_NO_ERROR);
      peer.localBroker?.routeWaiters.clear();
    }

    this.closeAllLeases();
    this.failAllQueuedLeaseAcquisitions(reason);

    for (const session of this.sessions) {
      session.close();
    }
    this.sessions.clear();
    this.peers.clear();
    this.guestRegistrations.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.closed, reason });
  }

  /**
   * {@inheritDoc VerserHost.getRoutedDomains}
   */
  public getRoutedDomains(): RoutedDomainRegistration[] {
    return [...this.guestRegistrations.values()].flat();
  }

  public async attachLocalGuest(options: VerserLocalGuestOptions): Promise<VerserLocalGuestHandle> {
    const peerId = createPeerId(options.guestId);
    if (this.peers.has(peerId)) {
      throw createVerserError('invalid-registration', 'Peer is already registered', { peerId });
    }

    await this.authorizeLocalRegistration(peerId, {
      peerId,
      role: 'guest',
      routedDomains: [...(options.routedDomains ?? [])],
    });

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected, peerId, role: 'guest' });
    this.peers.set(peerId, {
      peerId,
      role: 'guest',
      transport: 'local',
      localGuest: { listener: this.extractLocalGuestListener(peerId, options.listener) },
    });
    this.guestRegistrations.set(
      peerId,
      (options.routedDomains ?? []).map((domain) =>
        createRoutedDomainRegistration({ targetId: peerId, domain }),
      ),
    );
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered, peerId, role: 'guest' });
    this.advertiseRoutes();

    let closed = false;
    return {
      close: async (reason = 'local-guest-close') => {
        if (closed) {
          return;
        }
        closed = true;
        this.detachLocalPeer(peerId, reason);
      },
    };
  }

  public async attachLocalBroker(
    options: VerserLocalBrokerOptions,
  ): Promise<VerserLocalBrokerHandle> {
    const peerId = createPeerId(options.brokerId);
    if (this.peers.has(peerId)) {
      throw createVerserError('invalid-registration', 'Peer is already registered', { peerId });
    }

    await this.authorizeLocalRegistration(peerId, {
      peerId,
      role: 'broker',
      routedDomains: [],
    });

    const localBroker: LocalBrokerState = {
      routes: this.getRoutedDomains(),
      routeWaiters: new Map(),
      requestCounter: 0,
      closed: false,
    };
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected, peerId, role: 'broker' });
    this.peers.set(peerId, { peerId, role: 'broker', transport: 'local', localBroker });
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered, peerId, role: 'broker' });

    return {
      get routedRequestCount() {
        return localBroker.requestCounter;
      },
      getRoutes: () => [...localBroker.routes],
      waitForRoute: (domain: string) => this.waitForLocalBrokerRoute(localBroker, domain),
      request: (request: VerserLocalBrokerRequest) =>
        this.routeLocalBrokerRequest(peerId, localBroker, request),
      close: async (reason = 'local-broker-close') => {
        if (localBroker.closed) {
          return;
        }
        localBroker.closed = true;
        this.detachLocalPeer(peerId, reason);
      },
    };
  }

  /**
   * {@inheritDoc VerserHost.onLifecycle}
   */
  public onLifecycle(listener: (event: VerserHostLifecycleEvent) => void): () => void {
    this.lifecycle.on('event', listener);
    return () => this.lifecycle.off('event', listener);
  }

  private trackSession(session: http2.ServerHttp2Session): void {
    this.sessions.add(session);
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected });

    session.on('close', () => {
      this.sessions.delete(session);
      this.removeSessionPeers(session);
    });
    session.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
  }

  private async handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const path = String(headers[':path'] ?? '');
    if (path === '/verser/guest/control') {
      this.attachGuestControlStream(stream, headers);
      return;
    }

    if (path === '/verser/guest/lease') {
      this.attachGuestLeaseStream(stream, headers);
      return;
    }

    if (path === '/verser/request') {
      await this.routeBrokerRequest(stream, headers);
      return;
    }

    if (path !== '/verser/register') {
      throw createVerserError('protocol-error', 'Unsupported Host stream path', {
        path,
      });
    }

    const registration = parseRegistrationRequest(await readStreamText(stream));
    await this.registerPeer(stream, registration);
  }

  private async registerPeer(
    stream: http2.ServerHttp2Stream,
    registration: VerserHostRegistrationRequest,
  ): Promise<void> {
    const peerId = createPeerId(registration.peerId);
    if (this.peers.has(peerId)) {
      throw createVerserError('invalid-registration', 'Peer is already registered', { peerId });
    }

    const session = stream.session;
    if (session === undefined) {
      throw createVerserError(
        'protocol-error',
        'Registration stream does not have an HTTP/2 session',
      );
    }

    const authorized = await this.authorizeRegistration(stream, session, peerId, registration);
    if (!authorized) {
      return;
    }

    const peer: RegisteredPeer = {
      peerId,
      role: registration.role,
      transport: 'h2',
      session,
      controlStream: registration.role === 'broker' ? stream : undefined,
    };

    this.peers.set(peerId, peer);
    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.registered,
      peerId,
      role: registration.role,
    });

    if (registration.role === 'guest') {
      this.guestRegistrations.set(
        peerId,
        (registration.routedDomains ?? []).map((domain: string) =>
          createRoutedDomainRegistration({ targetId: peerId, domain }),
        ),
      );
    }

    const response: VerserRegistrationResponse = {
      status: 'registered',
      routes: this.getRoutedDomains(),
    };
    if (registration.role === 'broker') {
      writeJsonLine(stream, response);
      return;
    }

    if (!stream.headersSent) {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
    }
    stream.end(JSON.stringify(response));
    this.advertiseRoutes();
  }

  private async authorizeRegistration(
    stream: http2.ServerHttp2Stream,
    session: http2.Http2Session,
    peerId: VerserPeerId,
    registration: VerserRegistrationRequest,
  ): Promise<boolean> {
    const callback = this.options.tls?.clientAuth?.authorizeRegistration;
    if (callback === undefined) {
      return true;
    }

    const tlsSocket = session.socket as TLSSocket;
    const context: VerserRegistrationAuthorizationContext = {
      peerId,
      role: registration.role,
      routedDomains: registration.routedDomains ?? [],
      certificate: this.getCertificateIdentity(tlsSocket),
      metadata: {
        authorized: tlsSocket.authorized,
        authorizationError: tlsSocket.authorizationError?.message,
      },
    };
    const action = await callback(context);

    if (action.action === 'allow') {
      return true;
    }

    const reason = action.reason ?? 'registration rejected by client certificate policy';
    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.error,
      peerId,
      role: registration.role,
      error: createVerserError('invalid-registration', reason, { peerId, role: registration.role }),
    });

    if (!stream.headersSent && !stream.closed) {
      stream.respond({ ':status': 403, 'content-type': 'application/json' });
    }
    if (!stream.closed) {
      stream.end(JSON.stringify({ status: 'closed', reason }));
    }
    session.close();
    return false;
  }

  private extractLocalGuestListener(
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

  private getCertificateIdentity(tlsSocket: TLSSocket): VerserCertificateIdentity | undefined {
    return extractCertificateIdentity(
      tlsSocket.getPeerCertificate(true),
      this.options.tls?.clientAuth?.knownExtensionOids ?? [],
    );
  }

  private async authorizeLocalRegistration(
    peerId: VerserPeerId,
    registration: VerserRegistrationRequest,
  ): Promise<void> {
    const callback = this.options.tls?.clientAuth?.authorizeRegistration;
    if (callback === undefined) {
      return;
    }

    const action = await callback({
      peerId,
      role: registration.role,
      routedDomains: registration.routedDomains ?? [],
      certificate: undefined,
      metadata: { local: true, authorized: true },
    });
    if (action.action === 'allow') {
      return;
    }

    const reason = action.reason ?? 'registration rejected by local peer policy';
    const error = createVerserError('invalid-registration', reason, {
      peerId,
      role: registration.role,
    });
    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.error,
      peerId,
      role: registration.role,
      error,
    });
    throw error;
  }

  private detachLocalPeer(peerId: VerserPeerId, reason: string): void {
    const peer = this.peers.get(peerId);
    if (peer === undefined || peer.transport !== 'local') {
      return;
    }

    this.peers.delete(peerId);
    const shouldAdvertiseRoutes = peer.role === 'guest';
    if (shouldAdvertiseRoutes) {
      this.guestRegistrations.delete(peerId);
      this.closeGuestLeases(peerId);
      this.failQueuedLeaseAcquisitions(peerId, reason);
    }
    peer.localBroker?.routeWaiters.clear();
    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.disconnected,
      peerId,
      role: peer.role,
      reason,
    });
    if (shouldAdvertiseRoutes) {
      this.advertiseRoutes();
    }
  }

  private waitForLocalBrokerRoute(broker: LocalBrokerState, domain: string): Promise<void> {
    if (broker.routes.some((route) => route.domain === domain)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      broker.routeWaiters.set(domain, [...(broker.routeWaiters.get(domain) ?? []), resolve]);
    });
  }

  private routeLocalBrokerRequest(
    sourceId: VerserPeerId,
    broker: LocalBrokerState,
    request: VerserLocalBrokerRequest,
  ): Promise<VerserLocalBrokerResponse> {
    if (broker.closed) {
      return Promise.reject(createVerserError('disconnected-target', 'Local Broker is closed'));
    }

    const requestId = `${sourceId}-${++broker.requestCounter}`;
    const targetId = createPeerId(request.targetId);
    const body = this.toReadableBody(request.body);
    return this.routeLocalRequest({
      requestId,
      sourceId,
      targetId,
      method: request.method,
      path: request.path,
      headers: flattenVerserHeaders(validateVerserHeaders(request.headers ?? {})),
      body,
    });
  }

  private async routeLocalRequest(
    request: LocalDispatchRequest,
  ): Promise<VerserLocalBrokerResponse> {
    const target = this.peers.get(request.targetId);
    if (target === undefined || target.role !== 'guest') {
      throw createVerserError('missing-guest', 'Target Guest is not registered', {
        targetId: request.targetId,
      });
    }

    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.requestStarted,
      peerId: request.targetId,
      role: 'guest',
    });
    try {
      const response =
        target.transport === 'local'
          ? await this.routeLocalRequestToLocalGuest(request, target)
          : await this.routeLocalRequestToH2Guest(request);
      this.emitLifecycle({
        name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
        peerId: request.targetId,
        role: 'guest',
      });
      return response;
    } catch (error) {
      const verserError = toVerserError(error);
      this.emitLifecycle({
        name: VERSER_LIFECYCLE_EVENTS.error,
        peerId: request.targetId,
        role: 'guest',
        error: verserError,
      });
      throw verserError;
    }
  }

  private routeLocalRequestToLocalGuest(
    request: LocalDispatchRequest,
    target: RegisteredPeer,
  ): Promise<VerserLocalBrokerResponse> {
    const localGuest = target.localGuest;
    if (localGuest === undefined) {
      return Promise.reject(
        createVerserError('disconnected-target', 'Target local Guest is not attached', {
          targetId: request.targetId,
        }),
      );
    }

    const localRequest = new LocalIncomingMessage(request);
    const localResponse = new LocalServerResponse();
    return new Promise((resolve, reject) => {
      const rejectBeforeResponse = (error: unknown): void => {
        reject(
          createVerserError('local-handler-failure', this.getErrorMessage(error), {
            targetId: request.targetId,
            requestId: request.requestId,
            path: request.path,
          }),
        );
      };
      localResponse.once('response', () =>
        resolve(localResponse.toBrokerResponse(request.requestId)),
      );
      localResponse.once('error', (error) => {
        if (localResponse.headersStarted) {
          return;
        }
        rejectBeforeResponse(error);
      });

      try {
        localGuest.listener(localRequest, localResponse);
      } catch (error) {
        const verserError = createVerserError(
          'local-handler-failure',
          this.getErrorMessage(error),
          {
            targetId: request.targetId,
            requestId: request.requestId,
            path: request.path,
          },
        );
        if (localResponse.headersStarted) {
          localResponse.fail(verserError);
          resolve(localResponse.toBrokerResponse(request.requestId));
          return;
        }
        reject(verserError);
      }
    });
  }

  private async routeLocalRequestToH2Guest(
    request: LocalDispatchRequest,
  ): Promise<VerserLocalBrokerResponse> {
    const lease = await this.acquireLease(request.targetId, request.requestId, 30_000);
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
    const metadata = await responsePromise;
    return {
      requestId: request.requestId,
      statusCode: metadata.statusCode,
      headers: flattenVerserHeaders(validateVerserHeaders(metadata.headers)),
      body: lease.stream,
    };
  }

  private toReadableBody(body: VerserLocalBrokerRequest['body']): Readable {
    if (body === undefined) {
      return Readable.from([]);
    }
    if (body instanceof Readable) {
      return body;
    }
    return Readable.from(body);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private advertiseRoutes(): void {
    const routes = this.getRoutedDomains();
    for (const peer of this.peers.values()) {
      if (peer.role === 'broker' && peer.transport === 'local' && peer.localBroker !== undefined) {
        peer.localBroker.routes = [...routes];
        for (const route of routes) {
          for (const resolve of peer.localBroker.routeWaiters.get(route.domain) ?? []) {
            resolve();
          }
          peer.localBroker.routeWaiters.delete(route.domain);
        }
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.routeAdvertised,
          peerId: peer.peerId,
          role: peer.role,
        });
        continue;
      }
      if (
        peer.role === 'broker' &&
        peer.controlStream !== undefined &&
        !peer.controlStream.closed
      ) {
        writeJsonLine(peer.controlStream, createBrokerRoutesControlFrame(routes));
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.routeAdvertised,
          peerId: peer.peerId,
          role: peer.role,
        });
      }
    }
  }

  private attachGuestControlStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const peerId = String(headers['x-verser-peer-id'] ?? '');
    const peer = this.peers.get(peerId);
    if (peer === undefined || peer.role !== 'guest') {
      throw createVerserError(
        'disconnected-target',
        'Guest control stream has no registered peer',
        {
          targetId: peerId,
        },
      );
    }

    this.peers.set(peerId, { ...peer, controlStream: stream });
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    readNdjsonLines<unknown>(stream, () => {
      // Guest control stream body routing was removed; keep the stream open for coordination.
    });
  }

  private attachGuestLeaseStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const guestId = createPeerId(String(headers['x-verser-peer-id'] ?? ''));
    const leaseId = String(headers['x-verser-lease-id'] ?? '').trim();
    const peer = this.peers.get(guestId);
    if (peer === undefined || peer.role !== 'guest') {
      throw createVerserError('disconnected-target', 'Guest lease stream has no registered peer', {
        targetId: guestId,
      });
    }
    if (leaseId.length === 0) {
      throw createVerserError('protocol-error', 'Guest lease stream requires a lease id', {
        targetId: guestId,
      });
    }

    const lease: GuestLeaseStream = { guestId, leaseId, stream, active: false };
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
    stream.on('close', () => this.removeLease(lease));
    stream.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      this.removeLease(lease);
    });

    this.addIdleLease(lease);
  }

  private async routeBrokerRequest(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const targetId = String(headers['x-verser-target-id'] ?? '');
    const requestId = String(headers['x-verser-request-id'] ?? `req-${Date.now()}`);
    const target = this.peers.get(targetId);

    if (target === undefined) {
      throw createVerserError('missing-guest', 'Target Guest is not registered', { targetId });
    }
    if (target.role !== 'guest') {
      throw createVerserError('missing-guest', 'Target peer is not a Guest', { targetId });
    }
    if (target.transport === 'local') {
      await this.routeH2BrokerRequestToLocalGuest(
        stream,
        headers,
        requestId,
        createPeerId(targetId),
      );
      return;
    }
    const lease = await this.tryAcquireLease(
      createPeerId(targetId),
      requestId,
      parseLeaseAcquireTimeoutMs(headers),
    );
    if (lease !== undefined) {
      await this.routeBrokerRequestOverLease(stream, headers, lease, requestId, targetId);
      return;
    }

    const queuedLease = await this.acquireLease(
      createPeerId(targetId),
      requestId,
      parseLeaseAcquireTimeoutMs(headers),
    );
    await this.routeBrokerRequestOverLease(stream, headers, queuedLease, requestId, targetId);
  }

  private async routeH2BrokerRequestToLocalGuest(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    requestId: string,
    targetId: VerserPeerId,
  ): Promise<void> {
    const response = await this.routeLocalRequest({
      requestId,
      sourceId: String(headers['x-verser-source-id'] ?? ''),
      targetId,
      method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
      path: String(headers['x-verser-path'] ?? '/'),
      headers: flattenVerserHeaders(
        validateVerserHeaders(decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}'))),
      ),
      body: stream,
    });
    stream.respond({
      ':status': response.statusCode,
      ...validateVerserHeaders(response.headers),
    });
    response.body.once('error', () => {
      if (!stream.closed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    response.body.pipe(stream);
  }

  private async routeBrokerRequestOverLease(
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
      ...validateVerserHeaders(responseMetadata.headers),
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

  private removeSessionPeers(session: http2.ServerHttp2Session): void {
    let shouldAdvertiseRoutes = false;
    for (const [peerId, peer] of this.peers) {
      if (peer.session === session) {
        this.peers.delete(peerId);
        this.guestRegistrations.delete(peerId);
        this.closeGuestLeases(peerId);
        this.failQueuedLeaseAcquisitions(peerId, 'guest-disconnect');
        shouldAdvertiseRoutes = shouldAdvertiseRoutes || peer.role === 'guest';
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.disconnected,
          peerId,
          role: peer.role,
        });
      }
    }

    if (shouldAdvertiseRoutes) {
      this.advertiseRoutes();
    }
  }

  private emitLifecycle(event: VerserHostLifecycleEvent): void {
    this.lifecycle.emit('event', event);
  }

  private addIdleLease(lease: GuestLeaseStream): void {
    const queued = this.queuedLeaseAcquisitions.get(lease.guestId)?.shift();
    if (queued !== undefined) {
      clearTimeout(queued.timeout);
      lease.active = true;
      this.activeLeases.set(`${lease.guestId}:${lease.leaseId}`, lease);
      queued.resolve(lease);
      return;
    }

    const idleLeases = this.idleLeases.get(lease.guestId) ?? [];
    idleLeases.push(lease);
    this.idleLeases.set(lease.guestId, idleLeases);
  }

  private acquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream> {
    const idleLeases = this.idleLeases.get(guestId) ?? [];
    const lease = idleLeases.shift();
    if (lease !== undefined) {
      lease.active = true;
      this.activeLeases.set(`${lease.guestId}:${lease.leaseId}`, lease);
      return Promise.resolve(lease);
    }

    return new Promise((resolve, reject) => {
      const acquisition: QueuedLeaseAcquisition = {
        guestId,
        requestId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeQueuedLeaseAcquisition(acquisition);
          reject(
            createVerserError('timeout', 'Timed out waiting for a Guest lease stream', {
              targetId: guestId,
              requestId,
              timeoutMs,
            }),
          );
        }, timeoutMs),
      };
      const queued = this.queuedLeaseAcquisitions.get(guestId) ?? [];
      queued.push(acquisition);
      this.queuedLeaseAcquisitions.set(guestId, queued);
    });
  }

  private async tryAcquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream | undefined> {
    const idleLeases = this.idleLeases.get(guestId) ?? [];
    if (idleLeases.length === 0) {
      return undefined;
    }

    return this.acquireLease(guestId, requestId, timeoutMs);
  }

  private removeLease(lease: GuestLeaseStream): void {
    const idleLeases = this.idleLeases.get(lease.guestId) ?? [];
    this.idleLeases.set(
      lease.guestId,
      idleLeases.filter((candidate) => candidate !== lease),
    );
    this.activeLeases.delete(`${lease.guestId}:${lease.leaseId}`);
  }

  private closeGuestLeases(guestId: VerserPeerId): void {
    for (const lease of this.idleLeases.get(guestId) ?? []) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    this.idleLeases.delete(guestId);

    for (const lease of this.activeLeases.values()) {
      if (lease.guestId === guestId) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
        this.activeLeases.delete(`${lease.guestId}:${lease.leaseId}`);
      }
    }
  }

  private closeAllLeases(): void {
    for (const leases of this.idleLeases.values()) {
      for (const lease of leases) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    }
    for (const lease of this.activeLeases.values()) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    this.idleLeases.clear();
    this.activeLeases.clear();
  }

  private failQueuedLeaseAcquisitions(guestId: VerserPeerId, reason: string): void {
    const queued = this.queuedLeaseAcquisitions.get(guestId) ?? [];
    this.queuedLeaseAcquisitions.delete(guestId);
    for (const acquisition of queued) {
      clearTimeout(acquisition.timeout);
      acquisition.reject(
        createVerserError('disconnected-target', 'Guest disconnected while waiting for a lease', {
          targetId: guestId,
          requestId: acquisition.requestId,
          reason,
        }),
      );
    }
  }

  private failAllQueuedLeaseAcquisitions(reason: string): void {
    for (const guestId of this.queuedLeaseAcquisitions.keys()) {
      this.failQueuedLeaseAcquisitions(guestId, reason);
    }
  }

  private removeQueuedLeaseAcquisition(acquisition: QueuedLeaseAcquisition): void {
    const queued = this.queuedLeaseAcquisitions.get(acquisition.guestId) ?? [];
    this.queuedLeaseAcquisitions.set(
      acquisition.guestId,
      queued.filter((candidate) => candidate !== acquisition),
    );
  }
}

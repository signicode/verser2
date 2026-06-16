import { EventEmitter } from 'node:events';
import * as http2 from 'node:http2';
import { PassThrough } from 'node:stream';
import { text as readStreamText } from 'node:stream/consumers';
import type { TLSSocket } from 'node:tls';

import {
  type FederatedRouteRegistration,
  type RoutedDomainRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserCertificateIdentity,
  type VerserError,
  type VerserErrorEnvelopeMetadata,
  type VerserHostFederationHandshake,
  type VerserHostId,
  type VerserPeerId,
  type VerserPeerRole,
  type VerserRegistrationAuthorizationContext,
  type VerserRegistrationRequest,
  type VerserRegistrationResponse,
  type VerserResponseEnvelopeMetadata,
  createBrokerRoutesControlFrame,
  createFederatedRoutesControlFrame,
  createPeerId,
  createRoutedDomainRegistration,
  createVerserError,
  createVerserHostFederationHandshake,
  createVerserHostId,
  decodeHeaderMap,
  encodeJsonLine,
  encodeVerserEnvelope,
  extractCertificateIdentity,
  flattenVerserHeaders,
  normalizeClientTlsOptions,
  normalizeHostClientAuthTlsOptions,
  normalizeServerTlsOptions,
  parseLeaseAcquireTimeoutMs,
  parseRegistrationRequest,
  readLeaseRequestMetadataFromStream,
  readLeaseResponseMetadataFromStream,
  readNdjsonLines,
  readVerserEnvelopeFromStream,
  toVerserErrorCode,
  validateVerserHeaders,
} from '@signicode/verser-common';
import { sendError, writeJsonLine } from './http2-io';
import {
  type LocalBrokerState,
  type LocalDispatchRequest,
  type LocalGuestState,
  closeLocalBrokerState,
  createLocalBrokerState,
  dispatchLocalGuestRequest,
  extractLocalGuestListener,
  toReadableBody,
  updateLocalBrokerRoutes,
  waitForLocalBrokerRoute,
} from './local-peers';
import { type HostRouteRegistry, createHostRouteRegistry } from './route-registry';
import type {
  VerserHost,
  VerserHostLifecycleEvent,
  VerserHostOptions,
  VerserHostRegistrationRequest,
  VerserHostUpstreamHandle,
  VerserHostUpstreamOptions,
  VerserHostUpstreamStatus,
  VerserLocalBrokerHandle,
  VerserLocalBrokerOptions,
  VerserLocalBrokerRequest,
  VerserLocalBrokerResponse,
  VerserLocalGuestHandle,
  VerserLocalGuestOptions,
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

interface UpstreamLink {
  readonly upstreamId: string;
  readonly remoteHostId: VerserHostId;
  readonly session: http2.ClientHttp2Session;
  readonly routeStream: http2.ClientHttp2Stream;
  requestStream: http2.ClientHttp2Stream;
  closing: boolean;
}

interface InboundFederationLink {
  readonly hostId: string;
  readonly session: http2.Http2Session;
  readonly routeStream?: http2.ServerHttp2Stream;
  readonly requestStream?: http2.ServerHttp2Stream;
  readonly requestBusy?: boolean;
}

type FederationRequestStream = http2.ServerHttp2Stream | http2.ClientHttp2Stream;

interface AcquiredFederatedRequestStream {
  readonly stream: FederationRequestStream;
  readonly via: 'inbound-federation' | 'upstream-link';
  readonly hostId: string;
}

interface FederatedRequestStreamWaiter {
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (stream: http2.ServerHttp2Stream) => void;
  readonly reject: (error: VerserError) => void;
}

const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 1000;

const FEDERATION_REQUEST_STREAM_MODE_HEADER = 'x-verser-federation-request-stream-mode';

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
 * - Handles only the Verser protocol paths (`/verser/register`,
 *   `/verser/guest/control`, `/verser/guest/lease`, `/verser/request`,
 *   `/verser/host/federation`, `/verser/host/federation/routes`, and
 *   `/verser/host/federation/request`).
 * - Peer sessions are tracked for lifecycle management; duplicate peer IDs
 *   are rejected at registration time.
 * - Lease streams are managed as an idle pool; when a Broker request arrives,
 *   the Host acquires a lease from the pool (or queues the request waiting for one).
 * - Handles Host federation handshakes, route streams, and request streams.
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

  private readonly routeRegistry: HostRouteRegistry;

  private readonly activeLocalRequests = new Map<VerserPeerId, Set<AbortController>>();

  private readonly upstreamLinks = new Map<string, UpstreamLink>();

  private readonly pendingUpstreamConnections = new Set<string>();

  private readonly inboundFederationHosts = new Map<string, InboundFederationLink>();

  private readonly federatedRequestStreamWaiters = new Map<
    string,
    FederatedRequestStreamWaiter[]
  >();

  private server?: http2.Http2SecureServer;

  public constructor(options: VerserHostOptions) {
    this.options = options;
    this.routeRegistry = createHostRouteRegistry(options);
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
    this.server = undefined;

    for (const link of [...this.upstreamLinks.values()]) {
      await this.closeUpstreamLink(link, reason);
    }

    if (server === undefined) {
      this.routeRegistry.clear();
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.closed, reason });
      return;
    }

    for (const peer of this.peers.values()) {
      peer.controlStream?.close(http2.constants.NGHTTP2_NO_ERROR);
      if (peer.localBroker !== undefined) {
        closeLocalBrokerState(peer.localBroker, reason);
      }
    }
    this.abortAllLocalRequests();

    this.closeAllLeases();
    this.failAllQueuedLeaseAcquisitions(reason);

    for (const link of this.inboundFederationHosts.values()) {
      link.routeStream?.close(http2.constants.NGHTTP2_NO_ERROR);
    }
    for (const session of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
    this.peers.clear();
    this.inboundFederationHosts.clear();
    this.routeRegistry.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.closed, reason });
  }

  /**
   * {@inheritDoc VerserHost.getRoutedDomains}
   */
  public getRoutedDomains(): RoutedDomainRegistration[] {
    return this.routeRegistry.getBrokerRoutes();
  }

  public setImportedFederatedRoutes(
    upstreamId: string,
    routes: readonly FederatedRouteRegistration[],
  ): VerserError[] {
    const update = this.routeRegistry.setImportedRoutes(upstreamId, routes);
    for (const rejection of update.rejected) {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: rejection.error });
    }
    if (!update.changed) {
      return update.rejected.map((rejection) => rejection.error);
    }
    this.advertiseRoutes();
    this.advertiseFederatedRoutes();
    return update.rejected.map((rejection) => rejection.error);
  }

  public removeImportedFederatedRoutes(upstreamId: string): void {
    this.routeRegistry.removeImportedRoutes(upstreamId);
    this.advertiseRoutes();
    this.advertiseFederatedRoutes();
  }

  public getFederatedRouteCandidates(
    targetId?: string,
    domain?: string,
  ): FederatedRouteRegistration[] {
    return this.routeRegistry.getCandidates(targetId, domain);
  }

  public async connectUpstream(
    options: VerserHostUpstreamOptions,
  ): Promise<VerserHostUpstreamHandle> {
    const localHostId = this.getFederationHostId();
    const upstreamId = createPeerId(options.upstreamId);
    if (this.upstreamLinks.has(upstreamId) || this.pendingUpstreamConnections.has(upstreamId)) {
      throw createVerserError('invalid-registration', 'Upstream is already connected', {
        upstreamId,
      });
    }
    this.pendingUpstreamConnections.add(upstreamId);

    const session = http2.connect(options.url, normalizeClientTlsOptions(options.tls) ?? {});
    let link: UpstreamLink | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        session.once('connect', resolve);
        session.once('error', reject);
      });
      const remoteHostId = await this.sendUpstreamHandshake(session, upstreamId, localHostId);
      const routeStream = await this.openUpstreamRouteStream(session, upstreamId, localHostId);
      const requestStream = await this.openUpstreamRequestStream(session, upstreamId, localHostId);
      link = { upstreamId, remoteHostId, session, routeStream, requestStream, closing: false };
      this.upstreamLinks.set(upstreamId, link);
      session.once('close', () => this.handleUpstreamSessionClose(upstreamId));
      routeStream.once('close', () => this.handleUpstreamRouteStreamClose(upstreamId));
      void this.handleUpstreamRequestStream(requestStream, upstreamId);
      session.on('error', (error) => {
        this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      });
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected, peerId: upstreamId });
      this.advertiseFederatedRoutes();
    } catch (error) {
      session.destroy();
      throw toVerserError(error);
    } finally {
      this.pendingUpstreamConnections.delete(upstreamId);
    }

    return {
      upstreamId,
      close: async (reason = 'upstream-close') =>
        this.closeUpstreamLink(link as UpstreamLink, reason),
    };
  }

  public getUpstreams(): VerserHostUpstreamStatus[] {
    return [...this.upstreamLinks.values()].map((link) => ({
      upstreamId: link.upstreamId,
      connected: !link.session.closed && !link.closing,
    }));
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
      localGuest: { listener: extractLocalGuestListener(peerId, options.listener) },
    });
    this.routeRegistry.setLocalRoutes(
      peerId,
      (options.routedDomains ?? []).map((domain) =>
        createRoutedDomainRegistration({ targetId: peerId, domain }),
      ),
    );
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered, peerId, role: 'guest' });
    this.advertiseRoutes();
    this.advertiseFederatedRoutes();

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

    const localBroker = createLocalBrokerState(this.getRoutedDomains());
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected, peerId, role: 'broker' });
    this.peers.set(peerId, { peerId, role: 'broker', transport: 'local', localBroker });
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered, peerId, role: 'broker' });

    return {
      get routedRequestCount() {
        return localBroker.requestCounter;
      },
      getRoutes: () => [...localBroker.routes],
      waitForRoute: (domain: string) => waitForLocalBrokerRoute(localBroker, domain),
      request: (request: VerserLocalBrokerRequest) =>
        this.routeLocalBrokerRequest(peerId, localBroker, request),
      close: async (reason = 'local-broker-close') => {
        if (localBroker.closed) {
          return;
        }
        closeLocalBrokerState(localBroker, reason);
        this.abortLocalRequestsForPeer(peerId);
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

  private getFederationHostId(): VerserHostId {
    if (this.options.hostId === undefined || this.options.hostId.trim().length === 0) {
      throw createVerserError(
        'invalid-registration',
        'Host federation requires a configured hostId',
      );
    }
    return createVerserHostId(this.options.hostId);
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

    if (path === '/verser/host/federation') {
      await this.handleHostFederationStream(stream);
      return;
    }

    if (path === '/verser/host/federation/routes') {
      this.handleHostFederationRouteStream(stream, headers);
      return;
    }

    if (path === '/verser/host/federation/request') {
      this.handleHostFederationRequestStream(stream, headers);
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
      this.routeRegistry.setLocalRoutes(
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
    this.advertiseFederatedRoutes();
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

  private async handleHostFederationStream(stream: http2.ServerHttp2Stream): Promise<void> {
    const localHostId = this.getFederationHostId();
    let handshake: VerserHostFederationHandshake;
    try {
      handshake = createVerserHostFederationHandshake(JSON.parse(await readStreamText(stream)));
    } catch (error) {
      throw createVerserError('protocol-error', 'Invalid Host federation handshake', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const authorized = await this.authorizeHostFederation(stream, handshake);
    if (!authorized) {
      return;
    }
    if (this.inboundFederationHosts.has(handshake.hostId)) {
      throw createVerserError('invalid-registration', 'Federated Host is already connected', {
        hostId: handshake.hostId,
      });
    }

    const session = stream.session;
    if (session === undefined) {
      throw createVerserError('protocol-error', 'Host federation stream has no HTTP/2 session');
    }
    this.inboundFederationHosts.set(handshake.hostId, { hostId: handshake.hostId, session });
    session.once('close', () => this.removeInboundFederationHost(handshake.hostId));

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered, peerId: handshake.hostId });
    if (!stream.headersSent) {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
    }
    stream.end(JSON.stringify({ status: 'registered', hostId: localHostId }));
  }

  private handleHostFederationRouteStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const hostId = String(headers['x-verser-host-id'] ?? '').trim();
    const link = this.inboundFederationHosts.get(hostId);
    if (hostId.length === 0 || link === undefined || link.session !== stream.session) {
      throw createVerserError(
        'disconnected-target',
        'Federated Host route stream is not registered',
        {
          hostId,
        },
      );
    }

    this.inboundFederationHosts.set(hostId, { ...link, routeStream: stream });
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    stream.on('close', () => this.removeInboundFederationHost(hostId));
    readNdjsonLines<unknown>(
      stream,
      (frame) => this.handleFederatedRouteFrame(hostId, frame),
      (error) => this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error }),
    );
    this.writeFederatedRoutes(stream, hostId);
  }

  private async openUpstreamRouteStream(
    session: http2.ClientHttp2Session,
    upstreamId: string,
    localHostId: VerserHostId,
  ): Promise<http2.ClientHttp2Stream> {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/host/federation/routes',
      'x-verser-host-id': localHostId,
    });
    const headers = await this.waitForUpstreamHandshakeResponse(stream, upstreamId);
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
      (frame) => this.handleFederatedRouteFrame(upstreamId, frame),
      (error) => this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error }),
    );
    return stream;
  }

  private async openUpstreamRequestStream(
    session: http2.ClientHttp2Session,
    upstreamId: string,
    localHostId: VerserHostId,
  ): Promise<http2.ClientHttp2Stream> {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/host/federation/request',
      'x-verser-host-id': localHostId,
    });
    const headers = await this.waitForUpstreamHandshakeResponse(stream, upstreamId);
    const statusCode = Number(headers[':status'] ?? 0);
    if (statusCode < 200 || statusCode >= 300) {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      throw createVerserError(
        'upstream-unavailable',
        'Upstream federation request stream rejected',
        {
          upstreamId,
          statusCode,
        },
      );
    }

    return stream;
  }

  private async openUpstreamDispatchRequestStream(
    link: UpstreamLink,
    localHostId: VerserHostId,
  ): Promise<http2.ClientHttp2Stream> {
    const stream = link.session.request({
      ':method': 'POST',
      ':path': '/verser/host/federation/request',
      'x-verser-host-id': localHostId,
      [FEDERATION_REQUEST_STREAM_MODE_HEADER]: 'dispatch',
    });
    const headers = await this.waitForUpstreamHandshakeResponse(stream, link.upstreamId);
    const statusCode = Number(headers[':status'] ?? 0);
    if (statusCode < 200 || statusCode >= 300) {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      throw createVerserError(
        'upstream-unavailable',
        'Upstream federation dispatch request stream rejected',
        {
          upstreamId: link.upstreamId,
          remoteHostId: link.remoteHostId,
          statusCode,
          direction: 'upstream-link',
        },
      );
    }

    return stream;
  }

  private handleHostFederationRequestStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const hostId = String(headers['x-verser-host-id'] ?? '').trim();
    const link = this.inboundFederationHosts.get(hostId);
    if (hostId.length === 0 || link === undefined || link.session !== stream.session) {
      throw createVerserError(
        'disconnected-target',
        'Federated Host request stream is not registered',
        { hostId },
      );
    }

    const mode = String(headers[FEDERATION_REQUEST_STREAM_MODE_HEADER] ?? 'idle');
    if (mode === 'dispatch') {
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
      void this.handleFederatedIncomingRequestStream(stream, hostId);
      return;
    }
    if (mode !== 'idle') {
      throw createVerserError('protocol-error', 'Unknown federated request stream mode', {
        hostId,
        mode,
      });
    }

    this.inboundFederationHosts.set(hostId, { ...link, requestStream: stream, requestBusy: false });
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
    this.resolveNextFederatedRequestStreamWaiter(hostId);
    stream.on('close', () => {
      const current = this.inboundFederationHosts.get(hostId);
      if (current?.requestStream === stream) {
        this.inboundFederationHosts.set(hostId, {
          ...current,
          requestStream: undefined,
          requestBusy: false,
        });
      }
    });
  }

  private async handleUpstreamRequestStream(
    stream: http2.ClientHttp2Stream,
    upstreamId: string,
  ): Promise<void> {
    await this.handleFederatedIncomingRequestStream(stream, upstreamId);
    if (stream.closed) {
      void this.replenishUpstreamRequestStream(upstreamId, stream);
    } else {
      stream.once('close', () => void this.replenishUpstreamRequestStream(upstreamId, stream));
    }
  }

  private async handleFederatedIncomingRequestStream(
    stream: FederationRequestStream,
    peerHostId: string,
  ): Promise<void> {
    let requestId: string | undefined;
    let targetId: string | undefined;
    try {
      const metadata = await readLeaseRequestMetadataFromStream(stream, {
        guestId: this.getFederationHostId(),
        leaseId: peerHostId,
      });
      requestId = metadata.requestId;
      targetId = metadata.targetId;
      const controller = new AbortController();
      const abortForwardedRequest = (): void => controller.abort();
      stream.once('aborted', abortForwardedRequest);
      stream.once('error', abortForwardedRequest);
      const response = await this.routeLocalRequest({
        requestId: metadata.requestId,
        sourceId: metadata.sourceId,
        targetId: metadata.targetId,
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
            headers: flattenVerserHeaders(validateVerserHeaders(response.headers)),
          },
        }),
      );
      response.body.once('error', () => {
        if (!stream.closed) {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        }
      });
      response.body.once('end', () => {
        stream.off('aborted', abortForwardedRequest);
        stream.off('error', abortForwardedRequest);
      });
      response.body.pipe(stream);
    } catch (error) {
      const verserError = toVerserError(error);
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: verserError });
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

  private async replenishUpstreamRequestStream(
    upstreamId: string,
    completedStream: http2.ClientHttp2Stream,
  ): Promise<void> {
    const link = this.upstreamLinks.get(upstreamId);
    if (
      link === undefined ||
      link.closing ||
      link.requestStream !== completedStream ||
      link.session.closed ||
      link.session.destroyed
    ) {
      return;
    }

    try {
      const requestStream = await this.openUpstreamRequestStream(
        link.session,
        upstreamId,
        this.getFederationHostId(),
      );
      link.requestStream = requestStream;
      void this.handleUpstreamRequestStream(requestStream, upstreamId);
    } catch (error) {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      this.handleUpstreamRouteStreamClose(upstreamId);
    }
  }

  private handleFederatedRouteFrame(ownerId: string, frame: unknown): void {
    if (
      typeof frame !== 'object' ||
      frame === null ||
      !('type' in frame) ||
      frame.type !== 'federated-routes' ||
      !('routes' in frame) ||
      !Array.isArray(frame.routes)
    ) {
      throw createVerserError('protocol-error', 'Invalid federated routes control frame', {
        ownerId,
      });
    }
    this.setImportedFederatedRoutes(ownerId, frame.routes as FederatedRouteRegistration[]);
  }

  private advertiseFederatedRoutes(): void {
    for (const link of this.upstreamLinks.values()) {
      if (!link.routeStream.closed) {
        this.writeFederatedRoutes(link.routeStream, link.remoteHostId);
      }
    }
    for (const link of this.inboundFederationHosts.values()) {
      if (link.routeStream !== undefined && !link.routeStream.closed) {
        this.writeFederatedRoutes(link.routeStream, link.hostId);
      }
    }
  }

  private writeFederatedRoutes(
    stream: http2.ClientHttp2Stream | http2.ServerHttp2Stream,
    peerHostId: string,
  ): void {
    stream.write(
      encodeJsonLine(
        createFederatedRoutesControlFrame(
          this.routeRegistry.getFederatedRoutesForExport(peerHostId),
        ),
      ),
    );
  }

  private async authorizeHostFederation(
    stream: http2.ServerHttp2Stream,
    handshake: VerserHostFederationHandshake,
  ): Promise<boolean> {
    const callback = this.options.tls?.clientAuth?.authorizeFederation;
    if (callback === undefined) {
      return true;
    }

    const session = stream.session;
    if (session === undefined) {
      throw createVerserError('protocol-error', 'Host federation stream has no HTTP/2 session');
    }

    const tlsSocket = session.socket as TLSSocket;
    const action = await callback({
      hostId: handshake.hostId,
      handshake,
      certificate: this.getCertificateIdentity(tlsSocket),
      metadata: {
        authorized: tlsSocket.authorized,
        authorizationError: tlsSocket.authorizationError?.message,
      },
    });

    if (action.action === 'allow') {
      return true;
    }

    const reason = action.reason ?? 'Host federation rejected by policy';
    const error = createVerserError('authorization-denied', reason, { hostId: handshake.hostId });
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, peerId: handshake.hostId, error });
    if (!stream.headersSent && !stream.closed) {
      stream.respond({ ':status': 403, 'content-type': 'application/json' });
    }
    if (!stream.closed) {
      stream.end(JSON.stringify({ status: 'closed', reason }));
    }
    session.close();
    return false;
  }

  private removeInboundFederationHost(hostId: string): void {
    if (!this.inboundFederationHosts.has(hostId)) {
      return;
    }
    this.inboundFederationHosts.delete(hostId);
    this.failFederatedRequestStreamWaiters(hostId, 'Federated Host disconnected');
    this.removeImportedFederatedRoutes(hostId);
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.disconnected, peerId: hostId });
  }

  private failFederatedRequestStreamWaiters(hostId: string, message: string): void {
    const waiters = this.federatedRequestStreamWaiters.get(hostId) ?? [];
    this.federatedRequestStreamWaiters.delete(hostId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(createVerserError('upstream-unavailable', message, { hostId }));
    }
  }

  private async sendUpstreamHandshake(
    session: http2.ClientHttp2Session,
    upstreamId: string,
    localHostId: VerserHostId,
  ): Promise<VerserHostId> {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/host/federation',
      'content-type': 'application/json',
    });
    const response = this.waitForUpstreamHandshakeResponse(stream, upstreamId);
    stream.end(
      JSON.stringify(
        createVerserHostFederationHandshake({
          hostId: localHostId,
          protocolVersion: 1,
          maxHopCount: this.options.maxFederationHopCount,
          importRoutes: true,
          exportRoutes: true,
        }),
      ),
    );

    const [headers, body] = await this.withUpstreamHandshakeTimeout(
      Promise.all([response, readStreamText(stream)]),
      stream,
      upstreamId,
    );
    const statusCode = Number(headers[':status'] ?? 0);
    if (statusCode >= 200 && statusCode < 300) {
      return this.getUpstreamHandshakeHostId(body, upstreamId);
    }

    throw createVerserError('authorization-denied', this.getUpstreamRejectionReason(body), {
      upstreamId,
      statusCode,
    });
  }

  private waitForUpstreamHandshakeResponse(
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

  private withUpstreamHandshakeTimeout<T>(
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

  private getUpstreamRejectionReason(body: string): string {
    try {
      const parsed = JSON.parse(body) as {
        reason?: string;
        status?: string;
        error?: { message?: string };
      };
      return (
        parsed.reason ??
        parsed.error?.message ??
        parsed.status ??
        'Upstream Host federation rejected'
      );
    } catch {
      return body.trim() || 'Upstream Host federation rejected';
    }
  }

  private getUpstreamHandshakeHostId(body: string, upstreamId: string): VerserHostId {
    try {
      const parsed = JSON.parse(body) as { hostId?: unknown };
      if (typeof parsed.hostId === 'string') {
        return createVerserHostId(parsed.hostId);
      }
    } catch (error) {
      throw createVerserError(
        'protocol-error',
        'Upstream federation response has invalid Host ID',
        {
          upstreamId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    throw createVerserError('protocol-error', 'Upstream federation response missing Host ID', {
      upstreamId,
    });
  }

  private handleUpstreamSessionClose(upstreamId: string): void {
    const link = this.upstreamLinks.get(upstreamId);
    if (link === undefined) {
      return;
    }
    this.upstreamLinks.delete(upstreamId);
    this.removeImportedFederatedRoutes(upstreamId);
    this.emitLifecycle({
      name: link.closing ? VERSER_LIFECYCLE_EVENTS.closed : VERSER_LIFECYCLE_EVENTS.disconnected,
      peerId: upstreamId,
    });
  }

  private handleUpstreamRouteStreamClose(upstreamId: string): void {
    const link = this.upstreamLinks.get(upstreamId);
    if (link === undefined) {
      return;
    }
    if (!link.session.closed && !link.session.destroyed) {
      link.session.destroy();
    }
    this.handleUpstreamSessionClose(upstreamId);
  }

  private async closeUpstreamLink(link: UpstreamLink, reason: string): Promise<void> {
    if (!this.upstreamLinks.has(link.upstreamId)) {
      return;
    }
    link.closing = true;
    this.removeImportedFederatedRoutes(link.upstreamId);
    if (!link.routeStream.closed) {
      link.routeStream.close(http2.constants.NGHTTP2_NO_ERROR);
    }
    if (!link.requestStream.closed) {
      link.requestStream.close(http2.constants.NGHTTP2_NO_ERROR);
    }
    link.session.destroy();
    await new Promise<void>((resolve) => {
      if (link.session.closed) {
        resolve();
        return;
      }
      link.session.once('close', () => resolve());
    });
    this.handleUpstreamSessionClose(link.upstreamId);
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
      this.routeRegistry.removeLocalRoutes(peerId);
      this.closeGuestLeases(peerId);
      this.failQueuedLeaseAcquisitions(peerId, reason);
      this.abortLocalRequestsForPeer(peerId);
    }
    if (peer.localBroker !== undefined) {
      closeLocalBrokerState(peer.localBroker, reason);
      this.abortLocalRequestsForPeer(peerId);
    }
    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.disconnected,
      peerId,
      role: peer.role,
      reason,
    });
    if (shouldAdvertiseRoutes) {
      this.advertiseRoutes();
      this.advertiseFederatedRoutes();
    }
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
    const body = toReadableBody(request.body);
    return this.routeLocalRequest({
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
    });
  }

  private async routeLocalRequest(
    request: LocalDispatchRequest,
  ): Promise<VerserLocalBrokerResponse> {
    const target = this.peers.get(request.targetId);
    if (target === undefined || target.role !== 'guest') {
      const forwarded = await this.tryRouteLocalRequestToFederatedHost(request);
      if (forwarded !== undefined) {
        return forwarded;
      }
      throw createVerserError('missing-guest', 'Target Guest is not registered', {
        targetId: request.targetId,
      });
    }

    this.emitLifecycle({
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
    this.trackLocalRequestController(request.sourceId, controller);
    this.trackLocalRequestController(request.targetId, controller);
    let response: VerserLocalBrokerResponse | undefined;
    const untrackController = (): void => {
      request.signal?.removeEventListener('abort', cancelFromUpstream);
      this.untrackLocalRequestController(request.sourceId, controller);
      this.untrackLocalRequestController(request.targetId, controller);
    };
    try {
      response =
        target.transport === 'local'
          ? await this.routeLocalRequestToAttachedGuest(
              { ...request, signal: controller.signal },
              target,
            )
          : await this.routeLocalRequestToH2Guest({ ...request, signal: controller.signal });
      this.emitLifecycle({
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
      this.emitLifecycle({
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

  private async tryRouteLocalRequestToFederatedHost(
    request: LocalDispatchRequest,
  ): Promise<VerserLocalBrokerResponse | undefined> {
    let hadUpstreamCandidate = false;
    for (const candidate of this.routeRegistry.getCandidates(request.targetId)) {
      if (candidate.source !== 'upstream') {
        continue;
      }
      hadUpstreamCandidate = true;
      const acquired = await this.tryAcquireFederatedRequestStream(
        candidate.nextHopHostId,
        request.leaseAcquireTimeoutMs,
      );
      if (acquired === undefined) {
        continue;
      }

      return this.routeLocalRequestOverFederationStream(request, acquired.stream);
    }

    if (hadUpstreamCandidate) {
      throw createVerserError(
        'upstream-unavailable',
        'No federated route candidates are available',
        {
          targetId: request.targetId,
        },
      );
    }

    return undefined;
  }

  private async tryAcquireFederatedRequestStream(
    hostId: string,
    timeoutMs: number,
  ): Promise<AcquiredFederatedRequestStream | undefined> {
    try {
      return await this.acquireFederatedRequestStream(hostId, timeoutMs);
    } catch (error) {
      const verserError = toVerserError(error);
      if (verserError.code === 'upstream-unavailable') {
        return undefined;
      }
      throw verserError;
    }
  }

  private acquireFederatedRequestStream(
    hostId: string,
    timeoutMs: number,
  ): Promise<AcquiredFederatedRequestStream> {
    const link = this.inboundFederationHosts.get(hostId);
    if (link?.requestStream !== undefined && !link.requestStream.closed && !link.requestBusy) {
      this.inboundFederationHosts.set(hostId, { ...link, requestBusy: true });
      return Promise.resolve({ stream: link.requestStream, via: 'inbound-federation', hostId });
    }

    const upstreamLink = [...this.upstreamLinks.values()].find(
      (candidate) =>
        candidate.remoteHostId === hostId &&
        !candidate.closing &&
        !candidate.session.closed &&
        !candidate.session.destroyed,
    );
    if (upstreamLink !== undefined) {
      return this.openUpstreamDispatchRequestStream(upstreamLink, this.getFederationHostId()).then(
        (stream) => ({ stream, via: 'upstream-link', hostId }),
      );
    }

    if (link === undefined) {
      return Promise.reject(
        createVerserError('upstream-unavailable', 'Federated request stream unavailable', {
          hostId,
          direction: 'inbound-or-upstream',
        }),
      );
    }

    return new Promise<AcquiredFederatedRequestStream>((resolve, reject) => {
      const resolveStream = (stream: http2.ServerHttp2Stream): void =>
        resolve({ stream, via: 'inbound-federation', hostId });
      const timeout = setTimeout(() => {
        const waiters = this.federatedRequestStreamWaiters.get(hostId) ?? [];
        const remainingWaiters = waiters.filter((waiter) => waiter.resolve !== resolveStream);
        if (remainingWaiters.length === 0) {
          this.federatedRequestStreamWaiters.delete(hostId);
        } else {
          this.federatedRequestStreamWaiters.set(hostId, remainingWaiters);
        }
        reject(
          createVerserError('upstream-unavailable', 'Federated request stream unavailable', {
            hostId,
          }),
        );
      }, timeoutMs);
      const waiters = this.federatedRequestStreamWaiters.get(hostId) ?? [];
      waiters.push({
        timeout,
        resolve: resolveStream,
        reject,
      });
      this.federatedRequestStreamWaiters.set(hostId, waiters);
    });
  }

  private resolveNextFederatedRequestStreamWaiter(hostId: string): void {
    const waiters = this.federatedRequestStreamWaiters.get(hostId) ?? [];
    const waiter = waiters.shift();
    if (waiter === undefined) {
      return;
    }
    if (waiters.length === 0) {
      this.federatedRequestStreamWaiters.delete(hostId);
    } else {
      this.federatedRequestStreamWaiters.set(hostId, waiters);
    }
    const link = this.inboundFederationHosts.get(hostId);
    if (link?.requestStream === undefined || link.requestStream.closed || link.requestBusy) {
      clearTimeout(waiter.timeout);
      waiter.reject(
        createVerserError('upstream-unavailable', 'Federated request stream unavailable', {
          hostId,
        }),
      );
      return;
    }
    clearTimeout(waiter.timeout);
    this.inboundFederationHosts.set(hostId, { ...link, requestBusy: true });
    waiter.resolve(link.requestStream);
  }

  private async routeLocalRequestOverFederationStream(
    request: LocalDispatchRequest,
    requestStream: FederationRequestStream,
  ): Promise<VerserLocalBrokerResponse> {
    const body = new PassThrough();
    const responsePromise = this.readFederatedResponseMetadata(requestStream, {
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
      headers: flattenVerserHeaders(validateVerserHeaders(metadata.headers)),
      body,
    };
  }

  private routeLocalRequestToAttachedGuest(
    request: LocalDispatchRequest,
    target: RegisteredPeer,
  ): Promise<VerserLocalBrokerResponse> {
    if (target.localGuest === undefined) {
      return Promise.reject(
        createVerserError('disconnected-target', 'Target local Guest is not attached', {
          targetId: request.targetId,
        }),
      );
    }

    return dispatchLocalGuestRequest(request, target.localGuest.listener);
  }

  private async readFederatedResponseMetadata(
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

    throw createVerserError(
      'protocol-error',
      'Federated request returned a non-response envelope',
      {
        targetId: options.targetId,
        requestId: options.requestId,
      },
    );
  }

  private async routeLocalRequestToH2Guest(
    request: LocalDispatchRequest,
  ): Promise<VerserLocalBrokerResponse> {
    const lease = await this.acquireLease(
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
        headers: flattenVerserHeaders(validateVerserHeaders(metadata.headers)),
        body: lease.stream,
      };
    } finally {
      request.signal?.removeEventListener('abort', cancelLease);
    }
  }

  private trackLocalRequestController(peerId: VerserPeerId, controller: AbortController): void {
    const controllers = this.activeLocalRequests.get(peerId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeLocalRequests.set(peerId, controllers);
  }

  private untrackLocalRequestController(peerId: VerserPeerId, controller: AbortController): void {
    const controllers = this.activeLocalRequests.get(peerId);
    if (controllers === undefined) {
      return;
    }
    controllers.delete(controller);
    if (controllers.size === 0) {
      this.activeLocalRequests.delete(peerId);
    }
  }

  private abortLocalRequestsForPeer(peerId: VerserPeerId): void {
    const controllers = this.activeLocalRequests.get(peerId);
    if (controllers === undefined) {
      return;
    }
    for (const controller of controllers) {
      controller.abort();
    }
    this.activeLocalRequests.delete(peerId);
  }

  private abortAllLocalRequests(): void {
    for (const peerId of [...this.activeLocalRequests.keys()]) {
      this.abortLocalRequestsForPeer(peerId);
    }
  }

  private advertiseRoutes(): void {
    const routes = this.getRoutedDomains();
    for (const peer of this.peers.values()) {
      if (peer.role === 'broker' && peer.transport === 'local' && peer.localBroker !== undefined) {
        updateLocalBrokerRoutes(peer.localBroker, routes);
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
      if (await this.tryRouteH2BrokerRequestToFederatedHost(stream, headers, requestId, targetId)) {
        return;
      }
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

  private async tryRouteH2BrokerRequestToFederatedHost(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    requestId: string,
    targetId: string,
  ): Promise<boolean> {
    let hadUpstreamCandidate = false;
    for (const candidate of this.routeRegistry.getCandidates(targetId)) {
      if (candidate.source !== 'upstream') {
        continue;
      }
      hadUpstreamCandidate = true;
      const acquired = await this.tryAcquireFederatedRequestStream(
        candidate.nextHopHostId,
        parseLeaseAcquireTimeoutMs(headers),
      );
      if (acquired === undefined) {
        continue;
      }

      await this.routeH2BrokerRequestOverFederationStream(
        stream,
        headers,
        acquired.stream,
        requestId,
        targetId,
      );
      return true;
    }

    if (hadUpstreamCandidate) {
      throw createVerserError(
        'upstream-unavailable',
        'No federated route candidates are available',
        {
          targetId,
        },
      );
    }

    return false;
  }

  private async routeH2BrokerRequestOverFederationStream(
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
    const responsePromise = this.readFederatedResponseMetadata(requestStream, {
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
        ...validateVerserHeaders(responseMetadata.headers),
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

  private async routeH2BrokerRequestToLocalGuest(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    requestId: string,
    targetId: VerserPeerId,
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
        leaseAcquireTimeoutMs: parseLeaseAcquireTimeoutMs(headers),
        signal: controller.signal,
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
      stream.once('finish', () => {
        completed = true;
        cleanupCancellation();
      });
    } catch (error) {
      cleanupCancellation();
      throw error;
    }
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
        this.routeRegistry.removeLocalRoutes(peerId);
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
      this.advertiseFederatedRoutes();
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

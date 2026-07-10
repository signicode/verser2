import { EventEmitter } from 'node:events';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import { text as readStreamText } from 'node:stream/consumers';
import type { TLSSocket } from 'node:tls';

import {
  DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS,
  type FederatedRouteRegistration,
  type RoutedDomainRegistration,
  VERSER_GUEST_REVOCATION_PATH,
  VERSER_LIFECYCLE_EVENTS,
  type VerserBrokerRouteLifecycleControlFrame,
  type VerserCertificateIdentity,
  type VerserError,
  type VerserGuestRevocationRequest,
  type VerserHostFederationHandshake,
  type VerserHostId,
  type VerserPeerId,
  type VerserPeerRole,
  type VerserRegistrationAuthorizationContext,
  type VerserRegistrationRequest,
  type VerserRegistrationResponse,
  type VerserRouteLifecycleEvent,
  createBrokerRouteLifecycleControlFrame,
  createBrokerRoutesControlFrame,
  createGuestRevocationRequest,
  createGuestRevocationResponse,
  createPeerId,
  createRouteLifecycleEvent,
  createRoutedDomainRegistration,
  createVerserError,
  createVerserHostFederationHandshake,
  createVerserHostId,
  encodeJsonLine,
  extractCertificateIdentity,
  normalizeClientTlsOptions,
  normalizeHostClientAuthTlsOptions,
  normalizeServerTlsOptions,
  parseRegistrationRequest,
  readNdjsonLines,
} from '@signicode/verser-common';
import {
  type BrokerRoutingCallbacks,
  routeBrokerRequest as routeBrokerRequestModule,
  routeLocalBrokerRequest as routeLocalBrokerRequestModule,
  routeLocalRequestDispatch as routeLocalRequestDispatchModule,
} from './broker-routing';
import { DegradedRouteCleanup, type DegradedRouteCleanupCallbacks } from './degraded-route-cleanup';
import type { FederatedRouteFrameCallbacks } from './federation';
import * as federation from './federation';
import { sendError, writeJsonLine } from './http2-io';
import { type GuestLeaseStream, LeasePool } from './lease-pool';
import {
  type LocalBrokerState,
  type LocalDispatchRequest,
  type LocalGuestState,
  closeLocalBrokerState,
  createLocalBrokerState,
  emitLocalBrokerRouteChange,
  extractLocalGuestListener,
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

interface FederatedRequestStreamWaiter {
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (stream: http2.ServerHttp2Stream) => void;
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
 * - Handles only the Verser protocol paths (`/verser/register`,
 *   `/verser/guest/control`, `/verser/guest/lease`, `/verser/request`,
 *   `/verser/host/federation`, `/verser/host/federation/routes`,
 *   `/verser/host/federation/request`, and
 *   `/verser/host/federation/dispatch-request`).
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

  private readonly lifecycle = new EventEmitter({ captureRejections: true });

  private readonly peers = new Map<VerserPeerId, RegisteredPeer>();

  private readonly sessions = new Set<http2.ServerHttp2Session>();

  private readonly leasePool = new LeasePool();

  private readonly routeRegistry: HostRouteRegistry;

  private readonly degradedCleanup: DegradedRouteCleanup;

  private readonly activeLocalRequests = new Map<VerserPeerId, Set<AbortController>>();

  private readonly upstreamLinks = new Map<string, UpstreamLink>();

  private readonly pendingUpstreamConnections = new Set<string>();

  private readonly inboundFederationHosts = new Map<string, InboundFederationLink>();

  private readonly federatedRequestStreamWaiters = new Map<
    string,
    FederatedRequestStreamWaiter[]
  >();

  private server?: http2.Http2SecureServer;

  /**
   * Monotonically increasing counter for tagging federated lifecycle events.
   * Combined with the local hostId to form a globally unique event ID for
   * loop detection.
   */
  private federationLifecycleEventIdCounter = 0;

  /** Set of seen federated lifecycle event IDs to prevent loops in cyclic topologies. */
  private readonly seenFederationLifecycleEventIds = new Set<string>();

  public constructor(options: VerserHostOptions) {
    this.options = options;
    this.routeRegistry = createHostRouteRegistry(options);
    this.degradedCleanup = new DegradedRouteCleanup(
      this.options.degradedRouteTimeoutMs ?? DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS,
      this.createDegradedCleanupCallbacks(),
    );
  }

  /**
   * Builds the callbacks object for {@link DegradedRouteCleanup}.
   * Passed by reference so the Host retains coordination of route registry
   * mutation, route advertisements, and lifecycle emission.
   */
  private createDegradedCleanupCallbacks(): DegradedRouteCleanupCallbacks {
    return {
      removeExpiredDegradedRoutes: (now, timeoutMs) =>
        this.routeRegistry.removeExpiredDegradedRoutes(now, timeoutMs),
      hasAnyDegradedRoutes: () => this.routeRegistry.hasAnyDegradedRoutes(),
      getDegradedPeerIds: () => [...this.routeRegistry.getDegradedEntries().keys()],
      getDegradedBrokerRoutesForPeer: (peerId) =>
        this.routeRegistry.getDegradedBrokerRoutesForPeer(peerId),
      getRouteGeneration: (peerId, domain) => this.routeRegistry.getRouteGeneration(peerId, domain),
      advertiseRouteLifecycleEvents: (events) => this.advertiseRouteLifecycleEvents(events),
      advertiseRoutes: () => this.advertiseRoutes(),
      advertiseFederatedRoutes: () => this.advertiseFederatedRoutes(),
    };
  }

  /**
   * Builds the callbacks object for {@link BrokerRoutingCallbacks}.
   * Passed by reference so routing functions can access Host-owned state
   * without importing the Host class.
   */
  private getBrokerRoutingCallbacks(): BrokerRoutingCallbacks {
    return {
      getPeer: (id) => {
        const peer = this.peers.get(id);
        if (peer === undefined) return undefined;
        return {
          role: peer.role,
          transport: peer.transport,
          localGuest: peer.localGuest,
        };
      },
      emitLifecycle: (event) => this.emitLifecycle(event),
      getRouteCandidates: (targetId) => this.routeRegistry.getCandidates(targetId),
      tryAcquireLease: (guestId, requestId, timeoutMs) =>
        this.leasePool.tryAcquireLease(guestId, requestId, timeoutMs),
      acquireLease: (guestId, requestId, timeoutMs) =>
        this.leasePool.acquireLease(guestId, requestId, timeoutMs),
      tryAcquireFederatedRequestStream: (hostId, timeoutMs) =>
        this.tryAcquireFederatedRequestStream(hostId, timeoutMs),
      trackController: (peerId, controller) => this.trackLocalRequestController(peerId, controller),
      untrackController: (peerId, controller) =>
        this.untrackLocalRequestController(peerId, controller),
    };
  }

  /**
   * Builds the callbacks object for {@link FederatedRouteFrameCallbacks}.
   * Passed by reference so the Host retains coordination of route registry
   * mutations, lifecycle emission, and forwarding.
   */
  private getFederatedRouteFrameCallbacks(): FederatedRouteFrameCallbacks {
    return {
      setImportedRoutes: (ownerId, routes) => this.setImportedFederatedRoutes(ownerId, routes),
      advertiseRouteLifecycleEvents: (events, skipFederation) =>
        this.advertiseRouteLifecycleEvents(events, skipFederation),
      forwardLifecycleEventsExcluding: (excludedOwnerId, frame) =>
        this.forwardFederationEventsToPeers(excludedOwnerId, frame),
      removeImportedRoute: (ownerId, targetId, domain) =>
        this.routeRegistry.removeImportedRoute(ownerId, targetId, domain),
    };
  }

  /**
   * Forwards a lifecycle control frame to all federated peers except the
   * excluded owner. Tags the frame for loop detection if it does not already
   * carry an event ID.
   */
  private forwardFederationEventsToPeers(
    excludedOwnerId: string,
    frame: VerserBrokerRouteLifecycleControlFrame,
  ): void {
    let jsonLine: string;
    if ((frame as { _eid?: string })._eid === undefined) {
      const { taggedFrame, nextCounter } = federation.tagFederatedLifecycleFrame(
        frame,
        this.options.hostId ?? 'host',
        this.seenFederationLifecycleEventIds,
        this.federationLifecycleEventIdCounter,
      );
      this.federationLifecycleEventIdCounter = nextCounter;
      jsonLine = encodeJsonLine(taggedFrame).toString();
    } else {
      jsonLine = encodeJsonLine(frame).toString();
    }
    federation.forwardFederatedLifecycleEventsExcluding(
      excludedOwnerId,
      jsonLine,
      this.upstreamLinks.values(),
      this.inboundFederationHosts.values(),
    );
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
  public get address(): AddressInfo {
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
    this.stopDegradedRouteCleanupTimer();
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

    this.leasePool.closeAllLeases();
    this.leasePool.failAllQueuedLeaseAcquisitions(reason);
    this.failAllFederatedRequestStreamWaiters(`Host closing: ${reason}`);

    for (const link of this.inboundFederationHosts.values()) {
      link.routeStream?.close(http2.constants.NGHTTP2_NO_ERROR);
      link.requestStream?.close(http2.constants.NGHTTP2_NO_ERROR);
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

    const newDomains = options.routedDomains ?? [];
    const degradedDomains = this.routeRegistry.getDegradedBrokerRoutesForPeer(peerId);
    const hasDegraded = degradedDomains.length > 0;

    if (hasDegraded) {
      // Re-attachment after degradation: compute diff between old degraded
      // state and new registration state, emit consistent lifecycle events.
      const newDomainSet = new Set(newDomains);
      const oldDegradedSet = new Set(degradedDomains.map((r) => r.domain));

      // Domains present in degraded but absent from new registration: remove
      const removedDegraded: string[] = [];
      // Domains present in new registration but absent from degraded: add
      const addedNew: string[] = [];

      for (const domain of oldDegradedSet) {
        if (!newDomainSet.has(domain as string)) {
          removedDegraded.push(domain as string);
        }
      }
      for (const domain of newDomainSet) {
        if (!oldDegradedSet.has(domain as string)) {
          addedNew.push(domain as string);
        }
      }

      // Clear degraded state and apply the authoritative new domain list
      this.routeRegistry.restoreRoutes(peerId);
      if (newDomains.length > 0) {
        this.routeRegistry.removeLocalRoutes(peerId);
        this.routeRegistry.setLocalRoutes(
          peerId,
          newDomains.map((domain: string) =>
            createRoutedDomainRegistration({ targetId: peerId, domain }),
          ),
        );
      } else {
        this.routeRegistry.removeLocalRoutes(peerId);
      }

      // Stop the degraded cleanup timer if no degraded routes remain
      if (!this.routeRegistry.hasAnyDegradedRoutes()) {
        this.stopDegradedRouteCleanupTimer();
      }

      // Emit lifecycle events consistent with actual changes
      const lifecycleEvents: VerserRouteLifecycleEvent[] = [];

      for (const domain of removedDegraded) {
        lifecycleEvents.push(
          createRouteLifecycleEvent({
            type: 'removed',
            targetId: peerId,
            domain,
            reason: 'reconnected',
          }),
        );
      }

      for (const domain of oldDegradedSet) {
        if (newDomainSet.has(domain)) {
          // Domain was degraded and is now restored
          lifecycleEvents.push(
            createRouteLifecycleEvent({
              type: 'changed',
              targetId: peerId,
              domain,
              reason: 'restored',
              generation: this.routeRegistry.getRouteGeneration(peerId, domain),
            }),
          );
        }
      }

      for (const domain of addedNew) {
        lifecycleEvents.push(
          createRouteLifecycleEvent({
            type: 'added',
            targetId: peerId,
            domain,
            reason: 'registered',
          }),
        );
      }

      if (lifecycleEvents.length > 0) {
        this.advertiseRouteLifecycleEvents(lifecycleEvents);
      }

      this.emitLifecycle({
        name: VERSER_LIFECYCLE_EVENTS.routeRestored,
        peerId,
        role: 'guest',
        reason: 'local-guest-reconnect',
      });
    } else {
      // Fresh registration — standard route setup
      this.routeRegistry.setLocalRoutes(
        peerId,
        newDomains.map((domain: string) =>
          createRoutedDomainRegistration({ targetId: peerId, domain }),
        ),
      );

      // Emit lifecycle events for newly added routes
      if (newDomains.length > 0) {
        const addedEvents = newDomains.map((domain) =>
          createRouteLifecycleEvent({
            type: 'added',
            targetId: peerId,
            domain,
            reason: 'registered',
          }),
        );
        this.advertiseRouteLifecycleEvents(addedEvents);
      }
    }

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
      revokeRoutes: (domains: string[]) => {
        if (closed) {
          return { revoked: [], notFound: [...domains] };
        }
        const result = this.routeRegistry.revokeRoutes(peerId, domains);
        if (result.revoked.length > 0) {
          const revokedEvents = result.revoked.map((domain) =>
            createRouteLifecycleEvent({
              type: 'removed',
              targetId: peerId,
              domain,
              reason: 'revoked',
            }),
          );
          this.advertiseRouteLifecycleEvents(revokedEvents);
          this.advertiseRoutes();
          this.advertiseFederatedRoutes();
        }
        return result;
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
      onRouteChange: (listener: (event: VerserRouteLifecycleEvent) => void) => {
        localBroker.routeChangeEmitter.on('route-change', listener);
        return () => {
          localBroker.routeChangeEmitter.off('route-change', listener);
        };
      },
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

    if (path === VERSER_GUEST_REVOCATION_PATH) {
      await this.handleGuestRevocation(stream, headers);
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

    if (path === federation.FEDERATION_DISPATCH_REQUEST_PATH) {
      this.handleHostFederationDispatchRequestStream(stream, headers);
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
      const degradedDomains = this.routeRegistry.getDegradedBrokerRoutesForPeer(peerId);
      const hasDegraded = degradedDomains.length > 0;
      const newDomains = registration.routedDomains ?? [];

      if (hasDegraded) {
        // The re-registration route list is authoritative: compute the diff
        // between old degraded state and new registration state, then emit
        // consistent lifecycle events.
        const newDomainSet = new Set(newDomains);
        const oldDegradedSet = new Set(degradedDomains.map((r) => r.domain));

        // Domains present in degraded but absent from new registration: remove
        const removedDegraded: string[] = [];
        // Domains present in new registration but absent from degraded: add
        const addedNew: string[] = [];

        for (const domain of oldDegradedSet) {
          if (!newDomainSet.has(domain as string)) {
            removedDegraded.push(domain as string);
          }
        }
        for (const domain of newDomainSet) {
          if (!oldDegradedSet.has(domain as string)) {
            addedNew.push(domain as string);
          }
        }

        // Clear degraded state and apply the authoritative new domain list
        this.routeRegistry.restoreRoutes(peerId);
        if (newDomains.length > 0) {
          this.routeRegistry.removeLocalRoutes(peerId);
          this.routeRegistry.setLocalRoutes(
            peerId,
            newDomains.map((domain: string) =>
              createRoutedDomainRegistration({ targetId: peerId, domain }),
            ),
          );
        } else {
          // Re-registered with empty routedDomains: remove old degraded routes
          this.routeRegistry.removeLocalRoutes(peerId);
        }

        // Stop the degraded cleanup timer if no degraded routes remain
        if (!this.routeRegistry.hasAnyDegradedRoutes()) {
          this.stopDegradedRouteCleanupTimer();
        }

        // Emit lifecycle events consistent with actual changes
        const lifecycleEvents: VerserRouteLifecycleEvent[] = [];

        for (const domain of removedDegraded) {
          lifecycleEvents.push(
            createRouteLifecycleEvent({
              type: 'removed',
              targetId: peerId,
              domain,
              reason: 'reconnected',
            }),
          );
        }

        for (const domain of oldDegradedSet) {
          if (newDomainSet.has(domain)) {
            // Domain was degraded and is now restored
            lifecycleEvents.push(
              createRouteLifecycleEvent({
                type: 'changed',
                targetId: peerId,
                domain,
                reason: 'restored',
              }),
            );
          }
        }

        for (const domain of addedNew) {
          lifecycleEvents.push(
            createRouteLifecycleEvent({
              type: 'added',
              targetId: peerId,
              domain,
              reason: 'registered',
            }),
          );
        }

        if (lifecycleEvents.length > 0) {
          this.advertiseRouteLifecycleEvents(lifecycleEvents);
        }

        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.routeRestored,
          peerId,
          role: 'guest',
          reason: 'guest-reconnect',
        });
      } else {
        // Fresh registration — standard route setup
        this.routeRegistry.setLocalRoutes(
          peerId,
          newDomains.map((domain: string) =>
            createRoutedDomainRegistration({ targetId: peerId, domain }),
          ),
        );
      }
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
      (frame) =>
        federation.handleFederatedRouteFrame(
          hostId,
          frame,
          this.seenFederationLifecycleEventIds,
          this.getFederatedRouteFrameCallbacks(),
        ),
      (error) => this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error }),
    );
    federation.writeFederatedRoutes(stream, hostId, (h) =>
      this.routeRegistry.getFederatedRoutesForExport(h),
    );
  }

  private async openUpstreamRouteStream(
    session: http2.ClientHttp2Session,
    upstreamId: string,
    localHostId: VerserHostId,
  ): Promise<http2.ClientHttp2Stream> {
    const onFrame = (frame: unknown): void =>
      federation.handleFederatedRouteFrame(
        upstreamId,
        frame,
        this.seenFederationLifecycleEventIds,
        this.getFederatedRouteFrameCallbacks(),
      );
    return federation.openUpstreamRouteStream(session, upstreamId, localHostId, {
      onFrame,
      onError: (error) => this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error }),
    });
  }

  private async openUpstreamRequestStream(
    session: http2.ClientHttp2Session,
    upstreamId: string,
    localHostId: VerserHostId,
  ): Promise<http2.ClientHttp2Stream> {
    return federation.openUpstreamRequestStream(session, upstreamId, localHostId);
  }

  private async openUpstreamDispatchRequestStream(
    link: UpstreamLink,
    localHostId: VerserHostId,
  ): Promise<http2.ClientHttp2Stream> {
    return federation.openUpstreamDispatchRequestStream(
      link.session,
      link.upstreamId,
      localHostId,
      { remoteHostId: link.remoteHostId, direction: 'upstream-link' },
    );
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

  private handleHostFederationDispatchRequestStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const hostId = String(headers['x-verser-host-id'] ?? '').trim();
    const link = this.inboundFederationHosts.get(hostId);
    if (hostId.length === 0 || link === undefined || link.session !== stream.session) {
      throw createVerserError(
        'disconnected-target',
        'Federated Host dispatch request stream is not registered',
        { hostId },
      );
    }

    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
    void this.handleFederatedIncomingRequestStream(stream, hostId);
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
    stream: federation.FederationRequestStream,
    peerHostId: string,
  ): Promise<void> {
    const localHostId = this.getFederationHostId();
    return federation.handleFederatedIncomingRequestStream(
      stream,
      peerHostId,
      localHostId,
      (request) => this.routeLocalRequest(request),
      (event) => this.emitLifecycle(event),
    );
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

  private advertiseFederatedRoutes(): void {
    for (const link of this.upstreamLinks.values()) {
      if (!link.routeStream.closed) {
        federation.writeFederatedRoutes(link.routeStream, link.remoteHostId, (h) =>
          this.routeRegistry.getFederatedRoutesForExport(h),
        );
      }
    }
    for (const link of this.inboundFederationHosts.values()) {
      if (link.routeStream !== undefined && !link.routeStream.closed) {
        federation.writeFederatedRoutes(link.routeStream, link.hostId, (h) =>
          this.routeRegistry.getFederatedRoutesForExport(h),
        );
      }
    }
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

  private failAllFederatedRequestStreamWaiters(message: string): void {
    for (const [hostId] of this.federatedRequestStreamWaiters) {
      this.failFederatedRequestStreamWaiters(hostId, message);
    }
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
    return federation.sendUpstreamHandshake(
      session,
      upstreamId,
      localHostId,
      this.options.maxFederationHopCount,
    );
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

    if (peer.role === 'guest') {
      // Move routes to degraded state instead of removing immediately.
      // This matches the remote Guest disconnect behavior.
      this.routeRegistry.setDegraded(peerId);
      this.leasePool.closeGuestLeases(peerId);
      this.leasePool.failQueuedLeaseAcquisitions(peerId, reason);
      this.abortLocalRequestsForPeer(peerId);

      // Emit degraded lifecycle events for local and remote Brokers
      const degradedRoutes = this.routeRegistry.getDegradedBrokerRoutesForPeer(peerId);
      if (degradedRoutes.length > 0) {
        const lifecycleEvents = degradedRoutes.map((r) =>
          createRouteLifecycleEvent({
            type: 'degraded',
            targetId: peerId,
            domain: r.domain,
            reason: 'disconnected',
            generation: this.routeRegistry.getRouteGeneration(peerId, r.domain),
          }),
        );
        this.advertiseRouteLifecycleEvents(lifecycleEvents);

        // Schedule degraded route timeout timer if not already running
        this.startDegradedRouteCleanupTimer();
      }

      this.emitLifecycle({
        name: VERSER_LIFECYCLE_EVENTS.routeDegraded,
        peerId,
        role: peer.role,
        reason,
      });
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

    // Advertise routes after a guest disconnect (degraded routes still visible)
    if (peer.role === 'guest') {
      this.advertiseRoutes();
      this.advertiseFederatedRoutes();
    }
  }

  private routeLocalBrokerRequest(
    sourceId: VerserPeerId,
    broker: LocalBrokerState,
    request: VerserLocalBrokerRequest,
  ): Promise<VerserLocalBrokerResponse> {
    return routeLocalBrokerRequestModule(
      sourceId,
      broker,
      request,
      this.getBrokerRoutingCallbacks(),
    );
  }

  private async routeLocalRequest(
    request: LocalDispatchRequest,
  ): Promise<VerserLocalBrokerResponse> {
    return routeLocalRequestDispatchModule(request, this.getBrokerRoutingCallbacks());
  }

  private async tryAcquireFederatedRequestStream(
    hostId: string,
    timeoutMs: number,
  ): Promise<federation.AcquiredFederatedRequestStream | undefined> {
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
  ): Promise<federation.AcquiredFederatedRequestStream> {
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

    return new Promise<federation.AcquiredFederatedRequestStream>((resolve, reject) => {
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
            direction: 'inbound-federation',
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
          direction: 'inbound-federation',
        }),
      );
      return;
    }
    clearTimeout(waiter.timeout);
    this.inboundFederationHosts.set(hostId, { ...link, requestBusy: true });
    waiter.resolve(link.requestStream);
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

  /**
   * Broadcasts route lifecycle events to all connected Brokers and,
   * unless `skipFederation` is true, to all federated route streams.
   *
   * @param events - The lifecycle events to propagate.
   * @param skipFederation - If true, only local/remote Brokers are notified;
   *   federated peers are skipped. Use when forwarding events **received from**
   *   a federated peer to prevent loops.
   */
  private advertiseRouteLifecycleEvents(
    events: VerserRouteLifecycleEvent[],
    skipFederation = false,
  ): void {
    if (events.length === 0) {
      return;
    }

    const frame = createBrokerRouteLifecycleControlFrame(events);

    // Forward to all registered Brokers (both remote and local)
    for (const peer of this.peers.values()) {
      if (peer.role !== 'broker') {
        continue;
      }

      if (peer.controlStream !== undefined && !peer.controlStream.closed) {
        writeJsonLine(peer.controlStream, frame);
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.routeAdvertised,
          peerId: peer.peerId,
          role: peer.role,
        });
      }

      if (peer.transport === 'local' && peer.localBroker !== undefined) {
        for (const event of events) {
          emitLocalBrokerRouteChange(peer.localBroker, event);
        }
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.routeAdvertised,
          peerId: peer.peerId,
          role: peer.role,
        });
      }
    }

    // Propagate to federated peers unless explicitly skipped (loop prevention).
    // Each outgoing frame is tagged with a unique event ID so that receiving
    // Hosts can detect and discard duplicates in cyclic topologies.
    if (!skipFederation) {
      this.forwardFederationEventsToPeers('', frame);
    }
  }

  private startDegradedRouteCleanupTimer(): void {
    this.degradedCleanup.start();
  }

  private stopDegradedRouteCleanupTimer(): void {
    this.degradedCleanup.stop();
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

  private async handleGuestRevocation(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const peerId = String(headers['x-verser-peer-id'] ?? '').trim();
    const peer = peerId.length > 0 ? this.peers.get(peerId) : undefined;

    // Validate that the requesting peer is a registered Guest
    if (peer === undefined || peer.role !== 'guest') {
      if (!stream.headersSent && !stream.closed) {
        stream.respond({ ':status': 403, 'content-type': 'application/json' });
      }
      if (!stream.closed) {
        stream.end(
          JSON.stringify(
            createGuestRevocationResponse({
              status: 'error',
              message: 'Only registered Guests can revoke routes',
            }),
          ),
        );
      }
      return;
    }

    // Enforce session binding: the requesting stream must belong to the same
    // HTTP/2 session as the registered Guest peer. This prevents a Broker or
    // another Guest on a different session from spoofing a Guest ID and
    // revoking routes they do not own.
    if (peer.transport !== 'h2' || peer.session !== stream.session) {
      if (!stream.headersSent && !stream.closed) {
        stream.respond({ ':status': 403, 'content-type': 'application/json' });
      }
      if (!stream.closed) {
        stream.end(
          JSON.stringify(
            createGuestRevocationResponse({
              status: 'error',
              message: 'Revocation request rejected: session mismatch',
            }),
          ),
        );
      }
      return;
    }

    // Parse the revocation request body
    let revocationRequest: VerserGuestRevocationRequest;
    try {
      const bodyText = await readStreamText(stream);
      const parsed = JSON.parse(bodyText) as { domains?: readonly string[] };
      revocationRequest = createGuestRevocationRequest({
        domains: parsed.domains ?? [],
      });
    } catch (error) {
      if (!stream.headersSent && !stream.closed) {
        stream.respond({ ':status': 400, 'content-type': 'application/json' });
      }
      if (!stream.closed) {
        stream.end(
          JSON.stringify(
            createGuestRevocationResponse({
              status: 'error',
              message: error instanceof Error ? error.message : 'Invalid revocation request',
            }),
          ),
        );
      }
      return;
    }

    // Enforce ownership: Guest can only revoke its own routes
    const result = this.routeRegistry.revokeRoutes(peerId, revocationRequest.domains);

    // Build response
    if (result.revoked.length === revocationRequest.domains.length) {
      // All domains revoked successfully
      if (!stream.headersSent && !stream.closed) {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
      }
      if (!stream.closed) {
        stream.end(JSON.stringify(createGuestRevocationResponse({ status: 'ack' })));
      }
    } else if (result.revoked.length > 0) {
      // Partial success
      const failedDomains = result.notFound.map((domain) => ({
        domain,
        error: 'Domain is not registered for this Guest',
      }));
      if (!stream.headersSent && !stream.closed) {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
      }
      if (!stream.closed) {
        stream.end(
          JSON.stringify(
            createGuestRevocationResponse({
              status: 'partial',
              message: 'Some domains were not found',
              failedDomains,
            }),
          ),
        );
      }
    } else {
      // All domains not found
      if (!stream.headersSent && !stream.closed) {
        stream.respond({ ':status': 404, 'content-type': 'application/json' });
      }
      if (!stream.closed) {
        stream.end(
          JSON.stringify(
            createGuestRevocationResponse({
              status: 'error',
              message: 'None of the requested domains are registered for this Guest',
              failedDomains: result.notFound.map((domain) => ({
                domain,
                error: 'Domain is not registered for this Guest',
              })),
            }),
          ),
        );
      }
      return;
    }

    // Broadcast lifecycle events for revoked routes
    if (result.revoked.length > 0) {
      const events: VerserRouteLifecycleEvent[] = result.revoked.map((domain) =>
        createRouteLifecycleEvent({
          type: 'removed',
          targetId: peerId,
          domain,
          reason: 'revoked',
        }),
      );
      this.advertiseRouteLifecycleEvents(events);
      this.advertiseRoutes();
      this.advertiseFederatedRoutes();
    }
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
    stream.on('close', () => this.leasePool.removeLease(lease));
    stream.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      this.leasePool.removeLease(lease);
    });

    this.leasePool.addIdleLease(lease);
  }

  private async routeBrokerRequest(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    return routeBrokerRequestModule(stream, headers, this.getBrokerRoutingCallbacks());
  }

  private removeSessionPeers(session: http2.ServerHttp2Session): void {
    let shouldAdvertiseRoutes = false;

    for (const [peerId, peer] of this.peers) {
      if (peer.session === session) {
        this.peers.delete(peerId);

        if (peer.role === 'guest') {
          // Move routes to degraded state instead of removing immediately
          this.routeRegistry.setDegraded(peerId);
          this.leasePool.closeGuestLeases(peerId);
          this.leasePool.failQueuedLeaseAcquisitions(peerId, 'guest-disconnect');

          // Emit degraded lifecycle events
          const degradedRoutes = this.routeRegistry.getDegradedBrokerRoutesForPeer(peerId);
          if (degradedRoutes.length > 0) {
            const events: VerserRouteLifecycleEvent[] = degradedRoutes.map((r) =>
              createRouteLifecycleEvent({
                type: 'degraded',
                targetId: peerId,
                domain: r.domain,
                reason: 'disconnected',
                generation: this.routeRegistry.getRouteGeneration(peerId, r.domain),
              }),
            );
            this.advertiseRouteLifecycleEvents(events);

            // Schedule degraded route timeout timer if not already running
            this.startDegradedRouteCleanupTimer();
          }

          this.emitLifecycle({
            name: VERSER_LIFECYCLE_EVENTS.routeDegraded,
            peerId,
            role: peer.role,
            reason: 'guest-disconnect',
          });
        }

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
}

import { EventEmitter } from 'node:events';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import { text as readStreamText } from 'node:stream/consumers';
import type { TLSSocket } from 'node:tls';

import {
  DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS,
  FEDERATION_VWS_PATH,
  FEDERATION_VWS_VERSION,
  type FederatedRouteRegistration,
  type RoutedDomainRegistration,
  VERSER_GUEST_REVOCATION_PATH,
  VERSER_LIFECYCLE_EVENTS,
  VWS_MAX_FRAME_BYTES,
  type VerserBrokerRouteLifecycleControlFrame,
  type VerserCertificateIdentity,
  type VerserError,
  type VerserErrorCode,
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
  createFederationVwsAccept,
  createFederationVwsError,
  createFederationVwsOpen,
  createGuestRevocationRequest,
  createGuestRevocationResponse,
  createPeerId,
  createRouteLifecycleEvent,
  createRoutedDomainRegistration,
  createVerserError,
  createVerserHostFederationHandshake,
  createVerserHostId,
  decodeVwsFrame,
  encodeJsonLine,
  extractCertificateIdentity,
  normalizeClientTlsOptions,
  normalizeHostClientAuthTlsOptions,
  normalizeServerTlsOptions,
  parseRegistrationRequest,
  readNdjsonLines,
  readVwsLine,
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
  vwsStream?: http2.ClientHttp2Stream;
  vwsBusy: boolean;
  closing: boolean;
}

interface InboundFederationLink {
  readonly hostId: string;
  readonly session: http2.Http2Session;
  readonly routeStream?: http2.ServerHttp2Stream;
  readonly requestStream?: http2.ServerHttp2Stream;
  readonly vwsStream?: http2.ServerHttp2Stream;
  readonly vwsBusy?: boolean;
  readonly requestBusy?: boolean;
}

interface FederatedRequestStreamWaiter {
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (stream: http2.ServerHttp2Stream) => void;
  readonly reject: (error: VerserError) => void;
}

interface FederatedVwsPoolWaiter {
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (error?: VerserError) => void;
  readonly reject: (error: VerserError) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
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

  /** Idle WebSocket lease streams keyed by Guest peer ID. */
  private readonly wsIdleLeases = new Map<VerserPeerId, http2.ServerHttp2Stream[]>();

  private static readonly MAX_WS_IDLE_LEASES_PER_GUEST = 4;

  private static readonly MAX_FEDERATION_VWS_WAITERS = 64;

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

  private readonly federatedVwsPoolWaiters = new Map<string, FederatedVwsPoolWaiter[]>();

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
    this.failAllFederationVwsPoolWaiters(`Host closing: ${reason}`);

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
      link = {
        upstreamId,
        remoteHostId,
        session,
        routeStream,
        requestStream,
        vwsBusy: false,
        closing: false,
      };
      this.upstreamLinks.set(upstreamId, link);
      session.once('close', () => this.handleUpstreamSessionClose(upstreamId));
      routeStream.once('close', () => this.handleUpstreamRouteStreamClose(upstreamId));
      void this.handleUpstreamRequestStream(requestStream, upstreamId);
      void this.establishUpstreamVwsPool(link as UpstreamLink);
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

    if (path === FEDERATION_VWS_PATH) {
      await this.handleFederationVwsStream(stream, headers);
      return;
    }

    if (path === '/verser/guest/websocket-lease') {
      this.attachGuestWsLeaseStream(stream, headers);
      return;
    }

    if (path === '/verser/websocket') {
      await this.handleBrokerWebSocket(stream, headers);
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

  private async replenishUpstreamVwsStream(
    upstreamId: string,
    completedStream: http2.ClientHttp2Stream,
  ): Promise<void> {
    const link = this.upstreamLinks.get(upstreamId);
    if (
      link === undefined ||
      link.closing ||
      link.vwsStream !== completedStream ||
      link.session.closed ||
      link.session.destroyed
    ) {
      return;
    }
    try {
      const stream = await federation.openUpstreamFederationVwsStream(
        link.session,
        upstreamId,
        this.getFederationHostId(),
        'acquire',
      );
      link.vwsStream = stream;
      link.vwsBusy = false;
      void this.handleFederationVwsPeerStream(stream, link.remoteHostId);
      stream.once('close', () => void this.replenishUpstreamVwsStream(upstreamId, stream));
    } catch (error) {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    }
  }

  private async establishUpstreamVwsPool(link: UpstreamLink): Promise<void> {
    if (link.closing || link.session.closed || link.session.destroyed) return;
    try {
      const stream = await federation.openUpstreamFederationVwsStream(
        link.session,
        link.upstreamId,
        this.getFederationHostId(),
        'acquire',
      );
      if (link.closing || link.session.closed || link.session.destroyed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        return;
      }
      link.vwsStream = stream;
      link.vwsBusy = false;
      void this.handleFederationVwsPeerStream(stream, link.remoteHostId);
      stream.once('close', () => void this.replenishUpstreamVwsStream(link.upstreamId, stream));
    } catch {
      // VWS is an optional capability. Keep the authenticated HTTP federation
      // link alive; a later WebSocket open reports deterministic negotiation failure.
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
    this.failFederationVwsWaiters(hostId, 'Federated Host disconnected');
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
      // Close/clear WS idle leases for this peer
      this.clearWsIdleLeases(peerId);

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
      const resolveStream = (stream: http2.ServerHttp2Stream): void => {
        const current = this.inboundFederationHosts.get(hostId);
        if (current?.requestStream !== stream || stream.closed) {
          reject(
            createVerserError('upstream-unavailable', 'Federated request stream unavailable', {
              hostId,
              direction: 'inbound-federation',
            }),
          );
          return;
        }
        this.inboundFederationHosts.set(hostId, { ...current, requestBusy: true });
        resolve({ stream, via: 'inbound-federation', hostId });
      };
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

  /**
   * Accepts a Guest WebSocket lease stream and stores it in the idle WS pool.
   *
   * Validates the Guest peer ID, requires the registered peer to be h2
   * transport with the same session, responds with 200, and adds the stream
   * to {@link wsIdleLeases}. Cleans up the lease on stream close/error
   * and on peer disconnect.
   */
  private attachGuestWsLeaseStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const guestId = createPeerId(String(headers['x-verser-peer-id'] ?? ''));
    const peer = this.peers.get(guestId);
    if (peer === undefined || peer.role !== 'guest') {
      throw createVerserError(
        'disconnected-target',
        'Guest WebSocket lease stream has no registered peer',
        { targetId: guestId },
      );
    }

    // Enforce session binding: the lease stream must belong to the same
    // HTTP/2 session as the registered Guest peer.
    if (peer.transport !== 'h2' || peer.session !== stream.session) {
      throw createVerserError(
        'disconnected-target',
        'WebSocket lease stream rejected: session mismatch',
        { targetId: guestId },
      );
    }

    const leases = this.wsIdleLeases.get(guestId) ?? [];
    if (leases.length >= NodeHttp2VerserHost.MAX_WS_IDLE_LEASES_PER_GUEST) {
      throw createVerserError('timeout', 'Guest WebSocket lease capacity exceeded', {
        targetId: guestId,
        limit: NodeHttp2VerserHost.MAX_WS_IDLE_LEASES_PER_GUEST,
      });
    }
    stream.respond({ ':status': 200 });
    leases.push(stream);
    this.wsIdleLeases.set(guestId, leases);

    const removeLease = (): void => {
      const arr = this.wsIdleLeases.get(guestId);
      if (arr === undefined) {
        return;
      }
      const idx = arr.indexOf(stream);
      if (idx >= 0) {
        arr.splice(idx, 1);
      }
      if (arr.length === 0) {
        this.wsIdleLeases.delete(guestId);
      }
    };
    stream.on('close', removeLease);
    stream.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      removeLease();
    });
  }

  /**
   * Races reading a VWS accept line against a timeout and broker-stream
   * close/error. The first settlement wins; all listeners/timers are
   * cleaned up afterward to prevent leaks.
   */
  private raceVwsAccept(
    wsStream: http2.ServerHttp2Stream,
    brokerStream: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    timeoutMs: number,
    targetId: string,
    domain: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settleOnce = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      // biome-ignore lint/style/useConst: timer must be let so cleanup() can clearTimeout before assignment
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        clearTimeout(timer);
        brokerStream.off('close', onBrokerClose);
        brokerStream.off('error', onBrokerError);
      };

      const onBrokerClose = (): void => {
        settleOnce(() => {
          cleanup();
          reject(
            createVerserError('protocol-error', 'Broker stream closed before WebSocket handshake', {
              targetId,
              domain,
            }),
          );
        });
      };

      const onBrokerError = (): void => {
        settleOnce(() => {
          cleanup();
          reject(
            createVerserError('protocol-error', 'Broker stream error before WebSocket handshake', {
              targetId,
              domain,
            }),
          );
        });
      };

      timer = setTimeout(() => {
        settleOnce(() => {
          cleanup();
          reject(
            createVerserError('timeout', 'WebSocket handshake timed out', {
              targetId,
              domain,
              timeoutMs,
            }),
          );
        });
      }, timeoutMs);

      brokerStream.once('close', onBrokerClose);
      brokerStream.once('error', onBrokerError);

      readVwsLine(wsStream, VWS_MAX_FRAME_BYTES).then(
        (line) => {
          settleOnce(() => {
            cleanup();
            resolve(line);
          });
        },
        (err) => {
          settleOnce(() => {
            cleanup();
            reject(err);
          });
        },
      );
    });
  }

  /**
   * Handles a Broker WebSocket open request at `/verser/websocket`.
   *
   * Validates the target Guest and route/domain through the route registry
   * (revoked, degraded, missing, or federated routes are rejected). Acquires
   * an idle WS lease, sends the VWS/1 `open` frame, waits for an `accept`
   * (or `error`) frame from the Guest, responds to the Broker with the
   * negotiated protocol, and bridges the streams bidirectionally with
   * backpressure until one side closes.
   */
  private async handleBrokerWebSocket(
    brokerStream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const targetId = createPeerId(String(headers['x-verser-target-id'] ?? ''));
    const domain = String(headers['x-verser-domain'] ?? '');
    const protocol = String(headers['x-verser-ws-protocol'] ?? '');
    const wsPath = String(headers['x-verser-ws-path'] ?? '/');
    const sourceId = createPeerId(String(headers['x-verser-source-id'] ?? ''));
    const source = this.peers.get(sourceId);
    if (
      source === undefined ||
      source.role !== 'broker' ||
      source.transport !== 'h2' ||
      source.session !== brokerStream.session
    ) {
      throw createVerserError(
        'authorization-denied',
        'WebSocket source Broker is not authorized for this session',
        {
          sourceId,
        },
      );
    }

    // Validate route/domain ownership and revocation through route registry.
    // getCandidates returns only active (non-degraded, non-revoked) routes;
    // an empty result means the route is missing, degraded, or was revoked.
    const candidates = this.routeRegistry.getCandidates(targetId, domain);
    if (candidates.length === 0) {
      throw createVerserError(
        'missing-guest',
        'Target route is not available (revoked, degraded, or not found)',
        { targetId, domain },
      );
    }

    const openFrame = createFederationVwsOpen({
      sourceId,
      targetId,
      domain,
      path: wsPath,
      ...(protocol.length > 0 ? { protocol } : {}),
      originHostId: this.options.hostId ?? 'host-local',
      viaHostIds: this.options.hostId === undefined ? [] : [this.options.hostId],
      hopCount: 0,
    });
    try {
      const result = await this.routeFederationVws(brokerStream, openFrame, candidates);
      const responseHeaders: http2.OutgoingHttpHeaders = { ':status': 200 };
      if (result.protocol.length > 0) responseHeaders['x-verser-ws-protocol'] = result.protocol;
      brokerStream.respond(responseHeaders);
      this.bridgeWebSocketStreams(brokerStream, result.stream, result.framed);
    } catch (error) {
      if (!brokerStream.headersSent && !brokerStream.closed)
        sendError(brokerStream, toVerserError(error));
    }
  }

  /**
   * Closes and clears all idle WebSocket lease streams for the given peer.
   */
  private clearWsIdleLeases(peerId: string): void {
    const leases = this.wsIdleLeases.get(peerId);
    if (leases !== undefined) {
      for (const stream of leases) {
        if (!stream.closed && !stream.destroyed) {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        }
      }
      this.wsIdleLeases.delete(peerId);
    }
  }

  private async handleFederationVwsStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const hostId = String(headers['x-verser-host-id'] ?? '').trim();
    const link = this.inboundFederationHosts.get(hostId);
    if (link === undefined || link.session !== stream.session) {
      throw createVerserError('authorization-denied', 'Federation VWS source is not authorized', {
        hostId,
      });
    }
    if (Number(headers['x-verser-federation-vws-version'] ?? 0) !== FEDERATION_VWS_VERSION) {
      throw createVerserError('protocol-error', 'Federation VWS protocol version mismatch', {
        hostId,
      });
    }
    if (
      headers['x-verser-federation-vws-mode'] === 'acquire' &&
      link.vwsStream !== undefined &&
      !link.vwsStream.closed &&
      !link.vwsStream.destroyed
    ) {
      stream.respond({ ':status': 409, 'content-type': 'application/json' });
      stream.end(
        JSON.stringify({
          code: 'websocket-negotiation-failed',
          message: 'Duplicate federation VWS acquire stream',
        }),
      );
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    if (headers['x-verser-federation-vws-mode'] === 'acquire') {
      this.inboundFederationHosts.set(hostId, { ...link, vwsStream: stream, vwsBusy: false });
      this.resolveFederationVwsWaiters(hostId);
      stream.once('close', () => {
        const current = this.inboundFederationHosts.get(hostId);
        if (current?.vwsStream === stream) {
          this.inboundFederationHosts.set(hostId, { ...current, vwsStream: undefined });
        }
      });
      return;
    }
    try {
      const frame = decodeVwsFrame(await readVwsLine(stream));
      const federationFrame = frame as unknown as Record<string, unknown>;
      if (federationFrame.type !== 'open' || federationFrame.version !== FEDERATION_VWS_VERSION) {
        throw createVerserError('protocol-error', 'Invalid federation VWS open frame', { hostId });
      }
      const open = createFederationVwsOpen(federationFrame as never);
      this.validateFederationVwsOpen(open, hostId);
      const candidates = this.routeRegistry.getCandidates(open.targetId, open.domain);
      const result = await this.routeFederationVws(stream, open, candidates, hostId);
      stream.write(`${JSON.stringify(createFederationVwsAccept({ protocol: result.protocol }))}\n`);
      this.bridgeWebSocketStreams(stream, result.stream, true);
    } catch (error) {
      if (!stream.closed) {
        const failure = toVerserError(error);
        stream.end(`${JSON.stringify(createFederationVwsError(failure.message, failure.code))}\n`);
      }
    }
  }

  private async handleFederationVwsPeerStream(
    stream: http2.ClientHttp2Stream,
    peerHostId: string,
  ): Promise<void> {
    try {
      const frame = decodeVwsFrame(await readVwsLine(stream)) as unknown as Record<string, unknown>;
      if (frame.type !== 'open' || frame.version !== FEDERATION_VWS_VERSION) {
        throw createVerserError('protocol-error', 'Invalid federation VWS open frame', {
          peerHostId,
        });
      }
      const open = createFederationVwsOpen(frame as never);
      this.validateFederationVwsOpen(open, peerHostId);
      const result = await this.routeFederationVws(
        stream as unknown as http2.ServerHttp2Stream,
        open,
        this.routeRegistry.getCandidates(open.targetId, open.domain),
        peerHostId,
      );
      stream.write(`${JSON.stringify(createFederationVwsAccept({ protocol: result.protocol }))}\n`);
      this.bridgeWebSocketStreams(stream, result.stream, true);
    } catch (error) {
      if (!stream.closed) {
        const failure = toVerserError(error);
        stream.end(`${JSON.stringify(createFederationVwsError(failure.message, failure.code))}\n`);
      }
    }
  }

  private async routeFederationVws(
    sourceStream: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    open: ReturnType<typeof createFederationVwsOpen>,
    candidates: readonly FederatedRouteRegistration[],
    sourceHostId?: string,
  ): Promise<{
    stream: http2.ServerHttp2Stream | http2.ClientHttp2Stream;
    protocol: string;
    framed: boolean;
  }> {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    sourceStream.once('close', cancel);
    sourceStream.once('error', cancel);
    try {
      return await this.routeFederationVwsInternal(
        sourceStream,
        open,
        candidates,
        sourceHostId,
        controller.signal,
      );
    } finally {
      sourceStream.off('close', cancel);
      sourceStream.off('error', cancel);
    }
  }

  private async routeFederationVwsInternal(
    sourceStream: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    open: ReturnType<typeof createFederationVwsOpen>,
    candidates: readonly FederatedRouteRegistration[],
    sourceHostId?: string,
    signal?: AbortSignal,
  ): Promise<{
    stream: http2.ServerHttp2Stream | http2.ClientHttp2Stream;
    protocol: string;
    framed: boolean;
  }> {
    let lastError: unknown;
    for (const candidate of candidates) {
      if (candidate.source !== 'local' && candidate.nextHopHostId === sourceHostId) continue;
      let destination: http2.ServerHttp2Stream | http2.ClientHttp2Stream | undefined;
      try {
        if (candidate.source === 'local') {
          const leases = this.wsIdleLeases.get(candidate.targetId);
          if (leases === undefined || leases.length === 0) {
            throw createVerserError(
              'websocket-negotiation-failed',
              'Advertised WebSocket endpoint is unavailable',
              {
                targetId: candidate.targetId,
              },
            );
          }
          destination = leases.shift() as http2.ServerHttp2Stream;
          if (leases.length === 0) this.wsIdleLeases.delete(candidate.targetId);
        } else {
          const inbound = this.inboundFederationHosts.get(candidate.nextHopHostId);
          if (inbound !== undefined) {
            const reserved = await this.waitForFederationVwsPool(
              candidate.nextHopHostId,
              5000,
              signal,
            );
            destination = reserved.pooled;
          } else {
            const upstream = [...this.upstreamLinks.values()].find(
              (link) =>
                link.remoteHostId === candidate.nextHopHostId &&
                !link.closing &&
                !link.session.closed &&
                !link.session.destroyed,
            );
            if (upstream === undefined) {
              throw createVerserError(
                'websocket-negotiation-failed',
                'Federation VWS next hop is unavailable',
                { nextHopHostId: candidate.nextHopHostId },
              );
            }
            destination = await federation.openUpstreamFederationVwsStream(
              upstream.session,
              upstream.upstreamId,
              this.getFederationHostId(),
              'open',
            );
          }
        }

        const forwardedOpen =
          candidate.source === 'local'
            ? open
            : this.createForwardedFederationVwsOpen(open, candidate.nextHopHostId);
        destination.write(
          `${JSON.stringify(
            candidate.source === 'local'
              ? {
                  type: 'open',
                  domain: forwardedOpen.domain,
                  path: forwardedOpen.path,
                  ...(forwardedOpen.protocol === undefined
                    ? {}
                    : { protocol: forwardedOpen.protocol }),
                }
              : forwardedOpen,
          )}\n`,
        );
        const protocol =
          candidate.source === 'local'
            ? await this.raceVwsAccept(
                destination as http2.ServerHttp2Stream,
                sourceStream,
                30_000,
                open.targetId,
                open.domain,
              ).then((line) => {
                const frame = JSON.parse(line) as {
                  type?: unknown;
                  protocol?: unknown;
                  message?: unknown;
                  code?: unknown;
                };
                if (frame.type === 'error') {
                  throw createVerserError(
                    (typeof frame.code === 'string'
                      ? frame.code
                      : 'protocol-error') as VerserErrorCode,
                    String(frame.message ?? 'WebSocket rejected'),
                  );
                }
                if (
                  frame.type !== 'accept' ||
                  (frame.protocol !== undefined && typeof frame.protocol !== 'string')
                ) {
                  throw createVerserError('protocol-error', 'Malformed VWS accept frame');
                }
                const accepted = frame.protocol ?? '';
                if (accepted !== '' && accepted !== (open.protocol ?? '')) {
                  throw createVerserError(
                    'protocol-error',
                    'Guest accepted an unoffered WebSocket protocol',
                  );
                }
                return accepted;
              })
            : await this.readFederatedVwsNegotiationWithCancellation(
                sourceStream,
                destination,
                open.targetId,
                open.domain,
              );
        return {
          stream: destination,
          protocol: protocol ?? '',
          framed: sourceHostId !== undefined || candidate.source !== 'local',
        };
      } catch (error) {
        lastError = error;
        if (destination !== undefined && !destination.closed)
          destination.close(http2.constants.NGHTTP2_CANCEL);
      }
    }
    throw (
      lastError ??
      createVerserError('missing-guest', 'No WebSocket route candidate is available', {
        targetId: open.targetId,
        domain: open.domain,
      })
    );
  }

  private validateFederationVwsOpen(
    open: ReturnType<typeof createFederationVwsOpen>,
    senderHostId?: string,
  ): void {
    const localHostId = this.getFederationHostId();
    if (open.viaHostIds.length === 0 || open.originHostId !== open.viaHostIds[0]) {
      throw createVerserError('protocol-error', 'Federation VWS origin/via metadata is invalid');
    }
    if (new Set(open.viaHostIds).size !== open.viaHostIds.length) {
      throw createVerserError('route-loop', 'Federation VWS route metadata contains a loop');
    }
    const localIndex = open.viaHostIds.indexOf(localHostId);
    if (
      senderHostId !== undefined &&
      (open.viaHostIds.length < 2 || open.viaHostIds[open.viaHostIds.length - 1] !== localHostId)
    ) {
      throw createVerserError(
        'authorization-denied',
        'Federation VWS destination metadata is not bound to this Host',
      );
    }
    if (localIndex >= 0 && localIndex !== open.viaHostIds.length - 1) {
      throw createVerserError('route-loop', 'Federation VWS route revisits this Host', {
        hostId: localHostId,
      });
    }
    if (
      senderHostId !== undefined &&
      open.viaHostIds.length > 1 &&
      open.viaHostIds[open.viaHostIds.length - 2] !== senderHostId
    ) {
      throw createVerserError(
        'authorization-denied',
        'Federation VWS traversal metadata is not bound to the sender',
      );
    }
    if (open.hopCount !== open.viaHostIds.length - 1) {
      throw createVerserError('protocol-error', 'Federation VWS hop metadata is invalid');
    }
    if (open.hopCount > (this.options.maxFederationHopCount ?? 8)) {
      throw createVerserError('route-loop', 'Federation VWS route exceeds maximum hop count');
    }
  }

  private createForwardedFederationVwsOpen(
    open: ReturnType<typeof createFederationVwsOpen>,
    nextHopHostId: string,
  ): ReturnType<typeof createFederationVwsOpen> {
    this.validateFederationVwsOpen(open);
    return createFederationVwsOpen({
      ...open,
      viaHostIds: [...open.viaHostIds, nextHopHostId],
      hopCount: open.hopCount + 1,
    });
  }

  private async waitForFederationVwsPool(
    hostId: string,
    timeoutMs = 5000,
    signal?: AbortSignal,
  ): Promise<{
    readonly pooled: http2.ServerHttp2Stream;
  }> {
    const available = ():
      | {
          readonly pooled: http2.ServerHttp2Stream;
        }
      | undefined => {
      const inbound = this.inboundFederationHosts.get(hostId);
      if (inbound === undefined) return undefined;
      const pooled = inbound?.vwsStream;
      if (pooled !== undefined && !pooled.closed && !pooled.destroyed && !inbound.vwsBusy) {
        this.inboundFederationHosts.set(hostId, { ...inbound, vwsBusy: true });
        return { pooled };
      }
      return undefined;
    };
    const queued = this.federatedVwsPoolWaiters.get(hostId) ?? [];
    if (queued.length >= NodeHttp2VerserHost.MAX_FEDERATION_VWS_WAITERS) {
      throw createVerserError(
        'websocket-negotiation-failed',
        'Federation VWS acquisition queue is full',
        {
          nextHopHostId: hostId,
        },
      );
    }
    const ready = available();
    if (ready !== undefined) return ready;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: VerserError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const waiters = this.federatedVwsPoolWaiters.get(hostId) ?? [];
        this.federatedVwsPoolWaiters.set(
          hostId,
          waiters.filter((waiter) => waiter.resolve !== resolveReady),
        );
        if (error !== undefined) reject(error);
        else {
          const result = available();
          if (result === undefined) {
            reject(
              createVerserError(
                'websocket-negotiation-failed',
                'Federation VWS next hop is unavailable',
                {
                  nextHopHostId: hostId,
                },
              ),
            );
          } else resolve(result);
        }
      };
      const onAbort = (): void =>
        finish(
          createVerserError('stream-failure', 'Federation VWS acquisition was cancelled', {
            nextHopHostId: hostId,
          }),
        );
      const resolveReady = (error?: VerserError): void => finish(error);
      const timeout = setTimeout(
        () =>
          finish(
            createVerserError(
              'websocket-negotiation-failed',
              'Federation VWS next hop is unavailable',
              {
                nextHopHostId: hostId,
              },
            ),
          ),
        timeoutMs,
      );
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const waiters = this.federatedVwsPoolWaiters.get(hostId) ?? [];
      waiters.push({ timeout, resolve: resolveReady, reject, signal, onAbort });
      this.federatedVwsPoolWaiters.set(hostId, waiters);
    });
  }

  private resolveFederationVwsWaiters(hostId: string, error?: VerserError): void {
    const waiters = this.federatedVwsPoolWaiters.get(hostId) ?? [];
    const waiter = waiters.shift();
    if (waiters.length === 0) this.federatedVwsPoolWaiters.delete(hostId);
    else this.federatedVwsPoolWaiters.set(hostId, waiters);
    waiter?.resolve(error);
  }

  private failFederationVwsWaiters(hostId: string, message: string): void {
    const waiters = this.federatedVwsPoolWaiters.get(hostId) ?? [];
    this.federatedVwsPoolWaiters.delete(hostId);
    const error = createVerserError('upstream-unavailable', message, { hostId });
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.signal?.removeEventListener('abort', waiter.onAbort ?? (() => undefined));
      waiter.reject(error);
    }
  }

  private failAllFederationVwsPoolWaiters(message: string): void {
    const error = createVerserError('upstream-unavailable', message);
    for (const [hostId, waiters] of this.federatedVwsPoolWaiters) {
      this.federatedVwsPoolWaiters.delete(hostId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.signal?.removeEventListener('abort', waiter.onAbort ?? (() => undefined));
        waiter.reject(error);
      }
    }
  }

  private async readFederatedVwsNegotiationWithCancellation(
    sourceStream: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    destination: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    targetId: string,
    domain: string,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    sourceStream.once('close', cancel);
    sourceStream.once('error', cancel);
    try {
      return await federation.readFederationVwsNegotiation(
        destination,
        {
          targetId,
          domain,
        },
        { signal: controller.signal },
      );
    } finally {
      sourceStream.off('close', cancel);
      sourceStream.off('error', cancel);
    }
  }

  /**
   * Bridges two HTTP/2 streams bidirectionally with backpressure.
   *
   * Data from `streamA` is written to `streamB` and vice versa. When
   * `write()` returns `false`, the source stream is paused and resumed
   * on the destination's `drain` event. When either stream closes or
   * errors, both are cleaned up and all listeners are removed.
   */
  private bridgeWebSocketStreams(
    streamA: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    streamB: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    framed = true,
  ): void {
    if (!framed) {
      let rawClosed = false;
      const rawCleanup = (): void => {
        if (rawClosed) return;
        rawClosed = true;
        streamA.off('data', rawAtoB);
        streamB.off('data', rawBtoA);
        if (!streamA.closed) streamA.close(http2.constants.NGHTTP2_NO_ERROR);
        if (!streamB.closed) streamB.close(http2.constants.NGHTTP2_NO_ERROR);
      };
      const rawAtoB = (chunk: Buffer): void => {
        if (streamB.closed || streamB.destroyed) {
          rawCleanup();
          return;
        }
        if (!streamB.write(chunk)) {
          streamA.pause();
          streamB.once('drain', () => {
            if (!rawClosed) streamA.resume();
          });
        }
      };
      const rawBtoA = (chunk: Buffer): void => {
        if (streamA.closed || streamA.destroyed) {
          rawCleanup();
          return;
        }
        if (!streamA.write(chunk)) {
          streamB.pause();
          streamA.once('drain', () => {
            if (!rawClosed) streamB.resume();
          });
        }
      };
      streamA.on('data', rawAtoB);
      streamB.on('data', rawBtoA);
      streamA.once('end', rawCleanup);
      streamB.once('end', rawCleanup);
      streamA.once('error', rawCleanup);
      streamB.once('error', rawCleanup);
      streamA.once('close', rawCleanup);
      streamB.once('close', rawCleanup);
      return;
    }
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (!streamA.closed) streamA.close(http2.constants.NGHTTP2_NO_ERROR);
      if (!streamB.closed) streamB.close(http2.constants.NGHTTP2_NO_ERROR);
    };
    const forward = async (
      source: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
      destination: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
    ): Promise<void> => {
      try {
        while (!closed) {
          const line = await readVwsLine(source, VWS_MAX_FRAME_BYTES);
          const frame = decodeVwsFrame(line);
          if (!destination.write(`${JSON.stringify(frame)}\n`)) {
            await new Promise<void>((resolve) => destination.once('drain', resolve));
          }
        }
      } catch {
        cleanup();
      }
    };
    streamA.once('error', cleanup);
    streamA.once('close', cleanup);
    streamB.once('error', cleanup);
    streamB.once('close', cleanup);
    void forward(streamA, streamB);
    void forward(streamB, streamA);
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
          // Close/clear WS idle leases for this peer
          this.clearWsIdleLeases(peerId);

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

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';

import type {
  VerserPeerRole as CommonVerserPeerRole,
  FederatedRouteRegistration,
  RoutedDomainRegistration,
  VerserClientTlsOptions,
  VerserError,
  VerserFederatedRouteAuthorizationCallback,
  VerserFederatedRouteAuthorizationPair,
  VerserHeaderPair,
  VerserHostTlsOptions,
  VerserRegistrationRequest,
  VerserRouteLifecycleEvent,
  VerserSerializedHeaderMap,
} from '@signicode/verser-common';

/**
 * Configuration options for creating a Verser Host via {@link createVerserHost}.
 *
 * @public
 */
export interface VerserHostOptions {
  /**
   * The port the Host should listen on.
   * Defaults to `0` (OS-assigned ephemeral port).
   */
  readonly port?: number;
  /**
   * The network interface address the Host should bind to.
   * Defaults to `'127.0.0.1'`.
   */
  readonly host?: string;
  /**
   * TLS configuration (required). The Host is a TLS HTTP/2 server and
   * requires server certificate material via `tls.cert`/`tls.key`,
   * `tls.certFile`/`tls.keyFile`, `tls.pfx`, or `tls.pfxFile`.
   * Optional `tls.clientAuth` enables mTLS client certificate authentication.
   * An optional `tls.clientAuth.unauthorizedClientHandler` gates the Verser
   * protocol after TLS, producing one bounded response for a client without a
   * valid certificate instead of rejecting at the transport; the strict mTLS
   * default is unchanged when the handler is absent.
   */
  readonly tls?: VerserHostTlsOptions;
  /**
   * Stable Host identifier used by route-aware Host federation metadata.
   * Defaults to an internal local identifier when no upstream federation behavior is configured.
   */
  readonly hostId?: string;
  /**
   * Maximum accepted Host-to-Host hop count for imported federated routes.
   * Defaults to `8`.
   */
  readonly maxFederationHopCount?: number;
  /**
   * Timeout in milliseconds before degraded/disconnected routes are fully removed.
   * When a Guest disconnects, its routes enter a degraded state. If the same Guest
   * does not reconnect within this period, the routes are fully removed and Brokers
   * are notified via lifecycle events.
   *
   * Defaults to {@link DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS} (5000 ms).
   */
  readonly degradedRouteTimeoutMs?: number;
  /**
   * Hop-local federated route authorization callback.
   *
   * When configured, the Host asks the application to allow or deny each
   * normalized `{ previousAdvertisedDomain, nextSelectedDomain }` pair before
   * forwarding across a federation hop. The callback returns the legacy
   * `'allow'`/`'deny'` strings or an object
   * `{ decision, cacheTtlMs? }` whose `cacheTtlMs` overrides the class TTL
   * for that single result (`0` disables caching for it;
   * `Number.POSITIVE_INFINITY` caches until revoke/lifecycle invalidation;
   * omitted uses the finite Host TTLs below). Explicit allow and deny results
   * are cached (single-flight) until an explicit revoke, a relevant
   * route/import/link mutation, TTL expiry, or Host shutdown invalidates
   * them; callback errors and malformed results are never cached. Once a
   * logical federation request stream or accepted federated VWS connection
   * has been authorized, it keeps that decision for its lifetime — cache
   * changes gate only new forwarding/open decisions. When absent, no route
   * authorization is performed and existing forwarding behavior is
   * unchanged.
   */
  readonly routeAuthorizer?: VerserFederatedRouteAuthorizationCallback;
  /**
   * Positive (allow) authorization-cache TTL in milliseconds. Must be a
   * finite non-negative integer. Defaults to `60000` (60 seconds). `0`
   * disables the allow cache: every new hop decision invokes the callback.
   * Entries expire lazily; no timers are created. Individual callback results
   * may override this TTL via `cacheTtlMs` (the only way an infinite cache
   * entry can exist).
   */
  readonly routeAuthorizationCacheTtlMs?: number;
  /**
   * Negative (deny) authorization-cache TTL in milliseconds. Must be a
   * finite non-negative integer. Defaults to
   * `Math.floor(routeAuthorizationCacheTtlMs / 10)` (`6000` by default).
   * `0` disables the deny cache. Callback errors and malformed results are
   * never cached regardless of this value. Individual callback results may
   * override this TTL via `cacheTtlMs`.
   */
  readonly routeAuthorizationNegativeCacheTtlMs?: number;
}

/**
 * A peer registration request sent to the Host on the `/verser/register` path.
 *
 * Alias for {@link VerserRegistrationRequest} from `@signicode/verser-common`.
 *
 * @public
 */
export type VerserHostRegistrationRequest = VerserRegistrationRequest;

/**
 * Minimal Node-compatible request listener used by local Host-side Guests.
 *
 * @public
 */
export type VerserLocalGuestRequestListener = (
  request: Readable & {
    readonly method: string;
    readonly url: string;
    readonly headers: VerserSerializedHeaderMap;
  },
  response: VerserLocalGuestResponse,
) => void;

/**
 * Minimal Node-compatible response surface used by local Host-side Guests.
 *
 * @public
 */
export interface VerserLocalGuestResponse {
  statusCode: number;
  statusMessage?: string;
  setHeader(
    name: string,
    value: string | number | boolean | readonly (string | number | boolean)[],
  ): this;
  appendHeader(
    name: string,
    value: string | number | boolean | readonly (string | number | boolean)[],
  ): this;
  getHeader(name: string): string | string[] | undefined;
  writeHead(statusCode: number, headers?: ResponseHeaders): this;
  writeHead(statusCode: number, statusMessage?: string, headers?: ResponseHeaders): this;
  write(chunk: string | Buffer, encoding?: BufferEncoding): boolean;
  end(chunk?: string | Buffer, encoding?: BufferEncoding): this;
  flushHeaders(): void;
}

/**
 * Options for attaching an in-process Guest directly to the Host.
 *
 * Local registration authorization receives Host-owned local metadata; caller
 * supplied certificate or metadata values are not accepted by this options
 * object.
 *
 * @public
 */
export interface VerserLocalGuestOptions {
  readonly guestId: string;
  readonly routedDomains?: readonly string[];
  readonly listener: VerserLocalGuestRequestListener | HttpServer;
}

/**
 * Options for attaching an in-process Broker directly to the Host.
 *
 * Local registration authorization receives Host-owned local metadata with no
 * TLS certificate identity.
 *
 * @public
 */
export interface VerserLocalBrokerOptions {
  readonly brokerId: string;
  /**
   * Optional domain persisted with this local Broker's registration,
   * mirroring the remote Broker `brokerDomain` registration field. Local
   * Broker handles are already Host-owned, so this value is exempt from
   * client-certificate DNS SAN matching. It is normalized before storage and
   * omitted when not supplied. The legacy `brokerHopDomain` field is rejected
   * at attachment time, not aliased.
   */
  readonly brokerDomain?: string;
}

/**
 * Options for connecting a Host outbound to an upstream Verser Host.
 *
 * @public
 */
export interface VerserHostUpstreamOptions {
  readonly upstreamId: string;
  readonly url: string;
  readonly tls?: VerserClientTlsOptions;
}

/**
 * Current state summary for an upstream Host link.
 *
 * @public
 */
export interface VerserHostUpstreamStatus {
  readonly upstreamId: string;
  readonly connected: boolean;
}

/**
 * Handle returned for an outbound upstream Host link.
 *
 * @public
 */
export interface VerserHostUpstreamHandle {
  readonly upstreamId: string;
  close(reason?: string): Promise<void>;
}

/**
 * Request shape accepted by an in-process Broker handle.
 *
 * @public
 */
export interface VerserLocalBrokerRequest {
  readonly targetId: string;
  /** Optional advertised route domain selected for the target Guest. */
  readonly routeDomain?: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: readonly Buffer[] | Readable;
  /**
   * Timeout in milliseconds while waiting for an HTTP/2 Guest lease.
   * Defaults to the same 5000 ms used by remote Broker requests.
   */
  readonly leaseAcquireTimeoutMs?: number;
}

/**
 * Response shape returned by an in-process Broker handle.
 *
 * @public
 */
export interface VerserLocalBrokerResponse {
  readonly requestId: string;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly statusText?: string;
  readonly headerPairs?: readonly VerserHeaderPair[];
  readonly body: Readable;
}

type ResponseHeaderValue = string | number | boolean | readonly (string | number | boolean)[];
type ResponseHeaders =
  | Record<string, ResponseHeaderValue>
  | readonly (readonly [string, ResponseHeaderValue])[];

/**
 * Handle returned for an attached in-process Guest.
 *
 * @public
 */
export interface VerserLocalGuestHandle {
  close(reason?: string): Promise<void>;
  /**
   * Revokes a subset of the Guest's advertised route domains.
   *
   * Only domains that are currently registered for this Guest are revoked.
   * Returns the list of successfully revoked domains and any domains that
   * were requested but not found in the Guest's route table.
   *
   * @param domains - The domains to revoke.
   * @returns Object with `revoked` (domains that were removed) and `notFound` (domains not found).
   */
  revokeRoutes(domains: string[]): { revoked: string[]; notFound: string[] };
}

/**
 * Handle returned for an attached in-process Broker.
 *
 * @public
 */
export interface VerserLocalBrokerHandle {
  readonly routedRequestCount: number;
  getRoutes(): RoutedDomainRegistration[];
  waitForRoute(domain: string): Promise<void>;
  request(request: VerserLocalBrokerRequest): Promise<VerserLocalBrokerResponse>;
  /**
   * Registers a route lifecycle change listener.
   *
   * The listener is called whenever the Host notifies this Broker of a route
   * lifecycle event (added, removed, changed, or degraded/restored). The Broker
   * route snapshot (`getRoutes()`) is updated before the listener is called.
   *
   * @param listener - A callback receiving route change events.
   * @returns A function to unsubscribe the listener.
   */
  onRouteChange(listener: (event: VerserRouteLifecycleEvent) => void): () => void;
  close(reason?: string): Promise<void>;
}

/**
 * A lifecycle event emitted by the Verser Host.
 *
 * Events include connection/disconnection, registration, route advertisement,
 * request start/complete, errors, and full shutdown. Use {@link VerserHost.onLifecycle}
 * to subscribe.
 *
 * @public
 */
export interface VerserHostLifecycleEvent {
  /** The event name from the {@link VERSER_LIFECYCLE_EVENTS} set. */
  readonly name: string;
  /** The Peer ID associated with this event, if applicable. */
  readonly peerId?: string;
  /** The Peer's role, if applicable. */
  readonly role?: CommonVerserPeerRole;
  /** A human-readable reason for the event (e.g. close reason). */
  readonly reason?: string;
  /** An error associated with the event, if applicable. */
  readonly error?: VerserError;
}

/**
 * The public API of a Verser Host.
 *
 * A Host is a TLS HTTP/2 server that:
 * - Accepts outbound connections from Guests and Brokers.
 * - Handles peer registration at `/verser/register`.
 * - Maintains Guest control streams at `/verser/guest/control`.
 * - Manages Guest lease streams at `/verser/guest/lease` for request forwarding.
 * - Routes Broker requests at `/verser/request` to the target Guest.
 * - Advertises route changes to Brokers via NDJSON control frames.
 * - Can attach colocated in-process local Guests and Brokers without opening a
 *   TLS HTTP/2 peer connection.
 *
 * **Only protocol paths** `/verser/register`, `/verser/guest/control`,
 * `/verser/guest/lease`, `/verser/guest/websocket-lease`, `/verser/request`,
 * `/verser/websocket`, `/verser/host/federation`,
 * `/verser/host/federation/routes`, `/verser/host/federation/request`,
 * `/verser/host/federation/dispatch-request`, and
 * `/verser/host/federation/websocket` are supported.
 *
 * @remarks
 * - The Host requires TLS for remote peer connections. Local peers bypass TLS
 *   because they are attached in-process.
 * - Route matching uses exact hostname equality — no wildcard or suffix matching.
 * - The Host supports explicit VWS/1 framed WebSockets over existing TLS HTTP/2,
 *   including authenticated federation-VWS forwarding for imported routes.
 *   Generic HTTP upgrade, CONNECT/RFC8441, L4 forwarding, trailers, and
 *   informational response forwarding are unsupported.
 * - Registration authorization via `tls.clientAuth.authorizeRegistration` is a
 *   registration-time mTLS hook only — not a complete per-request authentication
 *   or authorization gateway.
 * - TLS sessions served only by `tls.clientAuth.unauthorizedClientHandler` are
 *   not registered peers: they produce no lifecycle events and are closed
 *   after the one bounded response.
 *
 * @public
 */
export interface VerserHost {
  /** Whether the Host is currently listening. */
  readonly running: boolean;
  /**
   * The bound address information (IP, port, family).
   * @throws {VerserError} If accessed before the Host is listening.
   */
  readonly address: AddressInfo;
  /**
   * Starts the Host: binds to the configured port and host, begins accepting
   * TLS HTTP/2 peer connections.
   */
  start(): Promise<void>;
  /**
   * Gracefully shuts down the Host.
   *
   * Closes all peer control streams, lease streams, and HTTP/2 sessions, then
   * closes the server socket. Emits a `'closed'` lifecycle event on completion.
   *
   * @param reason - Optional close reason (default `'host-close'`).
   */
  close(reason?: string): Promise<void>;
  /**
   * Reloads the Host TLS certificate material while the server is running.
   *
   * Uses `server.setSecureContext()` to update the certificate in-place without
   * dropping existing connections.
   *
   * @throws {Error} If the Host is not running.
   */
  reloadTlsCertificate(): void;
  /**
   * Returns the current set of registered Guest routed domains.
   *
   * @returns The current route table.
   */
  getRoutedDomains(): RoutedDomainRegistration[];
  /**
   * Replaces the imported federated route candidates learned from one upstream Host.
   *
   * @internal Foundation seam used by Host federation link handling.
   */
  setImportedFederatedRoutes(
    upstreamId: string,
    routes: readonly FederatedRouteRegistration[],
  ): VerserError[];
  /**
   * Removes all imported federated route candidates learned from one upstream Host.
   *
   * @internal Foundation seam used by Host federation link cleanup.
   */
  removeImportedFederatedRoutes(upstreamId: string): void;
  /**
   * Returns route candidates currently known for a route identity or for all identities.
   *
   * @internal Foundation seam used by Host federation route selection tests and later forwarding phases.
   */
  getFederatedRouteCandidates(targetId?: string, domain?: string): FederatedRouteRegistration[];
  /**
   * Explicitly revokes the cached allow for one hop-local federated route
   * pair and abandons any in-flight decision for it.
   *
   * Both domains are normalized before matching. Returns `true` when a
   * cached allow or pending decision was revoked, `false` when nothing was
   * cached for the pair (including when no `routeAuthorizer` is configured).
   */
  revokeRouteAuthorization(pair: VerserFederatedRouteAuthorizationPair): boolean;
  /** Connects this Host outbound to an upstream Verser Host. */
  connectUpstream(options: VerserHostUpstreamOptions): Promise<VerserHostUpstreamHandle>;
  /** Returns currently connected upstream Host links. */
  getUpstreams(): VerserHostUpstreamStatus[];
  /** Attaches an in-process local Guest without opening a TLS HTTP/2 connection. */
  attachLocalGuest(options: VerserLocalGuestOptions): Promise<VerserLocalGuestHandle>;
  /** Attaches an in-process local Broker without opening a TLS HTTP/2 connection. */
  attachLocalBroker(options: VerserLocalBrokerOptions): Promise<VerserLocalBrokerHandle>;
  /**
   * Subscribes to Host lifecycle events.
   *
   * @param listener - A callback receiving lifecycle events.
   * @returns A function to unsubscribe the listener.
   */
  onLifecycle(listener: (event: VerserHostLifecycleEvent) => void): () => void;
}

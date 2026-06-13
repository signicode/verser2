import type { AddressInfo } from 'node:net';

import type {
  VerserPeerRole as CommonVerserPeerRole,
  RoutedDomainRegistration,
  VerserError,
  VerserHostTlsOptions,
  VerserRegistrationRequest,
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
   */
  readonly tls?: VerserHostTlsOptions;
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
 *
 * **Only protocol paths** `/verser/register`, `/verser/guest/control`,
 * `/verser/guest/lease`, and `/verser/request` are supported.
 *
 * @remarks
 * - The Host requires TLS and only supports TLS HTTP/2 connections.
 * - Route matching uses exact hostname equality — no wildcard or suffix matching.
 * - The Host does **not** implement WebSocket, HTTP upgrade, CONNECT tunneling,
 *   trailers, or informational response forwarding.
 * - Registration authorization via `tls.clientAuth.authorizeRegistration` is a
 *   registration-time mTLS hook only — not a complete per-request authentication
 *   or authorization gateway.
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
   * Subscribes to Host lifecycle events.
   *
   * @param listener - A callback receiving lifecycle events.
   * @returns A function to unsubscribe the listener.
   */
  onLifecycle(listener: (event: VerserHostLifecycleEvent) => void): () => void;
}

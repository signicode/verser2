/**
 * @module @signicode/verser2-host
 *
 * Verser Host — a TLS HTTP/2 server that connects Guests and Brokers.
 *
 * ## Overview
 *
 * The Host accepts **outbound** TLS HTTP/2 connections from:
 * - **Guests** — peers that register route domains and receive forwarded HTTP
 *   requests via lease streams.
 * - **Brokers** — peers that discover advertised routes and send requests to
 *   Guests through the Host.
 *
 * ## Protocol paths
 *
 * Only the following paths are handled:
 * - `/verser/register` — peer registration (role `guest` or `broker`).
 * - `/verser/guest/control` — Guest control stream for coordination.
 * - `/verser/guest/lease` — Guest lease stream for request/response bodies.
 * - `/verser/request` — Broker request dispatch to target Guests.
 * - `/verser/host/federation` — Host-to-Host federation handshake.
 * - `/verser/host/federation/routes` — Host-to-Host federated route stream.
 * - `/verser/host/federation/request` — Host-to-Host federated request stream.
 *
 * ## TLS / Security
 *
 * - The Host requires TLS. Server certificate material can be provided as
 *   inline PEM, PEM file paths, PFX/PKCS12 buffers, or PFX file paths.
 * - Optional mTLS client authentication via `tls.clientAuth.ca` or `caFile`.
 * - An `authorizeRegistration` callback provides registration-time admission
 *   control based on the peer's certificate and metadata.
 * - TLS certificates can be reloaded at runtime while the server is running.
 * - In-process local Guests and Brokers can be attached directly with
 *   `host.attachLocalGuest()` and `host.attachLocalBroker()` when they run in
 *   the Host process. Local peers bypass TLS but still use the registration
 *   authorization hook with Host-owned local metadata.
 *
 * ## Lifecycle
 *
 * - Start with {@link createVerserHost} → `await host.start()`.
 * - Subscribe to lifecycle events via `host.onLifecycle()`.
 * - Shut down with `await host.close(reason)`.
 *
 * ## Limitations
 *
 * - Route matching uses **exact** hostname equality — no wildcard/suffix matching.
 * - The Host does not implement WebSocket, HTTP upgrade, CONNECT tunneling,
 *   trailers, or informational (1xx) response forwarding.
 * - Registration authorization is not a complete per-request authentication
 *   or authorization gateway.
 * - Only Node.js TLS HTTP/2 is supported (no HTTP/3, no browser, Rust, Go,
 *   Java, or Python Host implementations).
 */
export { VERSER2_HOST_PACKAGE_NAME } from './lib/constants';

import { NodeHttp2VerserHost } from './lib/node-http2-verser-host';
import type { VerserHost, VerserHostOptions } from './lib/types';

export type {
  VerserHost,
  VerserHostLifecycleEvent,
  VerserLocalBrokerHandle,
  VerserLocalBrokerOptions,
  VerserLocalBrokerRequest,
  VerserLocalBrokerResponse,
  VerserLocalGuestHandle,
  VerserLocalGuestOptions,
  VerserLocalGuestResponse,
  VerserLocalGuestRequestListener,
  VerserHostOptions,
  VerserHostRegistrationRequest,
  VerserHostUpstreamHandle,
  VerserHostUpstreamOptions,
  VerserHostUpstreamStatus,
} from './lib/types';

export type { VerserPeerRole } from '@signicode/verser-common';

export { HostRouteRegistry, createHostRouteRegistry } from './lib/route-registry';

export {
  openUpstreamFederationVwsStream,
  readFederationVwsNegotiation,
} from './lib/federation';

export type {
  HostRouteRegistryOptions,
  ImportedRouteRejection,
  ImportedRouteUpdate,
  RevokeRoutesResult,
  RemoveExpiredDegradedResult,
} from './lib/route-registry';

/**
 * Creates a new Verser Host instance.
 *
 * The Host is a TLS HTTP/2 server that accepts outbound connections from
 * Guests and Brokers. At minimum the `options.tls` must be configured with
 * server certificate material.
 *
 * By default the Host listens on `127.0.0.1` with an OS-assigned port (`0`).
 * Call `await host.start()` to begin listening, then use `host.address` to
 * discover the bound port.
 *
 * @remarks
 * The returned Host also supports `attachLocalGuest()` and
 * `attachLocalBroker()` for colocated in-process peers without TLS HTTP/2.
 *
 * @example
 * ```ts
 * import { createVerserHost } from '@signicode/verser2-host';
 *
 * const host = createVerserHost({
 *   tls: {
 *     cert: fs.readFileSync('server.crt', 'utf8'),
 *     key: fs.readFileSync('server.key', 'utf8'),
 *   },
 * });
 *
 * host.onLifecycle((event) => console.log(event.name, event));
 * await host.start();
 * console.log('Host listening on', host.address);
 * ```
 *
 * @param options - Host configuration (port, host, TLS).
 * @returns A new `VerserHost` instance.
 * @public
 */
export function createVerserHost(options: VerserHostOptions = {}): VerserHost {
  return new NodeHttp2VerserHost(options);
}

/**
 * The package name for {@link https://www.npmjs.com/package/@signicode/verser-common | `@signicode/verser-common`}.
 *
 * @public
 */
export const VERSER_COMMON_PACKAGE_NAME = '@signicode/verser-common';

/**
 * Canonical lifecycle event names emitted by Host and peer implementations.
 *
 * Hosts and Guest/Broker adapters emit these events through their lifecycle hooks:
 * - `connected` — a new TLS HTTP/2 session was established.
 * - `disconnected` — a peer session disconnected.
 * - `registered` — a peer successfully registered.
 * - `route-advertised` — the Host sent an updated route table to a Broker.
 * - `request-started` — a routed request began processing.
 * - `request-completed` — a routed request finished.
 * - `error` — a non-fatal error occurred.
 * - `closed` — the Host or peer connection fully shut down.
 *
 * @public
 */
export const VERSER_LIFECYCLE_EVENTS = {
  connected: 'connected',
  disconnected: 'disconnected',
  registered: 'registered',
  routeAdvertised: 'route-advertised',
  requestStarted: 'request-started',
  requestCompleted: 'request-completed',
  error: 'error',
  closed: 'closed',
  routeRevoked: 'route-revoked',
  routeDegraded: 'route-degraded',
  routeRestored: 'route-restored',
} as const;

/**
 * The current binary envelope wire format version.
 *
 * Written as the first byte of every envelope prefix. Currently `1`.
 *
 * @public
 */
export const VERSER_ENVELOPE_VERSION = 1;

/**
 * Number of bytes in the binary envelope prefix header.
 *
 * Layout: `[version:1] [type:1] [metadataLength:4]` = 6 bytes total.
 *
 * @public
 */
export const VERSER_ENVELOPE_PREFIX_BYTES = 6;

/**
 * Default maximum size (in bytes) of the JSON metadata portion of a Verser envelope.
 *
 * When parsing incoming envelopes, metadata payloads exceeding this limit are rejected.
 *
 * @public
 */
export const DEFAULT_MAX_ENVELOPE_METADATA_BYTES = 64 * 1024;

/**
 * Numeric type codes used in the binary envelope prefix to distinguish envelope types.
 *
 * - `request` (1) — a routed request envelope.
 * - `response` (2) — a routed response envelope.
 * - `error` (3) — an error envelope.
 *
 * @public
 */
export const VERSER_ENVELOPE_TYPES = {
  request: 1,
  response: 2,
  error: 3,
} as const;

/**
 * Constants for Guest route revocation.
 *
 * @public
 */
export const VERSER_GUEST_REVOCATION_PATH = '/verser/guest/revoke';

/**
 * Host-assigned route lifecycle event type names.
 *
 * These strings appear as the `type` field in {@link VerserRouteLifecycleEvent}
 * payloads sent over route lifecycle control frames.
 *
 * - `added` — route was registered or restored.
 * - `removed` — route was revoked or timed out.
 * - `changed` — route state was updated (e.g. generation id change).
 * - `degraded` — route entered degraded/disconnected state.
 *
 * @public
 */
export const VERSER_ROUTE_LIFECYCLE_EVENT_TYPES = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
  degraded: 'degraded',
} as const;

/**
 * Canonical route lifecycle event reason strings.
 *
 * These values appear as the `reason` field in {@link VerserRouteLifecycleEvent}
 * payloads to explain why a route lifecycle change occurred.
 *
 * @public
 */
export const VERSER_ROUTE_EVENT_REASONS = {
  registered: 'registered',
  revoked: 'revoked',
  disconnected: 'disconnected',
  reconnected: 'reconnected',
  restored: 'restored',
  timeout: 'timeout',
  updated: 'updated',
} as const;

/**
 * Default value (in milliseconds) for the Host's degraded-route removal timeout.
 *
 * When a Guest disconnects, its routes enter a degraded/disconnected state.
 * If the same Guest does not reconnect within this period, the routes are
 * fully removed.
 *
 * @public
 */
export const DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS = 5000;

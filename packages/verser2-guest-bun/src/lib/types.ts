import type { VerserClientTlsOptions } from '@signicode/verser-common';
import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
} from '@signicode/verser2-guest-node';

/**
 * Re-exports the Node Broker types used by the Bun Broker wrapper.
 *
 * @public
 */
export type { VerserBroker, VerserBrokerOptions, VerserBrokerRequest, VerserBrokerResponse };

/**
 * Options for creating a Bun Guest via {@link createVerserBunGuest}.
 *
 * The Bun Guest wraps the Node Guest transport and accepts the same TLS/connection
 * options.
 *
 * @public
 */
export interface VerserBunGuestOptions {
  /** The Host URL to connect to (e.g. `https://host.example:443`). */
  readonly hostUrl: string;
  /** Unique identifier for this Guest. Duplicate peer IDs are rejected by the Host. */
  readonly guestId: string;
  /** Optional routed domains to register with the Host. If omitted, routes may be supplied by `attach()` before `connect()`; `attach()` without a domain uses the Guest ID. If neither is supplied before registration, no route domain is advertised. */
  readonly routedDomains?: readonly string[];
  /** Minimum number of lease streams the Guest should keep ready. Defaults to `1`. */
  readonly minWaitingStreams?: number;
  /** Maximum number of concurrent lease streams. Defaults to `16`. */
  readonly maxOpenStreams?: number;
  /** Timeout (ms) for lease stream acquisition. No timeout by default. */
  readonly leaseAcquireTimeoutMs?: number;
  /** Maximum metadata bytes accepted on lease request envelopes. Defaults to 64 KiB. */
  readonly maxMetadataBytes?: number;
  /** TLS options for the outbound HTTP/2 connection (CA trust, client certificates). */
  readonly tls?: VerserClientTlsOptions;
}

/**
 * Lifecycle event emitted by a Bun Guest.
 *
 * @public
 */
export interface VerserBunGuestLifecycleEvent {
  /** The event name (one of `VERSER_LIFECYCLE_EVENTS`). */
  readonly name: string;
  /** The Guest ID that emitted the event. */
  readonly guestId: string;
  /** Present for request-scoped events. */
  readonly requestId?: string;
  /** Present for close events. */
  readonly reason?: string;
  /** Present for error events. */
  readonly error?: unknown;
}

/**
 * Bun Guest interface for outbound Host connection and local handler attachment.
 *
 * The Bun Guest wraps the Node Guest transport. Use {@link attach} with a
 * Bun-style handler object that exposes `fetch` and/or `routes`.
 *
 * {@link attach} does **not** call `listen()` — the local handler processes
 * requests without opening an inbound port.
 *
 * @public
 */
export interface VerserBunGuest {
  /** Whether the Guest has an active HTTP/2 session. */
  readonly connected: boolean;
  /** Establishes the outbound TLS HTTP/2 connection and registers with the Host. */
  connect(): Promise<void>;
  /** Closes the Guest connection and cleans up resources. */
  close(reason?: string): Promise<void>;
  /**
   * Attaches a Bun-style request handler.
   *
   * Accepts an object with an optional `fetch` function (acting as a catch-all)
   * and/or a `routes` table for path-based routing. Route tables support exact
   * paths, `:param` segments, wildcard `*`, and method maps.
   *
   * **WebSocket upgrade is not implemented.** The `server.upgrade()` call in
   * route handlers always returns `false`.
   *
   * @param handler - Handler object with `fetch` and/or `routes`.
   * @param domain - Optional route domain (defaults to Guest ID).
   * @returns `this` for chaining.
   */
  attach(handler: VerserBunGuestRequestHandler, domain?: string): this;
  /**
   * Registers a lifecycle event listener.
   *
   * Returns an unsubscribe function.
   */
  onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void;
}

/**
 * A Bun `Request` extended with path parameters extracted from route matching.
 *
 * When a route pattern like `/users/:id` matches, `params` contains
 * `{ id: "value" }`. Wildcard routes populate `params["*"]`.
 *
 * @public
 */
export interface VerserBunRequest extends Request {
  readonly params: Record<string, string>;
}

/**
 * HTTP methods supported in Bun route method maps.
 *
 * @public
 */
export type VerserBunRouteMethod =
  | 'ACL'
  | 'BIND'
  | 'CHECKOUT'
  | 'CONNECT'
  | 'COPY'
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'LINK'
  | 'LOCK'
  | 'M-SEARCH'
  | 'MERGE'
  | 'MKACTIVITY'
  | 'MKCOL'
  | 'MKREDIRECTREF'
  | 'MKWORKSPACE'
  | 'MOVE'
  | 'OPTIONS'
  | 'PATCH'
  | 'POST'
  | 'PROPFIND'
  | 'PROPPATCH'
  | 'PURGE'
  | 'PUT'
  | 'REBIND'
  | 'REPORT'
  | 'SEARCH'
  | 'TRACE'
  | 'UNBIND'
  | 'UNLINK'
  | 'UNLOCK';

/**
 * Handler function for a Bun route.
 *
 * Receives the request with parsed `params` and a `server` object (with
 * unimplemented `upgrade`), and returns a `Response`.
 *
 * @public
 */
export type VerserBunRouteHandler = (
  request: VerserBunRequest,
  server: VerserBunGuestServer,
) => Promise<Response> | Response;

/**
 * A route value — either a static `Response` or a handler function.
 *
 * @public
 */
export type VerserBunRouteValue = Response | VerserBunRouteHandler;

/**
 * Per-method route map keyed by HTTP method.
 *
 * @public
 */
export type VerserBunRoutesPerMethod = {
  readonly [METHOD in VerserBunRouteMethod]?: VerserBunRouteValue;
};

/**
 * Route table mapping URL path patterns to handlers.
 *
 * Supports:
 * - Exact paths (`/users`)
 * - `:param` segments (`/users/:id`)
 * - Wildcard `*` at the end (`/files/*`)
 * - Per-method maps using {@link VerserBunRoutesPerMethod}
 *
 * @public
 */
export type VerserBunRoutes = {
  readonly [pathname: string]: VerserBunRouteValue | VerserBunRoutesPerMethod;
};

/**
 * Bun Guest request handler object.
 *
 * Provide a `fetch` function for a catch-all handler or a `routes` table
 * for path-based routing. At least one should be defined.
 *
 * @public
 */
export interface VerserBunGuestRequestHandler {
  /** Catch-all fetch handler called when no route matches. */
  readonly fetch?: (
    request: VerserBunRequest,
    server: VerserBunGuestServer,
  ) => Promise<unknown> | unknown;
  /** Path-based route table. */
  readonly routes?: VerserBunRoutes;
}

/**
 * Response shape returned by Bun dispatch for the adapter bridge.
 *
 * @internal
 */
export interface VerserBunGuestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

/**
 * Server object passed to Bun route handlers.
 *
 * The `upgrade` method always returns `false` — WebSocket upgrade is
 * **not implemented**.
 *
 * @public
 */
export interface VerserBunGuestServer {
  /**
   * Attempt to upgrade the request to a WebSocket connection.
   *
   * **Not implemented.** Always returns `false`.
   */
  upgrade: (request: Request) => boolean;
}

export { DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE } from './constants';

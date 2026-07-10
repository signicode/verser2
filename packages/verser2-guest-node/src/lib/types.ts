import type * as http from 'node:http';
import type { Readable } from 'node:stream';
import type { Dispatcher, fetch as undiciFetch } from 'undici';

import type { VerserWebSocket } from './verser-websocket';

import type {
  RoutedDomainRegistration,
  RoutedRequestEnvelope,
  RoutedResponseEnvelope,
  VerserBrokerControlFrame,
  VerserClientTlsOptions,
  VerserError,
  VerserGuestRevocationResponse,
  VerserRouteLifecycleEvent,
} from '@signicode/verser-common';

/**
 * Options for creating a Node Guest via {@link createVerserNodeGuest}.
 *
 * @public
 */
export interface VerserNodeGuestOptions {
  /** The Host URL to connect to (e.g. `https://host.example:443`). */
  readonly hostUrl: string;
  /** Unique identifier for this Guest. Duplicate peer IDs are rejected by the Host. */
  readonly guestId: string;
  /** Optional routed domains to register with the Host. If omitted, routes may be supplied by `attach()` before `connect()`; `attach()` without a domain uses the Guest ID. If neither is supplied before registration, no route domain is advertised. */
  readonly routedDomains?: readonly string[];
  /** Minimum number of lease streams the Guest should keep ready for incoming requests. Defaults to `1`. */
  readonly minWaitingStreams?: number;
  /** Maximum number of concurrent lease streams. Defaults to `16`. */
  readonly maxOpenStreams?: number;
  /** Timeout (ms) for lease stream acquisition. No timeout by default. */
  readonly leaseAcquireTimeoutMs?: number;
  /** Maximum metadata bytes accepted on lease request envelopes. Defaults to 64 KiB. */
  readonly maxMetadataBytes?: number;
  /** Maximum buffered response body bytes when no lease stream is available. Defaults to 10 MiB. */
  readonly maxResponseBytes?: number;
  /** TLS options for the outbound HTTP/2 connection (CA trust, client certificates). */
  readonly tls?: VerserClientTlsOptions;
}

/**
 * Lifecycle event emitted by a Node Guest.
 *
 * Events are delivered via the listener registered with
 * {@link VerserNodeGuest.onLifecycle}. Event names correspond to
 * {@link VERSER_LIFECYCLE_EVENTS} values.
 *
 * @public
 */
export interface VerserNodeGuestLifecycleEvent {
  /** The event name (one of `VERSER_LIFECYCLE_EVENTS`). */
  readonly name: string;
  /** The Guest ID that emitted the event. */
  readonly guestId: string;
  /** Present for request-scoped events. */
  readonly requestId?: string;
  /** Present for close events. */
  readonly reason?: string;
  /** Present for error events. */
  readonly error?: VerserError;
}

/**
 * Envelope of a routed request dispatched to a local Node Guest handler.
 *
 * The body is delivered as an ordered list of string or Buffer chunks.
 *
 * @public
 */
export interface VerserNodeGuestDispatchRequest extends RoutedRequestEnvelope {
  readonly body: readonly (string | Buffer)[];
}

/**
 * Envelope of a response produced by a local Node Guest handler.
 *
 * The complete response body is buffered into a single Buffer.
 *
 * @public
 */
export interface VerserNodeGuestDispatchResponse extends RoutedResponseEnvelope {
  readonly body: Buffer;
}

/**
 * Options for creating a Broker via {@link createVerserBroker}.
 *
 * @public
 */
export interface VerserBrokerOptions {
  /** The Host URL to connect to (e.g. `https://host.example:443`). */
  readonly hostUrl: string;
  /** Unique identifier for this Broker. Duplicate peer IDs are rejected by the Host. */
  readonly brokerId: string;
  /** Timeout (ms) for lease acquisition when sending requests. No timeout by default. */
  readonly leaseAcquireTimeoutMs?: number;
  /** Maximum bytes allowed for HTTP/1 request headers when using the Agent socket. Defaults to 64 KiB. */
  readonly maxRequestHeaderBytes?: number;
  /** Maximum bytes for a single chunk-size line when decoding chunked transfer. Defaults to 1024. */
  readonly maxChunkSizeLineBytes?: number;
  /** Maximum pending bytes buffered by the chunked-body decoder. Defaults to 64 KiB. */
  readonly maxChunkDecoderPendingBytes?: number;
  /** Maximum bytes buffered to replay a request body for internal 307/308 redirects. Defaults to 16 KiB. */
  readonly internalRedirectReplayBufferBytes?: number;
  /** Maximum number of internal 307/308 redirect hops followed by Broker request paths. Defaults to `3`. */
  readonly maxInternalRedirects?: number;
  /** TLS options for the outbound HTTP/2 connection (CA trust, client certificates). */
  readonly tls?: VerserClientTlsOptions;
}

/**
 * Request sent through a Broker to a target Guest.
 *
 * The `targetId` must match a Guest peer ID that has registered with the Host.
 * The `body` may be omitted, provided as a list of Buffer chunks, or supplied
 * as a Node.js `Readable` stream.
 *
 * @public
 */
export interface VerserBrokerRequest {
  /** Target Guest peer ID. */
  readonly targetId: string;
  /** HTTP method (e.g. `GET`, `POST`). */
  readonly method: string;
  /** Request path (e.g. `/api/resource?id=1`). */
  readonly path: string;
  /** Optional request headers. */
  readonly headers?: Record<string, string>;
  /** Request body — omitted for no body, Buffer array, or a Readable stream. */
  readonly body?: readonly Buffer[] | Readable;
}

/**
 * Response returned by a Broker after forwarding a request.
 *
 * The body is a Node.js `Readable` stream. Consume it via standard
 * stream APIs (`data` events, `pipe()`, or async iteration).
 *
 * @public
 */
export interface VerserBrokerResponse extends RoutedResponseEnvelope {
  readonly body: Readable;
}

/**
 * Broker interface for outbound request routing to advertised Guest targets.
 *
 * Connect to a Host, receive route-control frames, and route requests by target
 * domain. The Broker also exposes {@link createAgent}, {@link createDispatcher},
 * and {@link createFetch} helpers that transparently resolve route hostnames
 * without DNS resolution.
 *
 * @public
 */
export interface VerserBroker {
  /** Number of active HTTP/2 sessions (0 or 1). */
  readonly sessionCount: number;
  /** Total number of routed requests issued through this Broker. */
  readonly routedRequestCount: number;
  /** Establishes the outbound TLS HTTP/2 connection and registers with the Host. */
  connect(): Promise<void>;
  /** Closes the Broker connection and cleans up resources. */
  close(reason?: string): Promise<void>;
  /**
   * Returns an `http.Agent` that routes advertised hostnames through the Broker.
   *
   * The Agent resolves target hostnames from the Broker's advertised route table
   * rather than performing DNS resolution. Requests are forwarded via the Broker's
   * outbound HTTP/2 connection.
   */
  createAgent(): http.Agent;
  /**
   * Returns an Undici `Dispatcher` that routes advertised hostnames through the Broker.
   *
   * Supports common buffer, string, stream, and iterable body forms.
   * Upgrade requests are rejected. The dispatcher resolves target hostnames
   * from the Broker's route table.
   */
  createDispatcher(): Dispatcher;
  /**
   * Returns a `fetch` function that routes advertised hostnames through the Broker.
   *
   * Wraps Undici `fetch` with the Broker dispatcher by default.
   */
  createFetch(): typeof undiciFetch;
  /** Returns a snapshot of the current advertised route table. */
  getRoutes(): { targetId: string; domain: string }[];
  /**
   * Resolves when a route for the given domain is advertised.
   *
   * If the route is already known the promise resolves immediately.
   */
  waitForRoute(domain: string): Promise<void>;
  /**
   * Sends a request to the target Guest through the Host.
   *
   * The target is identified by `targetId`. The response body is returned
   * as a `Readable` stream.
   */
  request(request: VerserBrokerRequest): Promise<VerserBrokerResponse>;
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
  onRouteChange(listener: (event: VerserBrokerRouteChangeEvent) => void): () => void;

  /**
   * Opens a VWS/1 WebSocket connection to the target Guest through the Host.
   *
   * Resolves with a {@link VerserWebSocket} instance after the VWS/1 handshake
   * completes (the Guest accepted the connection).
   *
   * @param options - WebSocket target, domain, optional protocol/path.
   * @returns A promise that resolves to a ready-to-use WebSocket.
   */
  webSocket(options: VerserBrokerWebSocketRequest): Promise<VerserWebSocket>;
}

/**
 * Node Guest interface for outbound Host connection and local handler attachment.
 *
 * The Guest connects outbound over TLS HTTP/2, registers as role `guest`, and
 * maintains a pool of lease streams. Incoming routed requests are dispatched to
 * the locally attached HTTP handler.
 *
 * {@link attach} does **not** call `server.listen()` — the local handler processes
 * requests without opening an inbound port.
 *
 * @public
 */
export interface VerserNodeGuest {
  /** Whether the Guest has an active HTTP/2 session. */
  readonly connected: boolean;
  /** Establishes the outbound TLS HTTP/2 connection and registers with the Host. */
  connect(): Promise<void>;
  /** Closes the Guest connection and cleans up resources. */
  close(reason?: string): Promise<void>;
  /**
   * Attaches a local HTTP handler without calling `listen()`.
   *
   * Accepts either an `http.Server` with a single request listener or a
   * {@link NodeRequestListener} function. When no `domain` is supplied the
   * route domain defaults to the Guest ID.
   *
   * @param serverOrListener - An `http.Server` instance or a listener function.
   * @param domain - Optional route domain (defaults to Guest ID).
   * @returns `this` for chaining.
   */
  attach(serverOrListener: http.Server | NodeRequestListener, domain?: string): this;
  /**
   * Dispatches a pre-parsed routed request directly to the local handler.
   *
   * Intended for direct dispatch and focused tests with synthetic request
   * envelopes. Host-connected request routing uses the Guest lease stream path.
   */
  dispatchRoutedRequest(
    request: VerserNodeGuestDispatchRequest,
  ): Promise<VerserNodeGuestDispatchResponse>;
  /**
   * Registers a lifecycle event listener.
   *
   * Returns an unsubscribe function.
   */
  onLifecycle(listener: (event: VerserNodeGuestLifecycleEvent) => void): () => void;
  /**
   * Revokes one or more advertised route domains.
   *
   * Sends a revocation request to the Host over the dedicated revocation path.
   * The returned promise resolves with the Host's response (ack, partial, or error).
   *
   * @param domains - The route domains to revoke.
   * @returns The Host revocation response.
   * @throws {VerserError} If the Guest is not connected, or if the request fails.
   */
  revokeRoutes(domains: readonly string[]): Promise<VerserGuestRevocationResponse>;

  /**
   * Attaches a VWS/1 WebSocket handler for the given domain.
   *
   * The handler receives a {@link VerserWebSocket} instance on each incoming
   * WebSocket connection. The route domain is advertised during registration.
   * Must be called **before** {@link connect} so the domain is included in
   * the route advertisement.
   *
   * @param handler - Callback invoked with a WebSocket for each new connection.
   * @param domain - Optional route domain (defaults to the Guest ID).
   * @returns `this` for chaining.
   */
  attachWebSocket(handler: VerserWebSocketHandler, domain?: string): this;
}

/**
 * Signature of a listener accepted by {@link VerserNodeGuest.attach}.
 *
 * Compatible with standard Node.js `http.Server` request listeners but
 * receives minimal request/response objects. These objects do not implement
 * the full Node `IncomingMessage` or `ServerResponse` surface — they lack
 * socket access, trailers, upgrade support, and informational responses.
 *
 * @param request - Minimal incoming request with `method`, `url`, `headers`, and `on` for body events.
 * @param response - Minimal server response with `statusCode`, `setHeader`, `getHeader`, `writeHead`, `write`,
 *                   `end`, and `flushHeaders`.
 *
 * @public
 */
export type NodeRequestListener = (
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
  },
  response: {
    statusCode: number;
    setHeader: (name: string, value: string | number | boolean) => unknown;
    getHeader: (name: string) => string | undefined;
    writeHead: (statusCode: number, headers?: Record<string, string | number | boolean>) => unknown;
    write: (chunk: string | Buffer, encoding?: BufferEncoding) => boolean;
    end: (chunk?: string | Buffer, encoding?: BufferEncoding) => unknown;
    flushHeaders: () => void;
    once?: (eventName: string | symbol, listener: (...args: unknown[]) => void) => unknown;
  },
) => void;

/**
 * Minimal router interface required by the Broker Agent and Dispatcher.
 *
 * @internal
 */
export interface BrokerRequestRouter {
  request(request: VerserBrokerRequest): Promise<VerserBrokerResponse>;
  getRoutes(): { targetId: string; domain: string }[];
}

/**
 * @public
 */
export type BrokerControlFrame = VerserBrokerControlFrame;

/**
 * @public
 */
export type BrokerRoute = RoutedDomainRegistration;

/**
 * A route change event emitted by the Broker when the Host notifies it of
 * route lifecycle changes.
 *
 * @public
 */
export interface VerserBrokerRouteChangeEvent {
  /** The lifecycle event type. */
  readonly type: VerserRouteLifecycleEvent['type'];
  /** The Guest peer that owns this route. */
  readonly targetId: string;
  /** The domain affected by this event. */
  readonly domain: string;
  /** Optional machine-readable reason for the event. */
  readonly reason?: VerserRouteLifecycleEvent['reason'];
  /** Optional generation/session metadata. */
  readonly generation?: VerserRouteLifecycleEvent['generation'];
}

/**
 * Result returned by a {@link VerserWebSocketHandler} to accept or reject
 * an incoming VWS/1 WebSocket connection.
 *
 * - Return `undefined` or `{ protocol?: string }` to accept (default).
 * - Return `false` or `null` to reject the connection.
 *
 * @public
 */
export type VerserWebSocketAcceptResult = { readonly protocol?: string } | false | null;

/**
 * Handler signature for {@link VerserNodeGuest.attachWebSocket}.
 *
 * Receives the open metadata (domain, path, protocol) and a
 * {@link VerserWebSocket} instance. The handler may return an accept result
 * (subprotocol options), `false`/`null` to reject, or a promise resolving
 * to either. When the handler does not return (undefined), the connection
 * is accepted with the requested protocol.
 *
 * The handler may set up event listeners on the WebSocket before accepting.
 * Messages sent before accept are queued and delivered after accept.
 *
 * @param open - Connection metadata (domain, path, requested protocol).
 * @param ws - The WebSocket instance (accept/reject is pending).
 * @returns An accept result, rejection, or a promise thereof.
 *
 * @example
 * ```ts
 * // Auto-accept echo handler
 * guest.attachWebSocket((_open, ws) => {
 *   ws.on('message', (data, { type }) => ws.send(data, { type }));
 * });
 *
 * // Reject connections without a specific protocol
 * guest.attachWebSocket((open, ws) => {
 *   if (open.protocol !== 'vws.base64') return false;
 *   return { protocol: 'vws.base64' };
 * });
 * ```
 *
 * @public
 */
export type VerserWebSocketHandler = (
  open: { domain: string; path: string; protocol: string },
  ws: VerserWebSocket,
) => VerserWebSocketAcceptResult | Promise<VerserWebSocketAcceptResult> | undefined;

/**
 * Options for {@link VerserBroker.webSocket}.
 *
 * @public
 */
export interface VerserBrokerWebSocketRequest {
  /** Target Guest peer ID. */
  readonly targetId: string;
  /** Target route domain. */
  readonly domain: string;
  /** Optional request path. */
  readonly path?: string;
  /** Optional VWS sub-protocol to negotiate. */
  readonly protocol?: string;
  /** Optional request headers (reserved for future use). */
  readonly headers?: Record<string, string>;
}

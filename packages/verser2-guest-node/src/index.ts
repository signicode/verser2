/**
 * The package name for
 * {@link https://www.npmjs.com/package/@signicode/verser2-guest-node | `@signicode/verser2-guest-node`}.
 *
 * @public
 */
export { VERSER2_GUEST_NODE_PACKAGE_NAME } from './lib/constants';

/**
 * Minimal HTTP/1-style request and response classes for local Guest handlers.
 *
 * These objects are **not** full Node.js `IncomingMessage` / `ServerResponse`
 * implementations and do not support HTTP upgrade, WebSocket forwarding,
 * CONNECT tunneling, trailers, informational responses, or full socket semantics.
 *
 * @public
 */
export { MinimalIncomingMessage, MinimalServerResponse } from './lib/minimal-http';

/**
 * Public types for the Node Guest and Broker.
 *
 * @public
 */
export type {
  /** Signature accepted by {@link VerserNodeGuest.attach}. */
  NodeRequestListener,
  /** Broker interface for outbound request routing. */
  VerserBroker,
  /** Options for creating a Broker. */
  VerserBrokerOptions,
  /** Request sent through a Broker to a target Guest. */
  VerserBrokerRequest,
  /** Response returned by a Broker. */
  VerserBrokerResponse,
  /** Route change event emitted by the Broker. */
  VerserBrokerRouteChangeEvent,
  /** Envelope of a routed request dispatched to a local Guest handler. */
  VerserNodeGuestDispatchRequest,
  /** Envelope of a response produced by a local Guest handler. */
  VerserNodeGuestDispatchResponse,
  /** Node Guest interface for outbound connection and local handler attachment. */
  VerserNodeGuest,
  /** Lifecycle event emitted by a Node Guest. */
  VerserNodeGuestLifecycleEvent,
  /** Options for creating a Node Guest. */
  VerserNodeGuestOptions,
  /** WebSocket request options for broker.webSocket(). */
  VerserBrokerWebSocketRequest,
  /** VWS/1 WebSocket handler type for guest.attachWebSocket(). */
  VerserWebSocketHandler,
  VerserNativeWebSocketHandler,
  /** Result returned by a WebSocket handler to accept or reject. */
  VerserWebSocketAcceptResult,
} from './lib/types';

export { VerserWebSocket } from './lib/verser-websocket';
export { NativeVerserWebSocket } from './lib/native-websocket';
export type {
  NativeWebSocketBinaryType,
  NativeWebSocketEvent,
  NativeWebSocketMessageEvent,
} from './lib/native-websocket';
export type { VerserWebSocketEvents, VerserWebSocketSendOptions } from './lib/verser-websocket';

import { Http2VerserBroker } from './lib/http2-verser-broker';
import { Http2VerserNodeGuest } from './lib/http2-verser-node-guest';
import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserNodeGuest,
  VerserNodeGuestOptions,
} from './lib/types';

/**
 * Creates a new Node Guest that connects outbound to a Verser Host over TLS HTTP/2.
 *
 * The Guest registers as role `guest`, opens a control stream, and maintains a pool
 * of lease streams. Use {@link VerserNodeGuest.attach | attach()} to provide a local
 * HTTP handler **without** calling `server.listen()`. When no domain is supplied to
 * `attach()`, the route domain defaults to the Guest ID.
 * Use {@link VerserNodeGuest.attachWebSocket | attachWebSocket()} for explicit
 * VWS/1 WebSocket handlers.
 *
 * @param options - Guest configuration including the Host URL, Guest ID, and TLS options.
 * @returns A {@link VerserNodeGuest} instance.
 *
 * @public
 */
export function createVerserNodeGuest(options: VerserNodeGuestOptions): VerserNodeGuest {
  return new Http2VerserNodeGuest(options);
}

/**
 * Creates a new Broker that connects outbound to a Verser Host over TLS HTTP/2.
 *
 * The Broker registers as role `broker`, receives route-control frames from the Host,
 * and sends requests to the Host path `/verser/request`. Use {@link VerserBroker.request}
 * to route requests to advertised Guest targets.
 *
 * Helper methods {@link VerserBroker.createAgent | createAgent()},
 * {@link VerserBroker.createDispatcher | createDispatcher()}, and
 * {@link VerserBroker.createFetch | createFetch()} provide alternative routing
 * interfaces that resolve target hostnames from the advertised route table.
 * {@link VerserBroker.webSocket | webSocket()} opens an explicit VWS/1 WebSocket.
 *
 * @param options - Broker configuration including the Host URL, Broker ID, and TLS options.
 * @returns A {@link VerserBroker} instance.
 *
 * @public
 */
export function createVerserBroker(options: VerserBrokerOptions): VerserBroker {
  return new Http2VerserBroker(options);
}

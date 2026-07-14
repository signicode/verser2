/**
 * The package name for
 * {@link https://www.npmjs.com/package/@signicode/verser2-guest-bun | `@signicode/verser2-guest-bun`}.
 *
 * @public
 */
export { VERSER2_GUEST_BUN_PACKAGE_NAME } from './lib/constants';

/**
 * Public types for the Bun Guest and Broker.
 *
 * @public
 */
export type {
  /** Broker interface for outbound request routing. */
  VerserBroker,
  VerserBunBroker,
  /** Options for creating a Broker. */
  VerserBrokerOptions,
  /** Request sent through a Broker to a target Guest. */
  VerserBrokerRequest,
  /** Response returned by a Broker. */
  VerserBrokerResponse,
  /** Route change event emitted by the Broker. */
  VerserBrokerRouteChangeEvent,
  /** Response from a Guest route revocation request. */
  VerserGuestRevocationResponse,
  /** Bun Guest interface for outbound connection and handler attachment. */
  VerserBunGuest,
  /** Lifecycle event emitted by a Bun Guest. */
  VerserBunGuestLifecycleEvent,
  /** Options for creating a Bun Guest. */
  VerserBunGuestOptions,
  /** Bun Request extended with route params. */
  VerserBunRequest,
  /** Path-based route table type. */
  VerserBunRoutes,
  /** HTTP methods supported in route method maps. */
  VerserBunRouteMethod,
  /** Route handler function signature. */
  VerserBunRouteHandler,
  /** Route value (Response or handler). */
  VerserBunRouteValue,
  /** Per-method route map type. */
  VerserBunRoutesPerMethod,
  /** Bun Guest request handler object. */
  VerserBunGuestRequestHandler,
  /** Bun-compatible WebSocket callback set. */
  VerserBunWebSocketHandler,
  /** VWS-backed WebSocket passed to Bun callbacks. */
  VerserBunWebSocket,
  /** Options accepted by the Bun-native upgrade surface. */
  VerserBunUpgradeOptions,
  VerserBunNativeWebSocket,
} from './lib/types';

import { Readable } from 'node:stream';

import { resolveRouteForUrl } from '@signicode/verser-common';
import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBunBroker,
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestRequestHandler,
  VerserBunNativeWebSocket,
  VerserGuestRevocationResponse,
} from './lib/types';

import {
  NativeVerserWebSocket,
  type VerserNodeGuest,
  createVerserBroker as createVerserNodeBroker,
  createVerserNodeGuest,
} from '@signicode/verser2-guest-node';
import { createNodeStyleHandler, createNodeStyleWebSocketHandler } from './lib/adapter';

/**
 * Creates a new Bun Guest that connects outbound to a Verser Host.
 *
 * Wraps the Node Guest transport. The Guest registers as role `guest`, opens
 * a control stream, and maintains a pool of lease streams. Use
 * {@link VerserBunGuest.attach | attach()} with a Bun-style handler object
 * that exposes `fetch` and/or `routes`.
 *
 * {@link VerserBunGuest.attach} does **not** call `listen()` — the local
 * handler processes requests without opening an inbound port.
 *
 * @param options - Guest configuration including the Host URL, Guest ID, and TLS options.
 * @returns A {@link VerserBunGuest} instance.
 *
 * @public
 */
export function createVerserBunGuest(options: VerserBunGuestOptions): VerserBunGuest {
  const nodeGuest: VerserNodeGuest = createVerserNodeGuest(options);
  const nativeGuest = nodeGuest as VerserNodeGuest & {
    attachNativeWebSocket: (handler: unknown, domain?: string) => VerserNodeGuest;
  };

  const guest: VerserBunGuest = {
    get connected(): boolean {
      return nodeGuest.connected;
    },

    attach(handler: VerserBunGuestRequestHandler, domain?: string): VerserBunGuest {
      const domainName = domain ?? options.guestId;
      const nodeHandler = createNodeStyleHandler(domainName, handler);
      nodeGuest.attach(nodeHandler, domainName);
      if (handler.websocket !== undefined) {
        nativeGuest.attachNativeWebSocket(
          createNodeStyleWebSocketHandler(domainName, handler),
          domainName,
        );
      }
      return guest;
    },

    async connect(): Promise<void> {
      await nodeGuest.connect();
    },

    async close(reason?: string): Promise<void> {
      await nodeGuest.close(reason);
    },

    onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void {
      return nodeGuest.onLifecycle((event) => {
        listener(event);
      });
    },

    async revokeRoutes(domains: readonly string[]): Promise<VerserGuestRevocationResponse> {
      return nodeGuest.revokeRoutes(domains);
    },
  };

  return guest;
}

type VerserBunFetch = ReturnType<VerserBroker['createFetch']>;

/**
 * Creates a new Broker that connects outbound to a Verser Host.
 *
 * Wraps the Node Broker. The Broker registers as role `broker`, receives
 * route-control frames from the Host, and sends requests to the Host path
 * `/verser/request`.
 *
 * The returned `createFetch()` provides a Web Fetch-style `fetch` function
 * that resolves target hostnames from the advertised route table and streams
 * response bodies as Web `ReadableStream`.
 *
 * @param options - Broker configuration including the Host URL, Broker ID, and TLS options.
 * @returns A {@link VerserBroker} instance with a Bun-adapted `createFetch()`.
 *
 * @public
 */
export function createVerserBroker(options: VerserBrokerOptions): VerserBunBroker {
  const nodeBroker = createVerserNodeBroker(options);

  const nodeWebSocket = nodeBroker.webSocket.bind(nodeBroker);
  const bunBroker = nodeBroker as unknown as VerserBunBroker;
  const nativeWebSocket = async (
    request: Parameters<VerserBroker['webSocket']>[0],
  ): Promise<VerserBunNativeWebSocket> =>
    new NativeVerserWebSocket((await nodeWebSocket(request)) as never);
  bunBroker.nativeWebSocket = nativeWebSocket;

  const createVerserBunFetch: VerserBroker['createFetch'] = () => {
    const fetch: VerserBunFetch = (async (input: unknown, init: unknown) => {
      const request = new Request(input as RequestInfo, init as RequestInit);
      const requestUrl = new URL(request.url);
      const route = resolveRouteForUrl(nodeBroker.getRoutes(), requestUrl);
      if (route === undefined) {
        throw new Error(`No Verser route advertised for host ${requestUrl.hostname}`);
      }

      const reqBodyStream = request.body;
      const hasBody =
        reqBodyStream !== null && request.method !== 'GET' && request.method !== 'HEAD';

      let reqBody: readonly Buffer[] | Readable | undefined;
      if (hasBody) {
        // Convert the Web ReadableStream to a Node Readable for streaming
        // instead of eagerly buffering with arrayBuffer().
        reqBody = Readable.from(reqBodyStream);
      }

      const requestHeaders = Object.fromEntries(request.headers.entries());
      if (!requestHeaders.host && !requestHeaders[':authority']) {
        requestHeaders.host = requestUrl.host;
      }
      const response = await nodeBroker.request({
        targetId: route.targetId,
        routeDomain: route.domain,
        method: request.method,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        headers: requestHeaders,
        body: reqBody,
      });

      const body = response.body;
      const readableBody = new ReadableStream<Uint8Array>({
        start(controller) {
          const onData = (chunk: unknown) => {
            try {
              if (typeof chunk === 'string') controller.enqueue(Buffer.from(chunk));
              else if (Buffer.isBuffer(chunk)) controller.enqueue(chunk);
              else if (chunk instanceof Uint8Array) controller.enqueue(chunk);
              else if (chunk instanceof ArrayBuffer) controller.enqueue(new Uint8Array(chunk));
              else if (chunk != null) controller.enqueue(Buffer.from(String(chunk)));
              body.pause();
            } catch (error: unknown) {
              body.destroy(error instanceof Error ? error : new Error(String(error)));
              controller.error(error);
            }
          };
          const onEnd = () => {
            cleanup();
            controller.close();
          };
          const onError = (error: unknown) => {
            cleanup();
            controller.error(error);
          };
          const cleanup = () => {
            body.off('data', onData);
            body.off('end', onEnd);
            body.off('error', onError);
          };
          body.on('data', onData);
          body.once('end', onEnd);
          body.once('error', onError);
          body.pause();
        },
        pull() {
          body.resume();
        },
        cancel(reason) {
          body.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
      });

      return new Response(readableBody, {
        status: response.statusCode,
        statusText: '',
        headers: response.headers,
      }) as unknown as ReturnType<VerserBunFetch>;
    }) as VerserBunFetch;

    return fetch;
  };

  bunBroker.createFetch = createVerserBunFetch;

  return bunBroker;
}

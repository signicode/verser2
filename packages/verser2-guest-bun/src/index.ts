export { VERSER2_GUEST_BUN_PACKAGE_NAME } from './lib/constants';

export type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunRequest,
  VerserBunRoutes,
  VerserBunRouteMethod,
  VerserBunRouteHandler,
  VerserBunRouteValue,
  VerserBunRoutesPerMethod,
  VerserBunGuestRequestHandler,
} from './lib/types';

import { resolveRouteForUrl } from '@signicode/verser-common';
import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestRequestHandler,
} from './lib/types';

import {
  type VerserNodeGuest,
  createVerserBroker as createVerserNodeBroker,
  createVerserNodeGuest,
} from '@signicode/verser2-guest-node';
import { createNodeStyleHandler } from './lib/adapter';

export function createVerserBunGuest(options: VerserBunGuestOptions): VerserBunGuest {
  const nodeGuest: VerserNodeGuest = createVerserNodeGuest(options);

  const guest: VerserBunGuest = {
    get connected(): boolean {
      return nodeGuest.connected;
    },

    attach(handler: VerserBunGuestRequestHandler, domain?: string): VerserBunGuest {
      const domainName = domain ?? options.guestId;
      const nodeHandler = createNodeStyleHandler(domainName, handler);
      nodeGuest.attach(nodeHandler, domainName);
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
  };

  return guest;
}

type VerserBunFetch = ReturnType<VerserBroker['createFetch']>;

export function createVerserBroker(options: VerserBrokerOptions): VerserBroker {
  const nodeBroker = createVerserNodeBroker(options);

  const createVerserBunFetch: VerserBroker['createFetch'] = () => {
    const fetch: VerserBunFetch = (async (input: unknown, init: unknown) => {
      const request = new Request(input as RequestInfo, init as RequestInit);
      const requestUrl = new URL(request.url);
      const route = resolveRouteForUrl(nodeBroker.getRoutes(), requestUrl);
      if (route === undefined) {
        throw new Error(`No Verser route advertised for host ${requestUrl.hostname}`);
      }

      const requestBodyBuffer = await request.arrayBuffer();
      const hasBody =
        requestBodyBuffer.byteLength > 0 && request.method !== 'GET' && request.method !== 'HEAD';

      const response = await nodeBroker.request({
        targetId: route.targetId,
        method: request.method,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        headers: Object.fromEntries(request.headers.entries()),
        body: hasBody ? [Buffer.from(requestBodyBuffer)] : undefined,
      });

      const body = response.body;
      const readableBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of body) {
              if (typeof chunk === 'string') {
                controller.enqueue(Buffer.from(chunk));
                continue;
              }
              if (Buffer.isBuffer(chunk)) {
                controller.enqueue(chunk);
                continue;
              }
              if (chunk instanceof Uint8Array) {
                controller.enqueue(chunk);
                continue;
              }
              if (chunk instanceof ArrayBuffer) {
                controller.enqueue(new Uint8Array(chunk));
                continue;
              }
              if (chunk != null) {
                controller.enqueue(Buffer.from(String(chunk)));
              }
            }
            controller.close();
          } catch (error: unknown) {
            controller.error(error);
          }
        },
        cancel(reason) {
          const destroyReason: unknown = reason instanceof Error ? reason : String(reason);
          body.destroy(destroyReason as Error);
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

  (nodeBroker as VerserBroker & { createFetch: typeof createVerserBunFetch }).createFetch =
    createVerserBunFetch;

  return nodeBroker;
}

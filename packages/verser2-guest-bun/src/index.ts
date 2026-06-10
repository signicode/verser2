export { VERSER2_GUEST_BUN_PACKAGE_NAME } from './lib/constants';

export type {
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestServerLike,
  VerserBunGuestRequestHandler,
  VerserBunDispatchRequest,
  VerserBunDispatchResponse,
  VerserBunDispatchRoutes,
  VerserBunDispatchRequestHandler,
  VerserBunDispatchRouteEntry,
  VerserBunDispatchRouteHandlers,
  VerserBunDispatchRouteMethodHandler,
} from './lib/types';

import type {
  VerserBunDispatchMethod,
  VerserBunDispatchRequest,
  VerserBunDispatchRequestHandler,
  VerserBunDispatchResponse,
  VerserBunDispatchRouteEntry,
  VerserBunDispatchRouteHandlers,
  VerserBunDispatchRouteMethodHandler,
  VerserBunDispatchRoutes,
  VerserBunDispatchServer,
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestServerLike,
} from './lib/types';

const DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE = 'Handler must return a Response instance.';

const dispatchBunRequestMethodNotAllowed = (allowedMethods: readonly string[]): Response => {
  const allowHeader = allowedMethods.join(', ');
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { allow: allowHeader },
  });
};

const toHeadersRecord = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name.toLowerCase()] = value;
  }
  return result;
};

const toVerserBunResponse = async (response: Response): Promise<VerserBunDispatchResponse> => {
  const body = await response.text();
  const headers = toHeadersRecord(response.headers);
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    text: async () => body,
    json: async () => {
      return JSON.parse(body) as unknown;
    },
  };
};

const isRouteHandlers = (
  value: VerserBunDispatchRouteEntry,
): value is VerserBunDispatchRouteHandlers => {
  return typeof value !== 'function' && !(value instanceof Response);
};

const asRequestUrl = (request: VerserBunDispatchRequest): string => {
  return new URL(request.path, request.origin).toString();
};

const isResponseLike = (value: unknown): value is Response => {
  return value instanceof Response;
};

const resolveResponse = (value: unknown): Promise<Response> => {
  if (isResponseLike(value)) {
    return Promise.resolve(value);
  }
  return Promise.reject(new TypeError(DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE));
};

const dispatchByRoutes = async (
  routes: VerserBunDispatchRoutes,
  request: VerserBunDispatchRequest,
  webRequest: Request,
): Promise<Response | null> => {
  const route = routes[request.path];
  if (route === undefined) {
    return new Response(`No Bun route matched for ${request.method} ${request.path}`, {
      status: 404,
    });
  }

  if (isResponseLike(route)) {
    return route;
  }

  if (typeof route === 'function') {
    const routeResult = await route(webRequest);
    return await resolveResponse(routeResult);
  }

  if (isRouteHandlers(route)) {
    const method = request.method.toUpperCase() as VerserBunDispatchMethod;
    const handler = route[method] as VerserBunDispatchRouteMethodHandler | undefined;
    if (handler !== undefined) {
      const routeResult = await handler(webRequest);
      return await resolveResponse(routeResult);
    }

    const allowedMethods = Object.keys(route) as VerserBunDispatchMethod[];
    if (allowedMethods.length > 0) {
      return dispatchBunRequestMethodNotAllowed(allowedMethods);
    }
  }

  return Promise.reject(new TypeError(DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE));
};

export async function dispatchVerserBunRequest(
  handler: VerserBunDispatchRequestHandler,
  request: VerserBunDispatchRequest,
): Promise<VerserBunDispatchResponse> {
  const requestInit: RequestInit = {
    method: request.method,
    headers: request.headers,
  };

  if (request.body !== undefined) {
    requestInit.body = request.body;
  }

  const webRequest = new Request(asRequestUrl(request), requestInit);
  const server: VerserBunDispatchServer = {
    upgrade: () => false,
  };

  const routeMatch =
    handler.routes !== undefined
      ? await dispatchByRoutes(handler.routes, request, webRequest)
      : null;

  const handlerResponse =
    routeMatch !== null
      ? routeMatch
      : handler.fetch !== undefined
        ? await resolveResponse(await handler.fetch(webRequest, server))
        : (() => {
            throw new TypeError('No matching route or fetch handler available.');
          })();

  return toVerserBunResponse(handlerResponse);
}

export function createVerserBunGuest(_options: VerserBunGuestOptions): VerserBunGuest {
  let connected = false;
  const lifecycleListeners: Array<(event: VerserBunGuestLifecycleEvent) => void> = [];

  const notifyLifecycle = (name: string, reason?: string): void => {
    const event = { name, guestId: _options.guestId, reason };
    for (const listener of lifecycleListeners) {
      listener(event);
    }
  };

  const guest: VerserBunGuest = {
    get connected() {
      return connected;
    },

    async connect(): Promise<void> {
      connected = true;
      notifyLifecycle('connected');
    },

    async close(reason?: string): Promise<void> {
      connected = false;
      notifyLifecycle('closed', reason);
    },

    attach(_serverOrListener: VerserBunGuestServerLike, _domain?: string): VerserBunGuest {
      return guest;
    },

    onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void {
      lifecycleListeners.push(listener);
      return () => {
        const index = lifecycleListeners.indexOf(listener);
        if (index >= 0) {
          lifecycleListeners.splice(index, 1);
        }
      };
    },
  };

  return guest;
}

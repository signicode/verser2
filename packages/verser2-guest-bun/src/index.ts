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

import type { VerserNodeGuest } from '@signicode/verser2-guest-node';
import { createVerserNodeGuest } from '@signicode/verser2-guest-node';

interface NodeStyleRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  on(event: string | symbol, handler: (...args: readonly [unknown]) => void): unknown;
}

interface NodeStyleResponse {
  statusCode: number;
  writeHead(statusCode: number, headers?: Record<string, string | number | boolean>): unknown;
  end(chunk?: string | Buffer, encoding?: BufferEncoding): unknown;
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const readBody = async (request: NodeStyleRequest): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    request.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
        return;
      }

      if (chunk instanceof Buffer) {
        chunks.push(chunk);
        return;
      }

      if (chunk instanceof Uint8Array) {
        chunks.push(
          Buffer.from(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
        );
        return;
      }

      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(chunk));
        return;
      }

      if (chunk !== undefined) {
        chunks.push(Buffer.from(String(chunk)));
      }
    });

    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    request.on('error', (error: unknown) => {
      reject(error);
    });
  });
};

const createNodeStyleHandler = (
  domain: string,
  handler: VerserBunDispatchRequestHandler,
): ((request: NodeStyleRequest, response: NodeStyleResponse) => void) => {
  return (request, response): void => {
    void (async () => {
      try {
        const bodyBuffer = await readBody(request);
        const bunRequest: VerserBunDispatchRequest = {
          method: request.method,
          path: request.url,
          origin: `http://${domain}`,
          headers: request.headers,
          body: bodyBuffer === null ? undefined : bodyBuffer.toString('utf8'),
        };

        const dispatchResponse = await dispatchVerserBunRequest(handler, bunRequest);
        response.statusCode = dispatchResponse.status;
        response.writeHead(dispatchResponse.status, dispatchResponse.headers);
        response.end(dispatchResponse.body);
      } catch (error: unknown) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`Bun handler failed: ${getErrorMessage(error)}`);
      }
    })();
  };
};

const bodyToBuffer = async (response: Response): Promise<Buffer> => {
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

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
  const bodyBytes = await bodyToBuffer(response);
  const body = bodyBytes.toString('utf8');
  const headers = toHeadersRecord(response.headers);
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: bodyBytes,
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

export const __internal = {
  readBody,
  createNodeStyleHandler,
};

export function createVerserBunGuest(options: VerserBunGuestOptions): VerserBunGuest {
  const nodeGuest: VerserNodeGuest = createVerserNodeGuest(options);
  const getDispatchHandler = (
    serverOrListener: VerserBunGuestServerLike,
  ): VerserBunDispatchRequestHandler => {
    if ('server' in serverOrListener) {
      const fetchHandler = serverOrListener.fetch;
      if (fetchHandler === undefined) {
        throw new TypeError('Missing Bun fetch handler in server binding.');
      }
      return fetchHandler;
    }

    return serverOrListener;
  };

  const guest: VerserBunGuest = {
    get connected(): boolean {
      return nodeGuest.connected;
    },

    attach(serverOrListener: VerserBunGuestServerLike, domain?: string): VerserBunGuest {
      const domainName = domain ?? options.guestId;
      const dispatchHandler = getDispatchHandler(serverOrListener);
      const nodeHandler = createNodeStyleHandler(domainName, dispatchHandler);
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

import type {
  VerserBunGuestRequestHandler,
  VerserBunGuestServer,
  VerserBunRequest,
  VerserBunRouteMethod,
  VerserBunRouteValue,
  VerserBunRoutes,
  VerserBunRoutesPerMethod,
} from './types';

export interface NodeStyleRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  on(event: string | symbol, handler: (...args: readonly [unknown]) => void): unknown;
}

export interface NodeStyleResponse {
  statusCode: number;
  writeHead(statusCode: number, headers?: Record<string, string | number | boolean>): unknown;
  write(chunk: string | Buffer, encoding?: BufferEncoding): boolean;
  end(chunk?: string | Buffer, encoding?: BufferEncoding): unknown;
}

const DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE = 'Handler must return a Response instance.';

const VERSER_BUN_METHODS: readonly VerserBunRouteMethod[] = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCOL',
  'MKREDIRECTREF',
  'MKWORKSPACE',
  'MOVE',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'REBIND',
  'REPORT',
  'SEARCH',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
];

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const toHeadersRecord = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name.toLowerCase()] = value;
  }
  return result;
};

interface VerserBunDispatchRequest {
  readonly method: string;
  readonly path: string;
  readonly origin: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit | null;
}

interface VerserBunDispatchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

interface VerserBunDispatchRequestHandler {
  readonly routes?: VerserBunRoutes;
  readonly fetch?: (
    request: VerserBunRequest,
    server: VerserBunGuestServer,
  ) => Promise<unknown> | unknown;
}

const asRequestUrl = (request: VerserBunDispatchRequest): string => {
  return new URL(request.path, request.origin).toString();
};

const isResponseLike = (value: unknown): value is Response => {
  return value instanceof Response;
};

const resolveResponse = (value: unknown): Promise<Response> => {
  if (isResponseLike(value)) {
    return Promise.resolve(value.clone());
  }
  return Promise.reject(new TypeError(DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE));
};

const streamRequestBody = (request: NodeStyleRequest): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      request.on('data', (chunk: unknown) => {
        if (typeof chunk === 'string') {
          controller.enqueue(Buffer.from(chunk));
          return;
        }

        if (chunk instanceof Buffer) {
          controller.enqueue(chunk);
          return;
        }

        if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
          return;
        }

        if (chunk instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(chunk));
          return;
        }

        if (chunk !== undefined) {
          controller.enqueue(Buffer.from(String(chunk)));
        }
      });
      request.on('end', () => controller.close());
      request.on('error', (error: unknown) => controller.error(error));
    },
  });
};

const hasRequestBody = (method: string): boolean => {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
};

const splitRoutePath = (path: string): readonly string[] => {
  if (path === '/') {
    return [];
  }

  return path.split('/').filter((segment) => segment.length > 0);
};

const isPotentialRouteMethodObject = (value: unknown): value is VerserBunRoutesPerMethod => {
  if (value === null || typeof value !== 'object' || isResponseLike(value)) {
    return false;
  }

  const routeMethodObject = value as Record<string, unknown>;
  const keys = Object.keys(routeMethodObject);

  return (
    keys.length > 0 &&
    keys.every((methodName) => VERSER_BUN_METHODS.includes(methodName as VerserBunRouteMethod))
  );
};

const toWebRequest = (
  request: VerserBunDispatchRequest,
  params?: Record<string, string>,
): VerserBunRequest => {
  const requestInit: RequestInit = {
    method: request.method,
    headers: request.headers,
  };

  if (request.body !== undefined && request.body !== null) {
    requestInit.body = request.body;
    (requestInit as RequestInit & { duplex: 'half' }).duplex = 'half';
  }

  const webRequest = new Request(asRequestUrl(request), requestInit);
  return Object.assign(webRequest, {
    params: params ?? {},
  }) as VerserBunRequest;
};

const toVerserBunResponse = async (response: Response): Promise<VerserBunDispatchResponse> => {
  const responseBody = response.body?.tee();
  const bodyResponse =
    responseBody === undefined
      ? response
      : new Response(responseBody[1], {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });

  const body = await bodyResponse.text();
  return {
    status: response.status,
    statusText: response.statusText,
    headers: toHeadersRecord(response.headers),
    body: responseBody?.[0] ?? null,
    text: async () => body,
    json: async () => {
      return JSON.parse(body) as unknown;
    },
  };
};

type VerserBunMatchedRoute = {
  readonly value?: VerserBunRouteValue;
  readonly params: Record<string, string>;
  readonly allow?: string;
};

const isWildcardRoutePath = (routePath: string): boolean => {
  return routePath === '*' || routePath === '/*' || routePath.endsWith('/*');
};

const tryMatchExactRoute = (
  routePath: string,
  requestPath: string,
): { params: Record<string, string> } | undefined => {
  if (routePath === requestPath) {
    return { params: {} };
  }

  return undefined;
};

const tryMatchParamRoute = (
  routePath: string,
  requestPath: string,
): { params: Record<string, string> } | undefined => {
  const routeParts = splitRoutePath(routePath);
  const requestParts = splitRoutePath(requestPath);

  if (routeParts.length !== requestParts.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < routeParts.length; index++) {
    const routePart = routeParts[index];
    const requestPart = requestParts[index] ?? '';

    if (routePart.startsWith(':')) {
      const paramName = routePart.slice(1);
      try {
        params[paramName] = decodeURIComponent(requestPart);
      } catch {
        params[paramName] = requestPart;
      }
      continue;
    }

    if (routePart !== requestPart) {
      return undefined;
    }
  }

  return { params };
};

const tryMatchWildcardRoute = (
  routePath: string,
  requestPath: string,
): { params: Record<string, string> } | undefined => {
  if (routePath === '*') {
    return { params: { '*': requestPath === '/' ? '' : requestPath.slice(1) } };
  }

  const routeParts = splitRoutePath(routePath);
  if (routeParts.length === 0 || routeParts[routeParts.length - 1] !== '*') {
    return undefined;
  }

  const prefixParts = routeParts.slice(0, routeParts.length - 1);
  const requestParts = splitRoutePath(requestPath);

  if (prefixParts.length > requestParts.length) {
    return undefined;
  }

  for (let index = 0; index < prefixParts.length; index++) {
    if (prefixParts[index] !== requestParts[index]) {
      return undefined;
    }
  }

  const wildcardParts = requestParts.slice(prefixParts.length);
  const wildcardValue = wildcardParts.join('/');

  return { params: { '*': wildcardValue } };
};

const resolveRouteMethodValues = (route: VerserBunRoutesPerMethod): string[] => {
  const allow: string[] = [];

  for (const method of VERSER_BUN_METHODS) {
    if (route[method] !== undefined) {
      allow.push(method);
    }
  }

  return allow;
};

const resolveRoute = (
  routes: VerserBunRoutes,
  requestPath: string,
  requestMethod: string,
): VerserBunMatchedRoute | undefined => {
  const method = requestMethod.toUpperCase();

  const exactEntries: Array<[string, VerserBunRouteValue | VerserBunRoutesPerMethod]> = [];
  const paramEntries: Array<[string, VerserBunRouteValue | VerserBunRoutesPerMethod]> = [];
  const wildcardEntries: Array<[string, VerserBunRouteValue | VerserBunRoutesPerMethod]> = [];

  for (const entry of Object.entries(routes) as Array<
    [string, VerserBunRouteValue | VerserBunRoutesPerMethod]
  >) {
    const [routePath] = entry;
    if (routePath.includes(':') || routePath.includes('*')) {
      if (isWildcardRoutePath(routePath)) {
        wildcardEntries.push(entry);
        continue;
      }

      paramEntries.push(entry);
      continue;
    }

    exactEntries.push(entry);
  }

  const resolveMethodRoute = (
    routeValue: VerserBunRoutesPerMethod,
    params: Record<string, string>,
  ): VerserBunMatchedRoute | undefined => {
    const routeMethod = routeValue[method as VerserBunRouteMethod];
    if (routeMethod !== undefined) {
      return {
        value: routeMethod,
        params,
      };
    }

    const allow = resolveRouteMethodValues(routeValue);
    if (allow.length === 0) {
      return undefined;
    }

    return {
      params,
      allow: allow.join(', '),
    };
  };
  for (const [routePath, routeValue] of exactEntries) {
    const match = tryMatchExactRoute(routePath, requestPath);
    if (match === undefined) {
      continue;
    }

    if (isPotentialRouteMethodObject(routeValue)) {
      const resolved = resolveMethodRoute(routeValue, match.params);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }

    return {
      value: routeValue,
      params: match.params,
    };
  }

  for (const [routePath, routeValue] of paramEntries) {
    const match = tryMatchParamRoute(routePath, requestPath);
    if (match === undefined) {
      continue;
    }

    if (isPotentialRouteMethodObject(routeValue)) {
      const resolved = resolveMethodRoute(routeValue, match.params);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }

    return {
      value: routeValue,
      params: match.params,
    };
  }

  for (const [routePath, routeValue] of wildcardEntries) {
    const match = tryMatchWildcardRoute(routePath, requestPath);
    if (match === undefined) {
      continue;
    }

    if (isPotentialRouteMethodObject(routeValue)) {
      const resolved = resolveMethodRoute(routeValue, match.params);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }

    return {
      value: routeValue,
      params: match.params,
    };
  }

  return undefined;
};

export async function dispatchVerserBunRequestInternal(
  handler: VerserBunDispatchRequestHandler,
  request: VerserBunDispatchRequest,
): Promise<VerserBunDispatchResponse> {
  const server: VerserBunGuestServer = {
    upgrade: () => false,
  };

  const requestPath = new URL(asRequestUrl(request)).pathname;
  if (handler.routes !== undefined) {
    const routeMatch = resolveRoute(handler.routes, requestPath, request.method);
    if (routeMatch !== undefined) {
      if (routeMatch.allow !== undefined) {
        const headers = new Headers();
        headers.set('Allow', routeMatch.allow);
        const notAllowed = new Response('Method Not Allowed', {
          status: 405,
          headers,
        });
        return toVerserBunResponse(notAllowed);
      }

      if (routeMatch.value !== undefined) {
        const routeResult = isResponseLike(routeMatch.value)
          ? routeMatch.value
          : routeMatch.value(toWebRequest(request, routeMatch.params), server);
        return toVerserBunResponse(await resolveResponse(await routeResult));
      }
    }
  }

  if (handler.fetch === undefined) {
    return toVerserBunResponse(await resolveResponse(new Response('Not Found', { status: 404 })));
  }

  return toVerserBunResponse(
    await resolveResponse(await handler.fetch(toWebRequest(request), server)),
  );
}

const writeResponseBody = async (
  source: ReadableStream<Uint8Array> | null,
  response: NodeStyleResponse,
): Promise<void> => {
  if (source === null) {
    response.end();
    return;
  }

  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        response.end();
        return;
      }
      response.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
};

export const createNodeStyleHandler = (
  domain: string,
  handler: VerserBunGuestRequestHandler,
): ((request: NodeStyleRequest, response: NodeStyleResponse) => void) => {
  return (request, response): void => {
    void (async () => {
      try {
        const bunRequest: VerserBunDispatchRequest = {
          method: request.method,
          path: request.url,
          origin: `http://${domain}`,
          headers: request.headers,
          body: hasRequestBody(request.method) ? streamRequestBody(request) : undefined,
        };

        const webResponse = await dispatchVerserBunRequestInternal(handler, bunRequest);

        response.statusCode = webResponse.status;
        response.writeHead(webResponse.status, webResponse.headers);
        await writeResponseBody(webResponse.body, response);
      } catch (error: unknown) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`Bun handler failed: ${getErrorMessage(error)}`);
      }
    })();
  };
};

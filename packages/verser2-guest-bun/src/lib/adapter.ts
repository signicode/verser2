import { DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE } from './constants';
import { resolveRoute } from './routes';
import type {
  VerserBunGuestRequestHandler,
  VerserBunGuestServer,
  VerserBunRequest,
  VerserBunRoutes,
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
  const originalResponseBody = response.body;
  let textBodyPromise: Promise<string> | undefined;
  let bodyAccessMode: 'none' | 'stream' | 'text-json' = 'none';

  const consumeBodyError = () => {
    throw new TypeError('Response body has already been consumed');
  };

  const setTextJsonMode = () => {
    if (bodyAccessMode === 'stream') {
      consumeBodyError();
    }
    bodyAccessMode = 'text-json';
  };

  const getTextBody = async (): Promise<string> => {
    setTextJsonMode();

    if (textBodyPromise === undefined) {
      textBodyPromise = response.text().catch((error) => {
        textBodyPromise = undefined;
        throw error;
      });
    }

    return textBodyPromise;
  };

  const dispatchResponse: VerserBunDispatchResponse = {
    status: response.status,
    statusText: response.statusText,
    headers: toHeadersRecord(response.headers),
    body: null,
    text: async () => {
      const bodyValue = await getTextBody();
      return bodyValue;
    },
    json: async () => {
      const bodyValue = await getTextBody();
      return JSON.parse(bodyValue) as unknown;
    },
  };

  Object.defineProperty(dispatchResponse, 'body', {
    enumerable: true,
    configurable: true,
    get() {
      if (bodyAccessMode !== 'none') {
        consumeBodyError();
      }

      if (originalResponseBody === null) {
        return null;
      }

      bodyAccessMode = 'stream';
      return originalResponseBody;
    },
  });

  return dispatchResponse;
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

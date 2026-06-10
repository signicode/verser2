import type { VerserBunGuestRequestHandler, VerserBunGuestServer } from './types';

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
  readonly body: string | Buffer;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

interface VerserBunDispatchRequestHandler {
  readonly fetch?: (request: Request, server: VerserBunGuestServer) => Promise<unknown> | unknown;
}

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

const toWebRequest = (request: VerserBunDispatchRequest): Request => {
  const requestInit: RequestInit = {
    method: request.method,
    headers: request.headers,
  };

  if (request.body !== undefined && request.body !== null) {
    requestInit.body = request.body;
    (requestInit as RequestInit & { duplex: 'half' }).duplex = 'half';
  }

  return new Request(asRequestUrl(request), requestInit);
};

const toVerserBunResponse = async (response: Response): Promise<VerserBunDispatchResponse> => {
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  const body = bodyBytes.toString('utf8');
  return {
    status: response.status,
    statusText: response.statusText,
    headers: toHeadersRecord(response.headers),
    body: bodyBytes,
    text: async () => body,
    json: async () => {
      return JSON.parse(body) as unknown;
    },
  };
};

export async function dispatchVerserBunRequestInternal(
  handler: VerserBunDispatchRequestHandler,
  request: VerserBunDispatchRequest,
): Promise<VerserBunDispatchResponse> {
  const webRequest = toWebRequest(request);
  const server: VerserBunGuestServer = {
    upgrade: () => false,
  };

  if (handler.fetch === undefined) {
    throw new TypeError('No fetch handler is available for the Bun Guest request.');
  }

  return toVerserBunResponse(await resolveResponse(await handler.fetch(webRequest, server)));
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

        const webResponse = await resolveResponse(
          await handler.fetch?.(toWebRequest(bunRequest), { upgrade: () => false }),
        );
        response.statusCode = webResponse.status;
        response.writeHead(webResponse.status, toHeadersRecord(webResponse.headers));
        await writeResponseBody(webResponse.body, response);
      } catch (error: unknown) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`Bun handler failed: ${getErrorMessage(error)}`);
      }
    })();
  };
};

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
  off?(event: string | symbol, handler: (...args: readonly [unknown]) => void): unknown;
  pause?(): void;
  resume?(): void;
  destroy?(error?: Error): void;
}

export interface NodeStyleResponse {
  statusCode: number;
  writeHead(statusCode: number, headers?: Record<string, string | number | boolean>): unknown;
  write(chunk: string | Buffer, encoding?: BufferEncoding): boolean;
  end(chunk?: string | Buffer, encoding?: BufferEncoding): unknown;
  on?(event: string, handler: (...args: readonly unknown[]) => void): unknown;
  off?(event: string, handler: (...args: readonly unknown[]) => void): unknown;
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

const resolveResponse = (value: unknown, reuseStaticResponse = false): Promise<Response> => {
  if (isResponseLike(value)) {
    return Promise.resolve(reuseStaticResponse ? value.clone() : value);
  }
  return Promise.reject(new TypeError(DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE));
};

const toBuffer = (chunk: unknown): Buffer | undefined => {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Buffer) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (chunk !== undefined) return Buffer.from(String(chunk));
  return undefined;
};

export const streamRequestBody = (request: NodeStyleRequest): ReadableStream<Uint8Array> => {
  let dataHandler: ((chunk: unknown) => void) | undefined;
  let endHandler: (() => void) | undefined;
  let errorHandler: ((error: unknown) => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      dataHandler = (chunk: unknown) => {
        const buf = toBuffer(chunk);
        if (buf === undefined) return;

        try {
          controller.enqueue(buf);

          // Pause the Node source when the Web consumer's buffer is full
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            request.pause?.();
          }
        } catch {
          request.destroy?.();
        }
      };
      endHandler = () => {
        try {
          controller.close();
        } catch {
          /* ignore if already errored/closed */
        }
      };
      errorHandler = (error: unknown) => {
        try {
          controller.error(error);
        } catch {
          /* ignore if already errored/closed */
        }
      };
      request.on('data', dataHandler);
      request.on('end', endHandler);
      request.on('error', errorHandler);
    },
    pull() {
      // Consumer has consumed data; resume the Node source for more
      request.resume?.();
    },
    cancel(reason) {
      request.destroy?.(reason instanceof Error ? reason : undefined);
      if (dataHandler !== undefined) request.off?.('data', dataHandler);
      if (endHandler !== undefined) request.off?.('end', endHandler);
      if (errorHandler !== undefined) request.off?.('error', errorHandler);
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
        const staticRouteResponse = isResponseLike(routeMatch.value);
        const routeResult = staticRouteResponse
          ? routeMatch.value
          : routeMatch.value(toWebRequest(request, routeMatch.params), server);
        return toVerserBunResponse(await resolveResponse(await routeResult, staticRouteResponse));
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
  let sinkTerminated = false;
  let sourceCancellation: Promise<void> | undefined;
  let resolveTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });
  let terminationSettled = false;
  const terminate = (reason: unknown) => {
    if (terminationSettled) return;
    terminationSettled = true;
    sinkTerminated = true;
    sourceCancellation = reader.cancel(reason).then(() => undefined);
    resolveTermination();
  };
  const onClose = () => terminate(new Error('Response sink closed'));
  const onFinish = () => terminate(new Error('Response sink finished'));
  const onError = (error: unknown) => terminate(error);
  response.on?.('close', onClose);
  response.on?.('finish', onFinish);
  response.on?.('error', onError);

  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        termination.then(() => ({ done: true, terminated: true as const })),
      ]);
      if ('terminated' in result) return;
      const { done, value } = result;
      if (done) {
        response.end();
        return;
      }
      const canContinue = response.write(Buffer.from(value));
      if (!canContinue) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const onDrain = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          };
          const onWaitClose = () => {
            if (settled) return;
            settled = true;
            cleanup();
            terminate(new Error('Response sink closed'));
            resolve();
          };
          const onWaitFinish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            terminate(new Error('Response sink finished'));
            resolve();
          };
          const onWaitError = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            terminate(error);
            reject(error instanceof Error ? error : new Error(String(error)));
          };
          const cleanup = () => {
            response.off?.('drain', onDrain);
            response.off?.('close', onWaitClose);
            response.off?.('finish', onWaitFinish);
            response.off?.('error', onWaitError);
          };
          response.on?.('drain', onDrain);
          response.on?.('close', onWaitClose);
          response.on?.('finish', onWaitFinish);
          response.on?.('error', onWaitError);
          // If no event support (mock without on/off), proceed anyway
          if (response.on === undefined) {
            resolve();
          }
        });
        // close/finish terminated the sink — stop writing
        if (sinkTerminated) {
          return;
        }
      }
    }
  } finally {
    response.off?.('close', onClose);
    response.off?.('finish', onFinish);
    response.off?.('error', onError);
    if (sinkTerminated) {
      await sourceCancellation;
    }
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

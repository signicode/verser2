import { type VerserHeaderPair, createVerserError } from '@signicode/verser-common';
import { DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE } from './constants';
import { resolveRoute } from './routes';
import type {
  VerserBunGuestRequestHandler,
  VerserBunGuestServer,
  VerserBunRequest,
  VerserBunRoutes,
  VerserBunUpgradeOptions,
  VerserBunWebSocket,
  VerserBunWebSocketHandler,
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
  readonly finished?: boolean;
  readonly destroyed?: boolean;
  writeHead(statusCode: number, headers?: ResponseHeaders): unknown;
  writeHead(statusCode: number, statusMessage?: string, headers?: ResponseHeaders): unknown;
  write(chunk: string | Buffer, encoding?: BufferEncoding): boolean;
  end(chunk?: string | Buffer, encoding?: BufferEncoding): unknown;
  on?(event: string, handler: (...args: readonly unknown[]) => void): unknown;
  off?(event: string, handler: (...args: readonly unknown[]) => void): unknown;
  emit?(event: string | symbol, ...args: readonly unknown[]): boolean;
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

interface NodeStyleErrorResponse extends NodeStyleResponse {
  emit(event: 'error', error: Error): boolean;
}

const hasErrorChannel = (response: NodeStyleResponse): response is NodeStyleErrorResponse => {
  return typeof response.emit === 'function';
};

const toError = (error: unknown): Error => {
  return error instanceof Error ? error : new Error(String(error));
};

const toHeaderPairs = (headers: Headers): VerserHeaderPair[] => {
  const pairs = [...headers.entries()].map(
    ([name, value]): VerserHeaderPair => [name.toLowerCase(), value],
  );
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie === undefined) return pairs;
  const setCookies = getSetCookie.call(headers);
  if (setCookies.length === 0) return pairs;
  return [
    ...pairs.filter(([name]) => name !== 'set-cookie'),
    ...setCookies.map((value): VerserHeaderPair => ['set-cookie', value]),
  ];
};

interface VerserBunDispatchRequest {
  readonly method: string;
  readonly path: string;
  readonly origin: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit | null;
  readonly signal?: AbortSignal;
}

interface VerserBunDispatchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headerPairs: readonly VerserHeaderPair[];
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
  readonly websocket?: VerserBunWebSocketHandler;
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
  let closeHandler: (() => void) | undefined;
  let flowListenersRemoved = false;

  const removeFlowListeners = (): void => {
    if (flowListenersRemoved) return;
    flowListenersRemoved = true;
    if (dataHandler !== undefined) request.off?.('data', dataHandler);
    if (endHandler !== undefined) request.off?.('end', endHandler);
  };
  const removeAllListeners = (): void => {
    removeFlowListeners();
    if (errorHandler !== undefined) request.off?.('error', errorHandler);
    if (closeHandler !== undefined) request.off?.('close', closeHandler);
  };

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
        removeFlowListeners();
        try {
          controller.close();
        } catch {
          /* ignore if already errored/closed */
        }
      };
      errorHandler = (error: unknown) => {
        removeFlowListeners();
        try {
          controller.error(error);
        } catch {
          /* ignore if already errored/closed */
        }
      };
      closeHandler = () => removeAllListeners();
      request.on('data', dataHandler);
      request.on('end', endHandler);
      request.on('error', errorHandler);
      request.on('close', closeHandler);
    },
    pull() {
      // Consumer has consumed data; resume the Node source for more
      request.resume?.();
    },
    cancel(reason) {
      removeFlowListeners();
      request.destroy?.(reason instanceof Error ? reason : undefined);
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
    signal: request.signal,
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
    headerPairs: toHeaderPairs(response.headers),
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

/**
 * Adapts Bun's synchronous `server.upgrade()` convention to the Guest's
 * VWS/1 lease handler. The returned callback is intentionally separate from
 * the HTTP adapter: an HTTP request can never accidentally consume a WebSocket
 * lease, and route advertisements remain unchanged.
 */
export const createNodeStyleWebSocketHandler = (
  domain: string,
  handler: VerserBunDispatchRequestHandler,
): ((
  open: { domain: string; path: string; protocol: string },
  ws: VerserBunWebSocket,
) => { protocol?: string } | false | Promise<{ protocol?: string } | false>) => {
  return (open, ws) => {
    let upgraded = false;
    let upgradeOptions: VerserBunUpgradeOptions | undefined;
    const server: VerserBunGuestServer = {
      upgrade(request, options) {
        if (upgraded || request !== webRequest) return false;
        // VWS/1 has no response-header field. Do not silently discard Bun
        // upgrade headers; callers must use the application protocol instead.
        if (options?.headers !== undefined) return false;
        const selectedProtocol = options?.protocol ?? open.protocol;
        if (selectedProtocol !== '' && selectedProtocol !== open.protocol) return false;
        upgradeOptions = options;
        upgraded = true;
        return upgraded;
      },
    };
    const webRequest = toWebRequest({
      method: 'GET',
      path: open.path,
      origin: `http://${domain}`,
      headers: {},
    });

    const invoke = async (): Promise<{ protocol?: string } | false> => {
      const requestPath = new URL(webRequest.url).pathname;
      const routeMatch =
        handler.routes === undefined ? undefined : resolveRoute(handler.routes, requestPath, 'GET');
      let value: unknown;
      if (routeMatch?.allow !== undefined) {
        throw createVerserError('missing-guest', 'WebSocket endpoint is unavailable', {
          domain,
          path: open.path,
          status: 404,
        });
      }
      if (routeMatch?.value !== undefined) {
        value = isResponseLike(routeMatch.value)
          ? routeMatch.value
          : await routeMatch.value(
              Object.assign(webRequest, { params: routeMatch.params }),
              server,
            );
      } else if (handler.fetch !== undefined) {
        value = await handler.fetch(webRequest, server);
      }

      // Bun treats a request as upgraded only when the handler calls upgrade.
      if (upgraded) {
        const selectedProtocol = upgradeOptions?.protocol ?? open.protocol;
        (ws as unknown as { protocol: string; data?: unknown }).protocol = selectedProtocol;
        (ws as unknown as { data?: unknown }).data = upgradeOptions?.data;
        wireBunWebSocketCallbacks(ws, handler.websocket);
        return { protocol: selectedProtocol };
      }
      // A Response is an explicit endpoint result (normally 404). A missing
      // response is a negotiation failure; close without sending an error frame.
      if (value === undefined) {
        throw createVerserError(
          'websocket-negotiation-failed',
          'WebSocket negotiation response missing',
          { domain, path: open.path },
        );
      }
      const status = value instanceof Response ? value.status : 404;
      throw createVerserError('missing-guest', 'WebSocket endpoint is unavailable', {
        domain,
        path: open.path,
        status,
      });
    };

    return invoke();
  };
};

interface BunNodeWebSocket {
  readonly readyState: number;
  readonly protocol: string;
  readonly data?: unknown;
  send(
    data: string | Uint8Array | ArrayBuffer,
    options?: { type: 'text' | 'binary' },
  ): Promise<void> | void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  getBufferedAmount?: () => number;
  readonly bufferedAmount?: number;
  ping?: (data?: string) => Promise<void>;
  pong?: (data?: string) => Promise<void>;
  onopen: BunEventHandler<unknown> | null;
  onmessage: BunEventHandler<{ data: string | Buffer | ArrayBuffer }> | null;
  onclose: BunEventHandler<{ code: number; reason: string }> | null;
  onerror: ((error: Error) => void | Promise<void>) | null;
}

type BunEventHandler<T> = { bivarianceHack(event: T): void }['bivarianceHack'];

/** Wraps the Node VWS object with Bun's default-send and EventHandler shape. */
export const createBunWebSocketFacade = (ws: BunNodeWebSocket): VerserBunWebSocket => {
  let pendingBytes = 0;
  let drainListener: (() => void) | undefined;
  const bunSocket: VerserBunWebSocket = {
    get readyState() {
      return ws.readyState;
    },
    get protocol() {
      return ws.protocol;
    },
    get data() {
      return ws.data;
    },
    get bufferedAmount() {
      const transportBuffered =
        typeof ws.getBufferedAmount === 'function'
          ? ws.getBufferedAmount()
          : (ws.bufferedAmount ?? 0);
      return Math.max(pendingBytes, transportBuffered);
    },
    send(data) {
      if (ws.readyState !== 1) return 0;
      const payload =
        typeof data === 'string'
          ? data
          : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      const byteLength = Buffer.byteLength(payload);
      const underPressure = pendingBytes > 0;
      pendingBytes += byteLength;
      const sendOptions = {
        type: typeof data === 'string' ? ('text' as const) : ('binary' as const),
      };
      const completeWhenDrained = (): void => {
        const getBufferedAmount = ws.getBufferedAmount;
        const readBufferedAmount =
          typeof getBufferedAmount === 'function'
            ? () => getBufferedAmount.call(ws)
            : ws.bufferedAmount === undefined
              ? undefined
              : () => ws.bufferedAmount ?? 0;
        if (readBufferedAmount === undefined) {
          pendingBytes -= byteLength;
          if (pendingBytes === 0) drainListener?.();
          return;
        }
        const waitForZero = (): void => {
          if (readBufferedAmount() === 0) {
            pendingBytes -= byteLength;
            if (pendingBytes === 0) drainListener?.();
            return;
          }
          setImmediate(waitForZero);
        };
        waitForZero();
      };
      try {
        const result = ws.send(payload, sendOptions);
        if (
          result === undefined &&
          typeof ws.getBufferedAmount !== 'function' &&
          ws.bufferedAmount === undefined
        )
          return byteLength;
        Promise.resolve(result).then(completeWhenDrained, (error: unknown) => {
          pendingBytes -= byteLength;
          void Promise.resolve(
            bunSocket.onerror?.(error instanceof Error ? error : new Error(String(error))),
          ).catch(() => undefined);
          ws.close(1011, 'send failed');
        });
      } catch (error: unknown) {
        pendingBytes -= byteLength;
        void Promise.resolve(
          bunSocket.onerror?.(error instanceof Error ? error : new Error(String(error))),
        ).catch(() => undefined);
        ws.close(1011, 'send failed');
      }
      return underPressure ? -1 : byteLength;
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    terminate() {
      ws.terminate?.();
    },
    getBufferedAmount() {
      return typeof ws.getBufferedAmount === 'function'
        ? ws.getBufferedAmount()
        : (ws.bufferedAmount ?? 0);
    },
    ping(data) {
      return ws.ping?.(data) ?? Promise.resolve();
    },
    pong(data) {
      return ws.pong?.(data) ?? Promise.resolve();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => bunSocket.onopen?.({ type: 'open', target: bunSocket });
  ws.onmessage = (event) => {
    const data =
      event.data instanceof Buffer
        ? event.data
        : event.data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(event.data))
          : event.data;
    bunSocket.onmessage?.({ data });
  };
  ws.onclose = (event) => bunSocket.onclose?.(event);
  ws.onerror = (error) => {
    void Promise.resolve(bunSocket.onerror?.(error)).catch(() => ws.close(1011, 'callback failed'));
  };
  (
    bunSocket as VerserBunWebSocket & { setDrainListener(listener: () => void): void }
  ).setDrainListener = (listener) => {
    drainListener = listener;
  };
  return bunSocket;
};

const wireBunWebSocketCallbacks = (
  ws: VerserBunWebSocket,
  callbacks: VerserBunWebSocketHandler | undefined,
): void => {
  if (callbacks === undefined) return;
  const nodeSocket = ws as unknown as BunNodeWebSocket;
  const bunSocket = createBunWebSocketFacade(nodeSocket);
  const cleanupAfterCallbackFailure = (error: unknown): void => {
    try {
      bunSocket.close(
        1011,
        error instanceof Error ? error.message.slice(0, 123) : 'callback failed',
      );
    } catch {
      // The transport may already be closed; cleanup is best effort.
    }
  };
  const handleCallback = (callback: () => void | Promise<void>): void => {
    try {
      void Promise.resolve(callback()).catch(cleanupAfterCallbackFailure);
    } catch (error) {
      cleanupAfterCallbackFailure(error);
    }
  };
  (
    bunSocket as VerserBunWebSocket & { setDrainListener(listener: () => void): void }
  ).setDrainListener(() => handleCallback(() => callbacks.drain?.(bunSocket)));
  bunSocket.onopen = () => {
    handleCallback(() => callbacks.open?.(bunSocket));
  };
  bunSocket.onmessage = (event) => {
    handleCallback(() => callbacks.message?.(bunSocket, event.data));
  };
  bunSocket.onclose = (event) => {
    handleCallback(() => callbacks.close?.(bunSocket, event.code, event.reason));
  };
  bunSocket.onerror = (error) => {
    handleCallback(() => callbacks.error?.(bunSocket, error));
  };
};

interface ResponseTermination {
  readonly stopped: boolean;
  readonly reason: unknown;
  registerWakeup(wake: () => void): () => void;
}

interface ReadyResponse {
  readonly response: VerserBunDispatchResponse;
  readonly body: ReadableStream<Uint8Array> | null;
}

const readResponseChunk = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  termination: ResponseTermination,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> => {
  if (termination.stopped) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    let unregister = (): void => undefined;
    const settle = (result: ReadableStreamReadResult<Uint8Array> | undefined): void => {
      if (settled) return;
      settled = true;
      unregister();
      resolve(result);
    };
    unregister = termination.registerWakeup(() => settle(undefined));
    if (termination.stopped) return;
    try {
      void reader.read().then(settle, (error: unknown) => {
        if (termination.stopped) settle(undefined);
        else {
          if (settled) return;
          settled = true;
          unregister();
          reject(error);
        }
      });
    } catch (error) {
      if (termination.stopped) settle(undefined);
      else reject(error);
    }
  });
};

const waitForResponseDrain = (
  response: NodeStyleResponse,
  termination: ResponseTermination,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (termination.stopped) {
      resolve(false);
      return;
    }
    let settled = false;
    let unregister = (): void => undefined;
    const settle = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      response.off?.('drain', onDrain);
      unregister();
      resolve(drained);
    };
    const onDrain = (): void => settle(true);
    unregister = termination.registerWakeup(() => settle(false));
    if (settled || termination.stopped) {
      settle(false);
      return;
    }
    response.on?.('drain', onDrain);
    if (response.on === undefined) settle(!termination.stopped);
  });

const discardResponseBody = async (
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): Promise<void> => {
  if (body === null) return;
  try {
    await body.cancel(reason);
  } catch {
    // The handler may already own the stream; disposal remains best-effort.
  }
};

const writeResponseBody = async (
  source: ReadableStream<Uint8Array> | null,
  response: NodeStyleResponse,
  termination: ResponseTermination,
): Promise<void> => {
  if (source === null) {
    if (!termination.stopped) response.end();
    return;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const cancel = async (reason: unknown): Promise<void> => {
    if (reader === undefined || cancelled) return;
    cancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // Own cancellation rejection without masking the original stream error.
    }
  };
  try {
    reader = source.getReader();
    while (!termination.stopped) {
      const result = await readResponseChunk(reader, termination);
      if (result === undefined || termination.stopped) break;
      if (result.done) {
        if (!termination.stopped) response.end();
        break;
      }
      const canContinue = response.write(Buffer.from(result.value));
      if (termination.stopped) break;
      if (!canContinue && !(await waitForResponseDrain(response, termination))) break;
    }
  } finally {
    try {
      if (termination.stopped) await cancel(termination.reason);
    } finally {
      reader?.releaseLock();
    }
  }
};

export const createNodeStyleHandler = (
  domain: string,
  handler: VerserBunGuestRequestHandler,
): ((request: NodeStyleRequest, response: NodeStyleResponse) => void) => {
  return (request, response): void => {
    void (async () => {
      const abortController = new AbortController();
      let requestBodyEnded = false;
      let responseFinished = false;
      let state: 'active' | 'finished' | 'aborted' = 'active';
      let terminationReason: unknown;
      let wakeup: (() => void) | undefined;
      const termination: ResponseTermination = {
        get stopped() {
          return state !== 'active';
        },
        get reason() {
          return terminationReason;
        },
        registerWakeup(wake) {
          if (state !== 'active') {
            wake();
            return () => undefined;
          }
          wakeup = wake;
          return () => {
            if (wakeup === wake) wakeup = undefined;
          };
        },
      };
      const stop = (
        nextState: 'finished' | 'aborted',
        error?: unknown,
        destroyRequest = true,
      ): void => {
        if (state !== 'active') return;
        state = nextState;
        terminationReason = error;
        if (nextState === 'aborted') abortController.abort(toError(error));
        const wake = wakeup;
        wakeup = undefined;
        wake?.();
        if (nextState === 'aborted' && destroyRequest && !requestBodyEnded) {
          request.destroy?.(toError(error));
        }
      };
      const onRequestError = (error: unknown): void => stop('aborted', error, false);
      const onResponseError = (error: unknown): void => stop('aborted', error);
      const onResponseFinish = (): void => {
        responseFinished = true;
        stop('finished');
      };
      const onResponseClose = (): void => {
        if (responseFinished || response.finished === true) stop('finished');
        else stop('aborted', new Error('Response sink closed before finish'));
      };
      const onRequestEnd = (): void => {
        requestBodyEnded = true;
      };

      request.on('error', onRequestError);
      request.on('end', onRequestEnd);
      response.on?.('error', onResponseError);
      response.on?.('finish', onResponseFinish);
      response.on?.('close', onResponseClose);

      try {
        const bunRequest: VerserBunDispatchRequest = {
          method: request.method,
          path: request.url,
          origin: `http://${domain}`,
          headers: request.headers,
          body: hasRequestBody(request.method) ? streamRequestBody(request) : undefined,
          signal: abortController.signal,
        };

        let readyResponse: ReadyResponse | undefined;
        let handlerError: unknown;
        let handlerRejected = false;
        let notification!: () => void;
        const delivered = new Promise<void>((resolve) => {
          notification = resolve;
        });
        const unregisterDelivery = termination.registerWakeup(notification);
        const pendingResponse = dispatchVerserBunRequestInternal(handler, bunRequest);
        void pendingResponse
          .then(
            (webResponse) => {
              let body: ReadableStream<Uint8Array> | null;
              try {
                body = webResponse.body;
              } catch (error) {
                handlerError = error;
                handlerRejected = true;
                notification();
                return;
              }
              if (termination.stopped) {
                void discardResponseBody(body, termination.reason).catch(() => undefined);
                return;
              }
              readyResponse = { response: webResponse, body };
              notification();
            },
            (error: unknown) => {
              if (!termination.stopped) {
                handlerError = error;
                handlerRejected = true;
              }
              notification();
            },
          )
          .catch(() => undefined);
        await delivered;
        unregisterDelivery();
        if (termination.stopped) {
          const abandoned = readyResponse;
          readyResponse = undefined;
          if (abandoned !== undefined) {
            await discardResponseBody(abandoned.body, termination.reason);
          }
          return;
        }
        if (handlerRejected) throw handlerError;
        const selected = readyResponse;
        readyResponse = undefined;
        if (selected === undefined || termination.stopped) {
          if (selected !== undefined) await discardResponseBody(selected.body, termination.reason);
          return;
        }
        try {
          response.statusCode = selected.response.status;
          if (termination.stopped) {
            await discardResponseBody(selected.body, termination.reason);
            return;
          }
          response.writeHead(
            selected.response.status,
            selected.response.statusText,
            selected.response.headerPairs,
          );
          if (termination.stopped) {
            await discardResponseBody(selected.body, termination.reason);
            return;
          }
          await writeResponseBody(selected.body, response, termination);
        } catch (error) {
          await discardResponseBody(selected.body, error);
          throw error;
        }
      } catch (error: unknown) {
        if (abortController.signal.aborted) return;
        if (hasErrorChannel(response)) {
          response.emit('error', toError(error));
          return;
        }
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`Bun handler failed: ${getErrorMessage(error)}`);
      } finally {
        if (state === 'active' && response.finished === true) stop('finished');
        request.off?.('error', onRequestError);
        request.off?.('end', onRequestEnd);
        response.off?.('error', onResponseError);
        response.off?.('finish', onResponseFinish);
        response.off?.('close', onResponseClose);
      }
    })();
  };
};

type ResponseHeaders =
  | Record<string, string | number | boolean>
  | readonly (readonly [string, string | number | boolean])[];

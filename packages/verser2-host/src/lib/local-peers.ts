import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { PassThrough, Readable } from 'node:stream';

import {
  type RoutedDomainRegistration,
  type VerserPeerId,
  createVerserError,
  flattenVerserHeaders,
  validateVerserHeaders,
} from '@signicode/verser-common';
import type {
  VerserLocalBrokerRequest,
  VerserLocalBrokerResponse,
  VerserLocalGuestOptions,
  VerserLocalGuestRequestListener,
} from './types';

export interface LocalGuestState {
  readonly listener: VerserLocalGuestRequestListener;
}

export interface LocalBrokerState {
  routes: RoutedDomainRegistration[];
  routeWaiters: Map<string, (() => void)[]>;
  requestCounter: number;
  closed: boolean;
}

export interface LocalDispatchRequest {
  readonly requestId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Readable;
}

type LocalRequest = Readable & {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
};

class LocalIncomingMessage extends PassThrough implements LocalRequest {
  public readonly method: string;

  public readonly url: string;

  public readonly headers: Record<string, string>;

  public constructor(request: LocalDispatchRequest) {
    super();
    this.method = request.method;
    this.url = request.path;
    this.headers = request.headers;
    request.body.once('error', (error) => this.destroy(error));
    request.body.pipe(this);
  }
}

class LocalServerResponse extends EventEmitter {
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly bodyStream = new PassThrough();

  private started = false;

  public get headersStarted(): boolean {
    return this.started;
  }

  public setHeader(name: string, value: string | number | boolean): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  public getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  public writeHead(
    statusCode: number,
    headers: Record<string, string | number | boolean> = {},
  ): this {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
    return this;
  }

  public write(chunk: string | Buffer, encoding: BufferEncoding = 'utf8'): boolean {
    this.start();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    return this.bodyStream.write(buffer);
  }

  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    } else {
      this.start();
    }
    this.bodyStream.end();
    this.emit('finish');
    return this;
  }

  public toBrokerResponse(requestId: string): VerserLocalBrokerResponse {
    return {
      requestId,
      statusCode: this.statusCode,
      headers: flattenVerserHeaders(validateVerserHeaders(Object.fromEntries(this.headers))),
      body: this.bodyStream,
    };
  }

  public fail(error: Error): void {
    this.bodyStream.destroy(error);
    this.emit('error', error);
  }

  private start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.emit('response');
  }
}

export function createLocalBrokerState(routes: RoutedDomainRegistration[]): LocalBrokerState {
  return {
    routes,
    routeWaiters: new Map(),
    requestCounter: 0,
    closed: false,
  };
}

export function updateLocalBrokerRoutes(
  broker: LocalBrokerState,
  routes: RoutedDomainRegistration[],
): void {
  broker.routes = [...routes];
  for (const route of routes) {
    for (const resolve of broker.routeWaiters.get(route.domain) ?? []) {
      resolve();
    }
    broker.routeWaiters.delete(route.domain);
  }
}

export function waitForLocalBrokerRoute(broker: LocalBrokerState, domain: string): Promise<void> {
  if (broker.routes.some((route) => route.domain === domain)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    broker.routeWaiters.set(domain, [...(broker.routeWaiters.get(domain) ?? []), resolve]);
  });
}

export function toReadableBody(body: VerserLocalBrokerRequest['body']): Readable {
  if (body === undefined) {
    return Readable.from([]);
  }
  if (body instanceof Readable) {
    return body;
  }
  return Readable.from(body);
}

export function extractLocalGuestListener(
  peerId: VerserPeerId,
  serverOrListener: VerserLocalGuestOptions['listener'],
): VerserLocalGuestRequestListener {
  if (serverOrListener instanceof http.Server) {
    const listener = serverOrListener.listeners('request')[0];
    if (listener === undefined) {
      throw createVerserError(
        'local-handler-failure',
        'Attached HTTP server has no request listener',
        {
          guestId: peerId,
        },
      );
    }
    return listener as unknown as VerserLocalGuestRequestListener;
  }

  return serverOrListener;
}

export function dispatchLocalGuestRequest(
  request: LocalDispatchRequest,
  listener: VerserLocalGuestRequestListener,
): Promise<VerserLocalBrokerResponse> {
  const localRequest = new LocalIncomingMessage(request);
  const localResponse = new LocalServerResponse();
  return new Promise((resolve, reject) => {
    const failBeforeResponse = (error: unknown): void => {
      reject(createLocalHandlerError(request, error));
    };

    localResponse.once('response', () =>
      resolve(localResponse.toBrokerResponse(request.requestId)),
    );
    localResponse.once('error', (error) => {
      if (!localResponse.headersStarted) {
        failBeforeResponse(error);
      }
    });

    try {
      listener(localRequest, localResponse);
    } catch (error) {
      const verserError = createLocalHandlerError(request, error);
      if (localResponse.headersStarted) {
        localResponse.fail(verserError);
        resolve(localResponse.toBrokerResponse(request.requestId));
        return;
      }
      reject(verserError);
    }
  });
}

function createLocalHandlerError(request: LocalDispatchRequest, error: unknown): Error {
  return createVerserError('local-handler-failure', getErrorMessage(error), {
    targetId: request.targetId,
    requestId: request.requestId,
    path: request.path,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

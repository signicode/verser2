import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import { Readable } from 'node:stream';

import {
  type RoutedRequestEnvelope,
  type RoutedResponseEnvelope,
  VERSER_LIFECYCLE_EVENTS,
  type VerserError,
  createDevelopmentTlsCertificate,
  createGuestId,
  createRoutedRequestEnvelope,
  createRoutedResponseEnvelope,
  createVerserError,
} from '@signicode/verser-common';

export const VERSER2_GUEST_NODE_PACKAGE_NAME = '@signicode/verser2-guest-node';

export interface VerserNodeGuestOptions {
  readonly hostUrl: string;
  readonly guestId: string;
  readonly routedDomains?: readonly string[];
}

export interface VerserNodeGuestLifecycleEvent {
  readonly name: string;
  readonly guestId: string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly error?: VerserError;
}

export interface VerserNodeGuestDispatchRequest extends RoutedRequestEnvelope {
  readonly body: readonly (string | Buffer)[];
}

export interface VerserNodeGuestDispatchResponse extends RoutedResponseEnvelope {
  readonly body: Buffer;
}

export interface VerserNodeGuest {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(reason?: string): Promise<void>;
  attach(serverOrListener: http.Server | NodeRequestListener, domain?: string): this;
  dispatchRoutedRequest(
    request: VerserNodeGuestDispatchRequest,
  ): Promise<VerserNodeGuestDispatchResponse>;
  onLifecycle(listener: (event: VerserNodeGuestLifecycleEvent) => void): () => void;
}

export type NodeRequestListener = (
  request: MinimalIncomingMessage,
  response: MinimalServerResponse,
) => void;

export function createVerserNodeGuest(options: VerserNodeGuestOptions): VerserNodeGuest {
  return new Http2VerserNodeGuest(options);
}

export class MinimalIncomingMessage extends Readable {
  public readonly method: string;

  public readonly url: string;

  public readonly headers: Record<string, string>;

  private readonly body: readonly (string | Buffer)[];

  public constructor(request: VerserNodeGuestDispatchRequest) {
    super();
    this.method = request.method;
    this.url = request.path;
    this.headers = request.headers;
    this.body = request.body;
  }

  public override _read(): void {
    for (const chunk of this.body) {
      this.push(chunk);
    }
    this.push(null);
  }
}

export class MinimalServerResponse extends EventEmitter {
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly chunks: Buffer[] = [];

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
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return true;
  }

  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    }
    this.emit('finish');
    return this;
  }

  public toDispatchResponse(requestId: string): VerserNodeGuestDispatchResponse {
    return {
      ...createRoutedResponseEnvelope({
        requestId,
        statusCode: this.statusCode,
        headers: Object.fromEntries(this.headers),
      }),
      body: Buffer.concat(this.chunks),
    };
  }
}

class Http2VerserNodeGuest implements VerserNodeGuest {
  private readonly options: VerserNodeGuestOptions;

  private readonly lifecycle = new EventEmitter();

  private session?: http2.ClientHttp2Session;

  private listener?: NodeRequestListener;

  private attachedDomain?: string;

  public constructor(options: VerserNodeGuestOptions) {
    this.options = options;
    createGuestId(options.guestId);
  }

  public get connected(): boolean {
    return this.session !== undefined && !this.session.closed && !this.session.destroyed;
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const certificate = createDevelopmentTlsCertificate();
    const session = http2.connect(this.options.hostUrl, { ca: certificate.cert });
    this.session = session;

    session.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
    session.on('close', () => {
      this.session = undefined;
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.disconnected });
    });

    await once(session, 'connect');
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected });
    await this.register();
  }

  public async close(reason = 'guest-close'): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }

    session.close();
    await once(session, 'close');
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.closed, reason });
  }

  public attach(
    serverOrListener: http.Server | NodeRequestListener,
    domain = this.options.guestId,
  ): this {
    if (serverOrListener instanceof http.Server) {
      const requestListeners = serverOrListener.listeners('request');
      const listener = requestListeners[0];
      if (listener === undefined) {
        throw createVerserError(
          'local-handler-failure',
          'Attached HTTP server has no request listener',
          {
            guestId: this.options.guestId,
          },
        );
      }
      this.listener = listener as unknown as NodeRequestListener;
      this.attachedDomain = domain;
      return this;
    }

    this.listener = serverOrListener;
    this.attachedDomain = domain;
    return this;
  }

  public dispatchRoutedRequest(
    request: VerserNodeGuestDispatchRequest,
  ): Promise<VerserNodeGuestDispatchResponse> {
    const listener = this.listener;
    if (listener === undefined) {
      return Promise.reject(
        createVerserError('local-handler-failure', 'No local HTTP handler is attached', {
          guestId: this.options.guestId,
          requestId: request.requestId,
        }),
      );
    }

    const envelope = createRoutedRequestEnvelope(request);
    const localRequest = new MinimalIncomingMessage(request);
    const localResponse = new MinimalServerResponse();

    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.requestStarted,
      requestId: envelope.requestId,
    });

    return new Promise((resolve, reject) => {
      localResponse.once('finish', () => {
        const response = localResponse.toDispatchResponse(envelope.requestId);
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.requestCompleted,
          requestId: envelope.requestId,
        });
        resolve(response);
      });

      try {
        listener(localRequest, localResponse);
      } catch (error) {
        const verserError = createVerserError('local-handler-failure', getErrorMessage(error), {
          guestId: this.options.guestId,
          requestId: envelope.requestId,
          path: envelope.path,
        });
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.error,
          requestId: envelope.requestId,
          error: verserError,
        });
        reject(verserError);
      }
    });
  }

  public onLifecycle(listener: (event: VerserNodeGuestLifecycleEvent) => void): () => void {
    this.lifecycle.on('event', listener);
    return () => this.lifecycle.off('event', listener);
  }

  private async register(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      throw createVerserError('disconnected-target', 'Guest is not connected', {
        guestId: this.options.guestId,
      });
    }

    const response = await requestJson(
      session,
      {
        peerId: this.options.guestId,
        role: 'guest',
        routedDomains: this.getRoutedDomains(),
      },
      this.options.guestId,
    );

    if (response.status !== 'registered') {
      throw createVerserError('invalid-registration', 'Host did not register Guest', {
        guestId: this.options.guestId,
      });
    }

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.registered });
  }

  private emitLifecycle(event: Omit<VerserNodeGuestLifecycleEvent, 'guestId'>): void {
    this.lifecycle.emit('event', { guestId: this.options.guestId, ...event });
  }

  private getRoutedDomains(): readonly string[] {
    if (this.attachedDomain !== undefined) {
      return [this.attachedDomain];
    }

    return this.options.routedDomains ?? [];
  }
}

function requestJson(
  session: http2.ClientHttp2Session,
  payload: Record<string, string | readonly string[]>,
  guestId: string,
): Promise<{ status?: string }> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.on('end', () => {
      try {
        resolve(JSON.parse(body) as { status?: string });
      } catch (error) {
        reject(
          createVerserError('protocol-error', 'Host returned invalid registration JSON', {
            guestId,
            cause: getErrorMessage(error),
          }),
        );
      }
    });
    stream.on('error', reject);
    stream.end(JSON.stringify(payload));
  });
}

function once(emitter: EventEmitter, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, () => resolve());
    emitter.once('error', reject);
  });
}

function toVerserError(error: Error): VerserError {
  return createVerserError('protocol-error', error.message, { guestId: 'unknown' });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

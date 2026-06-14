import { EventEmitter, once } from 'node:events';
import type * as http from 'node:http';
import * as http2 from 'node:http2';
import * as nodeStream from 'node:stream';
import { buffer } from 'node:stream/consumers';

import {
  createVerserError,
  normalizeClientTlsOptions,
  readNdjsonLines,
  resolveRouteForUrl,
  stripHttp2PseudoHeaders,
  validateVerserHeaders,
  verserErrorFromResponseBody,
} from '@signicode/verser-common';
import type { Dispatcher } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { VerserBrokerAgent } from './broker-agent';
import { VerserBrokerDispatcher } from './broker-dispatcher';
import type {
  BrokerControlFrame,
  BrokerRoute,
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
} from './types';

const DEFAULT_INTERNAL_REDIRECT_REPLAY_BUFFER_BYTES = 16 * 1024;
const DEFAULT_MAX_INTERNAL_REDIRECTS = 3;

interface ReplayableRequestBody {
  readonly body?: readonly Buffer[] | nodeStream.Readable;
  readonly getReplayBody: () => Promise<readonly Buffer[] | undefined>;
}

export class Http2VerserBroker implements VerserBroker {
  private readonly options: VerserBrokerOptions;

  private session?: http2.ClientHttp2Session;

  private controlStream?: http2.ClientHttp2Stream;

  private routes: { targetId: string; domain: string }[] = [];

  private routeWaiters = new Map<string, (() => void)[]>();

  private requestCounter = 0;

  private readonly frameEmitter = new EventEmitter();

  public constructor(options: VerserBrokerOptions) {
    this.options = options;
  }

  public get sessionCount(): number {
    return this.session === undefined ? 0 : 1;
  }

  public get routedRequestCount(): number {
    return this.requestCounter;
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined && !this.session.closed && !this.session.destroyed) {
      return;
    }
    const tls = normalizeClientTlsOptions(this.options.tls);
    const session = http2.connect(this.options.hostUrl, tls ?? {});
    this.session = session;
    session.once('close', () => {
      if (this.session === session) {
        this.session = undefined;
        this.controlStream = undefined;
      }
    });

    try {
      await once(session, 'connect');
      await this.register(session);
    } catch (error) {
      session.destroy();
      if (this.session === session) {
        this.session = undefined;
        this.controlStream = undefined;
      }
      throw error;
    }
  }

  public async close(_reason = 'broker-close'): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    this.controlStream?.close();
    session.close();
    await once(session, 'close');
    this.session = undefined;
  }

  public getRoutes(): { targetId: string; domain: string }[] {
    return [...this.routes];
  }

  public createAgent(): http.Agent {
    return new VerserBrokerAgent(this, this.options);
  }

  public createDispatcher(): Dispatcher {
    return new VerserBrokerDispatcher(this);
  }

  public createFetch(): typeof undiciFetch {
    const dispatcher = this.createDispatcher();
    return function verserFetch(input, init) {
      return undiciFetch(input, {
        ...init,
        dispatcher: init?.dispatcher ?? dispatcher,
        redirect: init?.redirect ?? 'manual',
      });
    } satisfies typeof undiciFetch;
  }

  public waitForRoute(domain: string): Promise<void> {
    if (this.routes.some((route) => route.domain === domain)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.routeWaiters.set(domain, [...(this.routeWaiters.get(domain) ?? []), resolve]);
    });
  }

  public request(request: VerserBrokerRequest): Promise<VerserBrokerResponse> {
    if (this.session === undefined) {
      return Promise.reject(createVerserError('disconnected-target', 'Broker is not connected'));
    }

    const maxInternalRedirects =
      this.options.maxInternalRedirects ?? DEFAULT_MAX_INTERNAL_REDIRECTS;
    const replayBufferLimit =
      this.options.internalRedirectReplayBufferBytes ??
      DEFAULT_INTERNAL_REDIRECT_REPLAY_BUFFER_BYTES;
    const replayableBody = this.createReplayableRequestBody(request.body, replayBufferLimit);
    return this.requestWithInternalRedirects(
      { ...request, body: replayableBody.body },
      replayableBody,
      maxInternalRedirects,
    );
  }

  private async requestWithInternalRedirects(
    request: VerserBrokerRequest,
    replayableBody: ReplayableRequestBody,
    maxInternalRedirects: number,
    hopCount = 0,
  ): Promise<VerserBrokerResponse> {
    const response = await this.requestOnce(request);
    const redirectTarget = this.resolveInternalRedirect(response, request.path);
    if (redirectTarget === undefined) {
      return response;
    }

    if (hopCount >= maxInternalRedirects) {
      response.body.destroy();
      throw createVerserError('protocol-error', 'Broker internal redirect limit exceeded', {
        maxInternalRedirects,
        redirectLocation: response.headers.location,
      });
    }

    const replayBody = await replayableBody.getReplayBody();
    if (replayBody === undefined) {
      return response;
    }

    response.body.destroy();
    return this.requestWithInternalRedirects(
      {
        targetId: redirectTarget.route.targetId,
        method: request.method,
        path: `${redirectTarget.url.pathname}${redirectTarget.url.search}`,
        headers: request.headers,
        body: replayBody,
      },
      replayableBody,
      maxInternalRedirects,
      hopCount + 1,
    );
  }

  private requestOnce(request: VerserBrokerRequest): Promise<VerserBrokerResponse> {
    const session = this.session;
    if (session === undefined) {
      return Promise.reject(createVerserError('disconnected-target', 'Broker is not connected'));
    }

    const requestId = `${this.options.brokerId}-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const requestHeaders: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': '/verser/request',
        'x-verser-request-id': requestId,
        'x-verser-source-id': this.options.brokerId,
        'x-verser-target-id': request.targetId,
        'x-verser-method': request.method,
        'x-verser-path': request.path,
        'x-verser-headers': JSON.stringify(validateVerserHeaders(request.headers ?? {})),
      };
      if (this.options.leaseAcquireTimeoutMs !== undefined) {
        requestHeaders['x-verser-lease-acquire-timeout-ms'] = String(
          this.options.leaseAcquireTimeoutMs,
        );
      }

      const stream = session.request(requestHeaders);
      let statusCode = 200;
      let responseHeaders: Record<string, string> = {};
      stream.on('response', (headers) => {
        statusCode = Number(headers[':status'] ?? 200);
        responseHeaders = stripHttp2PseudoHeaders(headers);
        if (statusCode < 400) {
          resolve({ requestId, statusCode, headers: responseHeaders, body: stream });
          return;
        }
        buffer(stream).then(
          (body) => reject(verserErrorFromResponseBody(body, request.targetId)),
          reject,
        );
      });
      stream.on('error', reject);
      stream.on('end', () => {
        if (statusCode >= 400) {
          return;
        }
      });
      const body = request.body;
      if (body === undefined) {
        stream.end();
        return;
      }

      if (body instanceof nodeStream.Readable) {
        body.once('error', (error) => {
          if (!stream.closed && !stream.destroyed) {
            stream.close(http2.constants.NGHTTP2_CANCEL);
          }
          reject(error);
        });
        body.pipe(stream);
        return;
      }

      for (const chunk of body) {
        stream.write(chunk);
      }
      stream.end();
    });
  }

  private createReplayableRequestBody(
    body: VerserBrokerRequest['body'],
    replayBufferLimit: number,
  ): ReplayableRequestBody {
    if (body === undefined) {
      return { body: undefined, getReplayBody: async () => [] };
    }

    if (!(body instanceof nodeStream.Readable)) {
      const replayChunks: Buffer[] = [];
      let totalBytes = 0;
      let replayable = true;
      for (const chunk of body) {
        totalBytes += chunk.length;
        if (totalBytes > replayBufferLimit) {
          replayable = false;
          replayChunks.length = 0;
          break;
        }
        replayChunks.push(Buffer.from(chunk));
      }
      return {
        body,
        getReplayBody: async () => (replayable ? replayChunks : undefined),
      };
    }

    const replayChunks: Buffer[] = [];
    const tee = new nodeStream.PassThrough();
    let totalBytes = 0;
    let replayable = true;
    let streamError: Error | undefined;
    let resolveReplayBody: (body: readonly Buffer[] | undefined) => void = () => {};
    let replayDecisionSettled = false;
    const replayDecision = new Promise<readonly Buffer[] | undefined>((resolve) => {
      resolveReplayBody = resolve;
    });
    const settleReplayDecision = (replayBody: readonly Buffer[] | undefined): void => {
      if (replayDecisionSettled) {
        return;
      }
      replayDecisionSettled = true;
      resolveReplayBody(replayBody);
    };
    body.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > replayBufferLimit) {
        replayable = false;
        replayChunks.length = 0;
      } else if (replayable) {
        replayChunks.push(Buffer.from(buffer));
      }
      if (!tee.write(buffer)) {
        body.pause();
        tee.once('drain', () => body.resume());
      }
    });
    body.once('end', () => {
      tee.end();
      settleReplayDecision(replayable ? replayChunks : undefined);
    });
    body.once('error', (error) => {
      streamError = error;
      tee.destroy(error);
      settleReplayDecision(undefined);
    });

    return {
      body: tee,
      getReplayBody: async () => {
        if (streamError !== undefined) {
          return undefined;
        }
        return replayDecision;
      },
    };
  }

  private resolveInternalRedirect(
    response: VerserBrokerResponse,
    requestPath: string,
  ): { readonly route: BrokerRoute; readonly url: URL } | undefined {
    if (response.statusCode !== 307 && response.statusCode !== 308) {
      return undefined;
    }

    const location = response.headers.location;
    if (location === undefined) {
      return undefined;
    }

    let url: URL;
    try {
      url = new URL(location, `http://verser.invalid${requestPath}`);
    } catch {
      return undefined;
    }
    if (url.hostname === 'verser.invalid') {
      return undefined;
    }

    const route = resolveRouteForUrl(this.routes, url);
    if (route === undefined) {
      return undefined;
    }
    return { route, url };
  }

  private async register(session: http2.ClientHttp2Session): Promise<void> {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    this.controlStream = stream;
    readNdjsonLines<BrokerControlFrame>(stream, (frame: BrokerControlFrame) =>
      this.handleControlFrame(frame),
    );
    stream.end(JSON.stringify({ peerId: this.options.brokerId, role: 'broker' }));
    await this.waitForRegistration(session, stream);
  }

  private waitForRegistration(
    session: http2.ClientHttp2Session,
    stream: http2.ClientHttp2Stream,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let unregister = (): void => {};
      const cleanup = (): void => {
        unregister();
        stream.off('error', rejectWithCleanup);
        stream.off('close', rejectOnClose);
        session.off('error', rejectWithCleanup);
        session.off('close', rejectOnClose);
      };
      const rejectWithCleanup = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const rejectOnClose = (): void => {
        cleanup();
        reject(createVerserError('invalid-registration', 'Broker registration stream closed'));
      };
      unregister = this.waitForFrame(() => {
        cleanup();
        resolve();
      });
      stream.once('error', rejectWithCleanup);
      stream.once('close', rejectOnClose);
      session.once('error', rejectWithCleanup);
      session.once('close', rejectOnClose);
    });
  }

  private waitForFrame(listener: () => void): () => void {
    this.frameEmitter.on('frame', listener);
    return () => this.frameEmitter.off('frame', listener);
  }

  private handleControlFrame(
    frame: BrokerControlFrame | { readonly routes?: BrokerControlFrame['routes'] },
  ): void {
    const routes = Array.isArray(frame.routes) ? frame.routes : undefined;
    if (routes !== undefined) {
      this.routes = [...routes];
      for (const route of this.routes) {
        for (const resolve of this.routeWaiters.get(route.domain) ?? []) {
          resolve();
        }
        this.routeWaiters.delete(route.domain);
      }
    }
    this.frameEmitter.emit('frame');
  }
}

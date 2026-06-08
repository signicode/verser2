import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import * as http2 from 'node:http2';
import * as nodeStream from 'node:stream';

import {
  createDevelopmentTlsCertificate,
  createVerserError,
  readNdjsonLines,
  validateVerserHeaders,
} from '@signicode/verser-common';
import type { Dispatcher } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { VerserBrokerAgent } from './broker-agent';
import { VerserBrokerDispatcher } from './broker-dispatcher';
import { errorFromBody } from './error-utils';
import { normalHeaders } from './header-utils';
import { once, readResponseBody } from './http2-client-utils';
import type {
  BrokerControlFrame,
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
} from './types';

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
    if (this.session !== undefined && !this.session.closed) {
      return;
    }
    const certificate = createDevelopmentTlsCertificate();
    const session = http2.connect(this.options.hostUrl, { ca: certificate.cert });
    this.session = session;
    await once(session, 'connect');
    await this.register(session);
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
    return new VerserBrokerAgent(this);
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
        responseHeaders = normalHeaders(headers);
        if (statusCode < 400) {
          resolve({ requestId, statusCode, headers: responseHeaders, body: stream });
          return;
        }
        readResponseBody(stream).then(
          (body) => reject(errorFromBody(body, request.targetId)),
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
        body.once('error', reject);
        body.pipe(stream);
        return;
      }

      for (const chunk of body) {
        stream.write(chunk);
      }
      stream.end();
    });
  }

  private async register(session: http2.ClientHttp2Session): Promise<void> {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    this.controlStream = stream;
    readNdjsonLines<BrokerControlFrame>(stream, (frame: BrokerControlFrame) =>
      this.handleControlFrame(frame),
    );
    stream.end(JSON.stringify({ peerId: this.options.brokerId, role: 'broker' }));
    await this.waitForRegistration();
  }

  private waitForRegistration(): Promise<void> {
    return new Promise((resolve) => {
      const unregister = this.waitForFrame(() => {
        unregister();
        resolve();
      });
    });
  }

  private waitForFrame(listener: () => void): () => void {
    this.frameEmitter.on('frame', listener);
    return () => this.frameEmitter.off('frame', listener);
  }

  private handleControlFrame(frame: BrokerControlFrame): void {
    if ('routes' in frame) {
      this.routes = frame.routes;
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

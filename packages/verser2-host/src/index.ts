import { EventEmitter } from 'node:events';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import {
  type RoutedDomainRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserError,
  type VerserPeerId,
  createDevelopmentTlsCertificate,
  createPeerId,
  createRoutedDomainRegistration,
  createVerserError,
} from '@signicode/verser-common';

export const VERSER2_HOST_PACKAGE_NAME = '@signicode/verser2-host';

export type VerserPeerRole = 'broker' | 'guest';

export interface VerserHostOptions {
  readonly port?: number;
  readonly host?: string;
}

export interface VerserHostRegistrationRequest {
  readonly peerId: string;
  readonly role: VerserPeerRole;
  readonly routedDomains?: readonly string[];
}

export interface VerserHostLifecycleEvent {
  readonly name: string;
  readonly peerId?: string;
  readonly role?: VerserPeerRole;
  readonly reason?: string;
  readonly error?: VerserError;
}

export interface VerserHost {
  readonly running: boolean;
  readonly address: AddressInfo;
  start(): Promise<void>;
  close(reason?: string): Promise<void>;
  getRoutedDomains(): RoutedDomainRegistration[];
  onLifecycle(listener: (event: VerserHostLifecycleEvent) => void): () => void;
}

interface RegisteredPeer {
  readonly peerId: VerserPeerId;
  readonly role: VerserPeerRole;
  readonly session: http2.Http2Session;
  readonly controlStream?: http2.ServerHttp2Stream;
}

interface RegistrationResponse {
  readonly status: 'registered';
  readonly routes: RoutedDomainRegistration[];
}

interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly context: Record<string, string | number | boolean>;
  };
}

interface GuestControlFrame {
  readonly type: string;
  readonly requestId: string;
  readonly statusCode?: number;
  readonly headers?: Record<string, string>;
  readonly bodyBase64?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

interface PendingRoutedRequest {
  readonly stream: http2.ServerHttp2Stream;
  readonly targetId: string;
  readonly bodyChunks: Buffer[];
  responseHeaders?: Record<string, string>;
  statusCode?: number;
}

export function createVerserHost(options: VerserHostOptions = {}): VerserHost {
  return new NodeHttp2VerserHost(options);
}

class NodeHttp2VerserHost implements VerserHost {
  private readonly options: VerserHostOptions;

  private readonly lifecycle = new EventEmitter();

  private readonly peers = new Map<VerserPeerId, RegisteredPeer>();

  private readonly sessions = new Set<http2.ServerHttp2Session>();

  private readonly pendingRequests = new Map<string, PendingRoutedRequest>();

  private server?: http2.Http2SecureServer;

  public constructor(options: VerserHostOptions) {
    this.options = options;
  }

  public get running(): boolean {
    return this.server !== undefined;
  }

  public get address(): AddressInfo {
    const server = this.server;
    if (server === undefined) {
      throw createVerserError('protocol-error', 'Verser Host is not listening');
    }

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw createVerserError('protocol-error', 'Verser Host is not listening');
    }

    return address;
  }

  public async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    const certificate = createDevelopmentTlsCertificate();
    const server = http2.createSecureServer({
      cert: certificate.cert,
      key: certificate.key,
    });

    server.on('session', (session) => this.trackSession(session));
    server.on('stream', (stream, headers) => {
      this.handleStream(stream, headers).catch((error: unknown) => {
        const verserError = toVerserError(error);
        this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: verserError });
        sendError(stream, verserError);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.server = server;
  }

  public async close(reason = 'host-close'): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }

    this.server = undefined;

    for (const peer of this.peers.values()) {
      peer.controlStream?.close(http2.constants.NGHTTP2_NO_ERROR);
    }

    for (const session of this.sessions) {
      session.close();
    }
    this.sessions.clear();
    this.peers.clear();
    this.guestRegistrations.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.closed, reason });
  }

  public getRoutedDomains(): RoutedDomainRegistration[] {
    return [...this.guestRegistrations.values()].flat();
  }

  public onLifecycle(listener: (event: VerserHostLifecycleEvent) => void): () => void {
    this.lifecycle.on('event', listener);
    return () => this.lifecycle.off('event', listener);
  }

  private trackSession(session: http2.ServerHttp2Session): void {
    this.sessions.add(session);
    this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.connected });

    session.on('close', () => {
      this.sessions.delete(session);
      this.removeSessionPeers(session);
    });
    session.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
    });
  }

  private async handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const path = String(headers[':path'] ?? '');
    if (path === '/verser/guest/control') {
      this.attachGuestControlStream(stream, headers);
      return;
    }

    if (path === '/verser/request') {
      await this.routeBrokerRequest(stream, headers);
      return;
    }

    if (path !== '/verser/register') {
      throw createVerserError('protocol-error', 'Unsupported Host stream path', {
        path,
      });
    }

    const registration = parseRegistrationRequest(await readRequestBody(stream));
    this.registerPeer(stream, registration);
  }

  private registerPeer(
    stream: http2.ServerHttp2Stream,
    registration: VerserHostRegistrationRequest,
  ): void {
    const peerId = createPeerId(registration.peerId);
    if (this.peers.has(peerId)) {
      throw createVerserError('invalid-registration', 'Peer is already registered', { peerId });
    }

    const session = stream.session;
    if (session === undefined) {
      throw createVerserError(
        'protocol-error',
        'Registration stream does not have an HTTP/2 session',
      );
    }

    const peer: RegisteredPeer = {
      peerId,
      role: registration.role,
      session,
      controlStream: registration.role === 'broker' ? stream : undefined,
    };

    this.peers.set(peerId, peer);
    this.emitLifecycle({
      name: VERSER_LIFECYCLE_EVENTS.registered,
      peerId,
      role: registration.role,
    });

    if (registration.role === 'guest') {
      this.guestRegistrations.set(
        peerId,
        (registration.routedDomains ?? []).map((domain) =>
          createRoutedDomainRegistration({ targetId: peerId, domain }),
        ),
      );
    }

    const response: RegistrationResponse = {
      status: 'registered',
      routes: this.getRoutedDomains(),
    };
    if (registration.role === 'broker') {
      writeJsonLine(stream, response);
      return;
    }

    sendJson(stream, response);
    this.advertiseRoutes();
  }

  private advertiseRoutes(): void {
    const routes = this.getRoutedDomains();
    for (const peer of this.peers.values()) {
      if (
        peer.role === 'broker' &&
        peer.controlStream !== undefined &&
        !peer.controlStream.closed
      ) {
        writeJsonLine(peer.controlStream, { type: 'routes', routes });
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.routeAdvertised,
          peerId: peer.peerId,
          role: peer.role,
        });
      }
    }
  }

  private attachGuestControlStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const peerId = String(headers['x-verser-peer-id'] ?? '');
    const peer = this.peers.get(peerId);
    if (peer === undefined || peer.role !== 'guest') {
      throw createVerserError(
        'disconnected-target',
        'Guest control stream has no registered peer',
        {
          targetId: peerId,
        },
      );
    }

    this.peers.set(peerId, { ...peer, controlStream: stream });
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    readJsonLines(stream, (frame) => this.handleGuestControlFrame(frame));
  }

  private async routeBrokerRequest(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): Promise<void> {
    const targetId = String(headers['x-verser-target-id'] ?? '');
    const requestId = String(headers['x-verser-request-id'] ?? `req-${Date.now()}`);
    const target = this.peers.get(targetId);

    if (target === undefined) {
      throw createVerserError('missing-guest', 'Target Guest is not registered', { targetId });
    }
    if (target.controlStream === undefined || target.controlStream.closed) {
      throw createVerserError('disconnected-target', 'Target Guest has no active control stream', {
        targetId,
      });
    }

    const body = await readRequestBuffer(stream);
    this.pendingRequests.set(requestId, { stream, targetId, bodyChunks: [] });
    writeJsonLine(target.controlStream, {
      type: 'request',
      requestId,
      sourceId: String(headers['x-verser-source-id'] ?? ''),
      targetId,
      method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
      path: String(headers['x-verser-path'] ?? '/'),
      headers: decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}')),
      bodyBase64: body.toString('base64'),
    });
  }

  private handleGuestControlFrame(frame: GuestControlFrame): void {
    const pending = this.pendingRequests.get(frame.requestId);
    if (pending === undefined) {
      return;
    }

    if (frame.type === 'response-start') {
      pending.statusCode = frame.statusCode ?? 200;
      pending.responseHeaders = frame.headers ?? {};
      return;
    }

    if (frame.type === 'response-body' && frame.bodyBase64 !== undefined) {
      pending.bodyChunks.push(Buffer.from(frame.bodyBase64, 'base64'));
      return;
    }

    if (frame.type === 'handler-error') {
      this.pendingRequests.delete(frame.requestId);
      sendError(
        pending.stream,
        createVerserError('local-handler-failure', frame.error?.message ?? 'Guest handler failed', {
          targetId: pending.targetId,
          requestId: frame.requestId,
        }),
      );
      return;
    }

    if (frame.type === 'response-end') {
      this.pendingRequests.delete(frame.requestId);
      pending.stream.respond({
        ':status': pending.statusCode ?? 200,
        ...(pending.responseHeaders ?? {}),
      });
      pending.stream.end(Buffer.concat(pending.bodyChunks));
    }
  }

  private removeSessionPeers(session: http2.ServerHttp2Session): void {
    let shouldAdvertiseRoutes = false;
    for (const [peerId, peer] of this.peers) {
      if (peer.session === session) {
        this.peers.delete(peerId);
        this.guestRegistrations.delete(peerId);
        shouldAdvertiseRoutes = shouldAdvertiseRoutes || peer.role === 'guest';
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.disconnected,
          peerId,
          role: peer.role,
        });
      }
    }

    if (shouldAdvertiseRoutes) {
      this.advertiseRoutes();
    }
  }

  private emitLifecycle(event: VerserHostLifecycleEvent): void {
    this.lifecycle.emit('event', event);
  }

  private readonly guestRegistrations = new Map<VerserPeerId, RoutedDomainRegistration[]>();
}

function parseRegistrationRequest(body: string): VerserHostRegistrationRequest {
  const parsed = JSON.parse(body) as Partial<VerserHostRegistrationRequest>;
  if (parsed.role !== 'broker' && parsed.role !== 'guest') {
    throw createVerserError('invalid-registration', 'Registration role must be broker or guest', {
      role: String(parsed.role ?? ''),
    });
  }

  return {
    peerId: String(parsed.peerId ?? ''),
    role: parsed.role,
    routedDomains: parsed.routedDomains ?? [],
  };
}

function readRequestBody(stream: http2.ServerHttp2Stream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.on('end', () => resolve(body));
    stream.on('error', reject);
  });
}

function writeJsonLine(stream: http2.ServerHttp2Stream, value: unknown): void {
  if (!stream.headersSent) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
  }
  stream.write(`${JSON.stringify(value)}\n`);
}

function sendJson(stream: http2.ServerHttp2Stream, value: unknown): void {
  if (!stream.headersSent) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
  }
  stream.end(JSON.stringify(value));
}

function sendError(stream: http2.ServerHttp2Stream, error: VerserError): void {
  if (!stream.headersSent) {
    stream.respond({ ':status': 502, 'content-type': 'application/json' });
  }
  stream.end(JSON.stringify(toErrorResponse(error)));
}

function toErrorResponse(error: VerserError): ErrorResponse {
  const context = Object.fromEntries(
    Object.entries(error.context).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
  return { error: { code: error.code, message: error.message, context } };
}

function toVerserError(error: unknown): VerserError {
  if (error instanceof Error && 'code' in error && error.name === 'VerserError') {
    return error as VerserError;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createVerserError('protocol-error', message);
}

function readRequestBuffer(stream: http2.ServerHttp2Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function readJsonLines(
  stream: http2.ServerHttp2Stream,
  onFrame: (frame: GuestControlFrame) => void,
): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let lineBreak = pending.indexOf('\n');
    while (lineBreak !== -1) {
      const line = pending.slice(0, lineBreak);
      pending = pending.slice(lineBreak + 1);
      if (line.length > 0) {
        onFrame(JSON.parse(line) as GuestControlFrame);
      }
      lineBreak = pending.indexOf('\n');
    }
  });
}

function decodeHeaderMap(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

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
  };
}

export function createVerserHost(options: VerserHostOptions = {}): VerserHost {
  return new NodeHttp2VerserHost(options);
}

class NodeHttp2VerserHost implements VerserHost {
  private readonly options: VerserHostOptions;

  private readonly lifecycle = new EventEmitter();

  private readonly peers = new Map<VerserPeerId, RegisteredPeer>();

  private readonly sessions = new Set<http2.ServerHttp2Session>();

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
        sendJson(stream, toErrorResponse(verserError));
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
    if (headers[':path'] !== '/verser/register') {
      throw createVerserError('protocol-error', 'Unsupported Host stream path', {
        path: String(headers[':path'] ?? ''),
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

  private removeSessionPeers(session: http2.ServerHttp2Session): void {
    for (const [peerId, peer] of this.peers) {
      if (peer.session === session) {
        this.peers.delete(peerId);
        this.guestRegistrations.delete(peerId);
        this.emitLifecycle({
          name: VERSER_LIFECYCLE_EVENTS.disconnected,
          peerId,
          role: peer.role,
        });
      }
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

function toErrorResponse(error: VerserError): ErrorResponse {
  return { error: { code: error.code, message: error.message } };
}

function toVerserError(error: unknown): VerserError {
  if (error instanceof Error && 'code' in error && error.name === 'VerserError') {
    return error as VerserError;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createVerserError('protocol-error', message);
}

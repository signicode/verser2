import { EventEmitter } from 'node:events';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { text as readStreamText } from 'node:stream/consumers';

import {
  type RoutedDomainRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserError,
  type VerserPeerId,
  createDevelopmentTlsCertificate,
  createPeerId,
  createRoutedDomainRegistration,
  createVerserError,
  encodeVerserEnvelope,
  readLeaseResponseMetadataFromStream,
  readNdjsonLines,
  validateVerserHeaders,
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

interface GuestLeaseStream {
  readonly guestId: VerserPeerId;
  readonly leaseId: string;
  readonly stream: http2.ServerHttp2Stream;
  active: boolean;
}

interface QueuedLeaseAcquisition {
  readonly guestId: VerserPeerId;
  readonly requestId: string;
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (lease: GuestLeaseStream) => void;
  readonly reject: (error: VerserError) => void;
}

export function createVerserHost(options: VerserHostOptions = {}): VerserHost {
  return new NodeHttp2VerserHost(options);
}

class NodeHttp2VerserHost implements VerserHost {
  private readonly options: VerserHostOptions;

  private readonly lifecycle = new EventEmitter();

  private readonly peers = new Map<VerserPeerId, RegisteredPeer>();

  private readonly sessions = new Set<http2.ServerHttp2Session>();

  private readonly idleLeases = new Map<VerserPeerId, GuestLeaseStream[]>();

  private readonly activeLeases = new Map<string, GuestLeaseStream>();

  private readonly queuedLeaseAcquisitions = new Map<VerserPeerId, QueuedLeaseAcquisition[]>();

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

    this.closeAllLeases();
    this.failAllQueuedLeaseAcquisitions(reason);

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

    if (path === '/verser/guest/lease') {
      this.attachGuestLeaseStream(stream, headers);
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
    readNdjsonLines<unknown>(stream, () => {
      // Guest control stream body routing was removed; keep the stream open for coordination.
    });
  }

  private attachGuestLeaseStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): void {
    const guestId = createPeerId(String(headers['x-verser-peer-id'] ?? ''));
    const leaseId = String(headers['x-verser-lease-id'] ?? '').trim();
    const peer = this.peers.get(guestId);
    if (peer === undefined || peer.role !== 'guest') {
      throw createVerserError('disconnected-target', 'Guest lease stream has no registered peer', {
        targetId: guestId,
      });
    }
    if (leaseId.length === 0) {
      throw createVerserError('protocol-error', 'Guest lease stream requires a lease id', {
        targetId: guestId,
      });
    }

    const lease: GuestLeaseStream = { guestId, leaseId, stream, active: false };
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
    stream.on('close', () => this.removeLease(lease));
    stream.on('error', (error) => {
      this.emitLifecycle({ name: VERSER_LIFECYCLE_EVENTS.error, error: toVerserError(error) });
      this.removeLease(lease);
    });

    this.addIdleLease(lease);
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
    const lease = await this.tryAcquireLease(
      createPeerId(targetId),
      requestId,
      parseLeaseAcquireTimeoutMs(headers),
    );
    if (lease !== undefined) {
      await this.routeBrokerRequestOverLease(stream, headers, lease, requestId, targetId);
      return;
    }

    const queuedLease = await this.acquireLease(
      createPeerId(targetId),
      requestId,
      parseLeaseAcquireTimeoutMs(headers),
    );
    await this.routeBrokerRequestOverLease(stream, headers, queuedLease, requestId, targetId);
  }

  private async routeBrokerRequestOverLease(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    lease: GuestLeaseStream,
    requestId: string,
    targetId: string,
  ): Promise<void> {
    let completed = false;
    const cancelLease = (): void => {
      if (!completed && !lease.stream.closed) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    };
    stream.once('aborted', cancelLease);
    stream.once('error', cancelLease);
    stream.once('close', cancelLease);

    const responsePromise = readLeaseResponseMetadataFromStream(lease.stream, {
      requestId,
      targetId,
    });
    lease.stream.write(
      encodeVerserEnvelope({
        type: 'request',
        metadata: {
          requestId,
          sourceId: String(headers['x-verser-source-id'] ?? ''),
          targetId,
          method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
          path: String(headers['x-verser-path'] ?? '/'),
          headers: flattenValidatedHeaders(
            validateVerserHeaders(decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}'))),
          ),
          timeoutMs: parseLeaseAcquireTimeoutMs(headers),
        },
      }),
    );
    stream.pipe(lease.stream);

    const responseMetadata = await responsePromise;
    stream.respond({
      ':status': responseMetadata.statusCode,
      ...validateVerserHeaders(responseMetadata.headers),
    });
    lease.stream.once('error', () => {
      if (!stream.closed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    lease.stream.pipe(stream);
    stream.once('finish', () => {
      completed = true;
    });
  }

  private removeSessionPeers(session: http2.ServerHttp2Session): void {
    let shouldAdvertiseRoutes = false;
    for (const [peerId, peer] of this.peers) {
      if (peer.session === session) {
        this.peers.delete(peerId);
        this.guestRegistrations.delete(peerId);
        this.closeGuestLeases(peerId);
        this.failQueuedLeaseAcquisitions(peerId, 'guest-disconnect');
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

  private addIdleLease(lease: GuestLeaseStream): void {
    const queued = this.queuedLeaseAcquisitions.get(lease.guestId)?.shift();
    if (queued !== undefined) {
      clearTimeout(queued.timeout);
      lease.active = true;
      this.activeLeases.set(lease.leaseId, lease);
      queued.resolve(lease);
      return;
    }

    const idleLeases = this.idleLeases.get(lease.guestId) ?? [];
    idleLeases.push(lease);
    this.idleLeases.set(lease.guestId, idleLeases);
  }

  private acquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream> {
    const idleLeases = this.idleLeases.get(guestId) ?? [];
    const lease = idleLeases.shift();
    if (lease !== undefined) {
      lease.active = true;
      this.activeLeases.set(lease.leaseId, lease);
      return Promise.resolve(lease);
    }

    return new Promise((resolve, reject) => {
      const acquisition: QueuedLeaseAcquisition = {
        guestId,
        requestId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeQueuedLeaseAcquisition(acquisition);
          reject(
            createVerserError('timeout', 'Timed out waiting for a Guest lease stream', {
              targetId: guestId,
              requestId,
              timeoutMs,
            }),
          );
        }, timeoutMs),
      };
      const queued = this.queuedLeaseAcquisitions.get(guestId) ?? [];
      queued.push(acquisition);
      this.queuedLeaseAcquisitions.set(guestId, queued);
    });
  }

  private async tryAcquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream | undefined> {
    const idleLeases = this.idleLeases.get(guestId) ?? [];
    if (idleLeases.length === 0) {
      return undefined;
    }

    return this.acquireLease(guestId, requestId, timeoutMs);
  }

  private removeLease(lease: GuestLeaseStream): void {
    const idleLeases = this.idleLeases.get(lease.guestId) ?? [];
    this.idleLeases.set(
      lease.guestId,
      idleLeases.filter((candidate) => candidate !== lease),
    );
    this.activeLeases.delete(lease.leaseId);
  }

  private closeGuestLeases(guestId: VerserPeerId): void {
    for (const lease of this.idleLeases.get(guestId) ?? []) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    this.idleLeases.delete(guestId);

    for (const lease of this.activeLeases.values()) {
      if (lease.guestId === guestId) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
        this.activeLeases.delete(lease.leaseId);
      }
    }
  }

  private closeAllLeases(): void {
    for (const leases of this.idleLeases.values()) {
      for (const lease of leases) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    }
    for (const lease of this.activeLeases.values()) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    this.idleLeases.clear();
    this.activeLeases.clear();
  }

  private failQueuedLeaseAcquisitions(guestId: VerserPeerId, reason: string): void {
    const queued = this.queuedLeaseAcquisitions.get(guestId) ?? [];
    this.queuedLeaseAcquisitions.delete(guestId);
    for (const acquisition of queued) {
      clearTimeout(acquisition.timeout);
      acquisition.reject(
        createVerserError('disconnected-target', 'Guest disconnected while waiting for a lease', {
          targetId: guestId,
          requestId: acquisition.requestId,
          reason,
        }),
      );
    }
  }

  private failAllQueuedLeaseAcquisitions(reason: string): void {
    for (const guestId of this.queuedLeaseAcquisitions.keys()) {
      this.failQueuedLeaseAcquisitions(guestId, reason);
    }
  }

  private removeQueuedLeaseAcquisition(acquisition: QueuedLeaseAcquisition): void {
    const queued = this.queuedLeaseAcquisitions.get(acquisition.guestId) ?? [];
    this.queuedLeaseAcquisitions.set(
      acquisition.guestId,
      queued.filter((candidate) => candidate !== acquisition),
    );
  }
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
  return readStreamText(stream);
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
  if (stream.closed || stream.destroyed) {
    return;
  }
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

function decodeHeaderMap(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

function flattenValidatedHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === 'string' ? value : value.join(','),
    ]),
  );
}

function parseLeaseAcquireTimeoutMs(headers: http2.IncomingHttpHeaders): number {
  const value = Number(headers['x-verser-lease-acquire-timeout-ms'] ?? 5000);
  if (!Number.isFinite(value) || value < 0) {
    return 5000;
  }

  return value;
}

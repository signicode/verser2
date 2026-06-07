import { EventEmitter } from 'node:events';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import {
  type RoutedDomainRegistration,
  VERSER_LIFECYCLE_EVENTS,
  type VerserError,
  type VerserErrorEnvelopeMetadata,
  type VerserPeerId,
  type VerserResponseEnvelopeMetadata,
  createDevelopmentTlsCertificate,
  createPeerId,
  createRoutedDomainRegistration,
  createVerserEnvelopeParser,
  createVerserError,
  encodeVerserEnvelope,
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

  private readonly pendingRequests = new Map<string, PendingRoutedRequest>();

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
    readJsonLines(stream, (frame) => this.handleGuestControlFrame(frame));
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

    if (target.controlStream === undefined || target.controlStream.closed) {
      const queuedLease = await this.acquireLease(
        createPeerId(targetId),
        requestId,
        parseLeaseAcquireTimeoutMs(headers),
      );
      await this.routeBrokerRequestOverLease(stream, headers, queuedLease, requestId, targetId);
      return;
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

  private async routeBrokerRequestOverLease(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    lease: GuestLeaseStream,
    requestId: string,
    targetId: string,
  ): Promise<void> {
    const responsePromise = readLeaseResponseMetadata(
      lease.stream,
      requestId,
      targetId,
      DEFAULT_LEASE_METADATA_BYTES,
    );
    const body = await readRequestBuffer(stream);
    lease.stream.write(
      encodeVerserEnvelope({
        type: 'request',
        metadata: {
          requestId,
          sourceId: String(headers['x-verser-source-id'] ?? ''),
          targetId,
          method: String(headers['x-verser-method'] ?? headers[':method'] ?? 'GET'),
          path: String(headers['x-verser-path'] ?? '/'),
          headers: decodeHeaderMap(String(headers['x-verser-headers'] ?? '{}')),
          timeoutMs: parseLeaseAcquireTimeoutMs(headers),
        },
      }),
    );
    lease.stream.end(body);

    const responseMetadata = await responsePromise;
    stream.respond({ ':status': responseMetadata.statusCode, ...responseMetadata.headers });
    lease.stream.pipe(stream);
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

function parseLeaseAcquireTimeoutMs(headers: http2.IncomingHttpHeaders): number {
  const value = Number(headers['x-verser-lease-acquire-timeout-ms'] ?? 5000);
  if (!Number.isFinite(value) || value < 0) {
    return 5000;
  }

  return value;
}

const DEFAULT_LEASE_METADATA_BYTES = 64 * 1024;

function readLeaseResponseMetadata(
  stream: http2.ServerHttp2Stream,
  requestId: string,
  targetId: string,
  maxMetadataBytes: number,
): Promise<VerserResponseEnvelopeMetadata> {
  return readLeaseResponseMetadataFromStream(stream, requestId, targetId, maxMetadataBytes);
}

async function readLeaseResponseMetadataFromStream(
  stream: http2.ServerHttp2Stream,
  requestId: string,
  targetId: string,
  maxMetadataBytes: number,
): Promise<VerserResponseEnvelopeMetadata> {
  const parser = createVerserEnvelopeParser({ maxMetadataBytes });
  const prefix = await readExactly(stream, 2, requestId, targetId);
  const lengthBytes = await readExactly(stream, 4, requestId, targetId);
  const metadataLength = lengthBytes.readUInt32BE(0);
  const metadataBytes = await readExactly(stream, metadataLength, requestId, targetId);
  const parsed = parser.push(Buffer.concat([prefix, lengthBytes, metadataBytes]));

  if (parsed === undefined) {
    throw createVerserError('protocol-error', 'Lease stream metadata parser did not complete', {
      targetId,
      requestId,
    });
  }

  if (parsed.bodyRemainder.length > 0) {
    stream.unshift(parsed.bodyRemainder);
  }

  if (parsed.type === 'response') {
    return parsed.metadata as VerserResponseEnvelopeMetadata;
  }

  if (parsed.type === 'error') {
    const errorMetadata = parsed.metadata as VerserErrorEnvelopeMetadata;
    throw createVerserError(
      errorMetadata.code === 'local-handler-failure' ? 'local-handler-failure' : 'protocol-error',
      errorMetadata.message,
      {
        targetId,
        requestId,
        ...(errorMetadata.context ?? {}),
      },
    );
  }

  throw createVerserError('protocol-error', 'Lease stream returned a non-response envelope', {
    targetId,
    requestId,
  });
}

async function readExactly(
  stream: http2.ServerHttp2Stream,
  byteCount: number,
  requestId: string,
  targetId: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remainingBytes = byteCount;

  while (remainingBytes > 0) {
    const chunk = stream.read(remainingBytes) as Buffer | string | null;
    if (chunk === null) {
      await waitForReadable(stream, requestId, targetId);
      continue;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length > remainingBytes) {
      chunks.push(buffer.subarray(0, remainingBytes));
      stream.unshift(buffer.subarray(remainingBytes));
      remainingBytes = 0;
      continue;
    }

    chunks.push(buffer);
    remainingBytes -= buffer.length;
  }

  return Buffer.concat(chunks, byteCount);
}

function waitForReadable(
  stream: http2.ServerHttp2Stream,
  requestId: string,
  targetId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReadable = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(
        createVerserError('protocol-error', 'Lease stream ended before response metadata', {
          targetId,
          requestId,
        }),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(toVerserError(error));
    };
    const cleanup = (): void => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };

    stream.once('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

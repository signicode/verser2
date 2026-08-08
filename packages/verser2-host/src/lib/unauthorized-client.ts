/**
 * Host-internal unauthorized-client gate.
 *
 * Serves TLS HTTP/2 sessions that did not present a valid client certificate
 * by producing one bounded response from the configured unauthorized-client
 * handler before closing the session. Owns all unauthorized session/stream
 * state: request and response body bounds, request and handler timeouts,
 * response writing, stream refusals, and hard-close cleanup.
 *
 * The Host wires this gate into the server's `session`, `stream`, and session
 * close/error events; the gate classifies sessions, records unauthorized
 * sessions, and consumes their streams. Unauthorized sessions are never
 * registered peers: they produce no lifecycle events.
 *
 * @internal
 * This module is private to the Host implementation. It must not import
 * {@link NodeHttp2VerserHost} (no circular dependencies).
 */

import * as http2 from 'node:http2';
import type { TLSSocket } from 'node:tls';

import {
  type VerserUnauthorizedClientHandler,
  type VerserUnauthorizedClientHandlerResult,
  sanitizeHttp2ResponseHeaders,
  validateVerserHeaders,
} from '@signicode/verser-common';

/** Bounded limits and handler for one unauthorized-client session. */
export interface UnauthorizedClientGateOptions {
  readonly handler: VerserUnauthorizedClientHandler;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly handlerTimeoutMs: number;
}

/** Per-session state for an unauthorized client. */
interface UnauthorizedClientSession {
  claimed: boolean;
  closing: boolean;
  readonly controller: AbortController;
  hardCloseTimer?: NodeJS.Timeout;
}

/** Internal failure used to map unauthorized-client faults to HTTP statuses. */
class UnauthorizedClientFailure extends Error {
  public constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const UNAUTHORIZED_CLIENT_HARD_CLOSE_TIMEOUT_MS = 250;

/**
 * Returns true when the session presented a valid, raw peer certificate.
 *
 * Classification is based on TLS socket authorization plus the presence of a
 * raw peer certificate; a session is only served by the unauthorized-client
 * gate when this returns false.
 */
export function isAuthorizedClientSession(session: http2.ServerHttp2Session): boolean {
  const tlsSocket = session.socket as TLSSocket;
  const certificate = tlsSocket.getPeerCertificate(true);
  return tlsSocket.authorized && Buffer.isBuffer(certificate.raw) && certificate.raw.length > 0;
}

/**
 * Gates unauthorized TLS HTTP/2 sessions on behalf of the Host.
 *
 * Records unauthorized sessions, handles their streams, and cleans up session
 * state on close. The Host keeps the gate as a field and delegates the
 * `session`/`stream` events plus session close/error handling to it.
 *
 * @internal
 */
export class UnauthorizedClientGate {
  private readonly sessions = new Map<http2.ServerHttp2Session, UnauthorizedClientSession>();

  public constructor(private readonly gate: UnauthorizedClientGateOptions) {}

  /**
   * Records a session that failed {@link isAuthorizedClientSession} so the
   * gate can serve and close it. Callers must only invoke this for sessions
   * the gate classifies as unauthorized.
   */
  public trackSession(session: http2.ServerHttp2Session): void {
    this.sessions.set(session, {
      claimed: false,
      closing: false,
      controller: new AbortController(),
    });
  }

  /** Returns true when the session is tracked as an unauthorized session. */
  public hasSession(session: http2.ServerHttp2Session): boolean {
    return this.sessions.has(session);
  }

  /**
   * Handles a stream opened on an unauthorized session. Returns true when the
   * stream was consumed by the gate; the Host must skip normal protocol
   * handling for it.
   */
  public handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ): boolean {
    const session = stream.session as http2.ServerHttp2Session | undefined;
    if (session === undefined) {
      return false;
    }
    const state = this.sessions.get(session);
    if (state === undefined) {
      return false;
    }

    if (state.claimed) {
      this.refuseUnauthorizedClientStream(stream);
      return true;
    }

    state.claimed = true;
    const path = String(headers[':path'] ?? '');
    if (this.isReservedUnauthorizedClientPath(path)) {
      this.refuseUnauthorizedClientStream(stream);
      this.closeUnauthorizedClientSession(session, state);
      return true;
    }

    try {
      session.goaway(http2.constants.NGHTTP2_NO_ERROR);
    } catch {
      this.closeUnauthorizedClientSession(session, state);
      return true;
    }

    void this.handleUnauthorizedClientFirstStream(stream, headers, session, state);
    return true;
  }

  /**
   * Cleans up an unauthorized session after it closes. Returns true when the
   * session was tracked by this gate; the Host must skip peer removal for it.
   */
  public handleSessionClose(session: http2.ServerHttp2Session): boolean {
    const state = this.sessions.get(session);
    if (state === undefined) {
      return false;
    }
    this.sessions.delete(session);
    clearTimeout(state.hardCloseTimer);
    state.controller.abort();
    return true;
  }

  private isReservedUnauthorizedClientPath(path: string): boolean {
    return path === '/verser' || path.startsWith('/verser/');
  }

  private refuseUnauthorizedClientStream(stream: http2.ServerHttp2Stream): void {
    if (stream.closed || stream.destroyed) {
      return;
    }
    stream.once('error', () => {});
    stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
  }

  private async handleUnauthorizedClientFirstStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    session: http2.ServerHttp2Session,
    state: UnauthorizedClientSession,
  ): Promise<void> {
    try {
      const body = await this.readUnauthorizedClientRequestBody(stream, state.controller.signal);
      if (state.controller.signal.aborted) {
        return;
      }
      const result = await this.invokeUnauthorizedClientHandler(
        {
          method: String(headers[':method'] ?? ''),
          path: String(headers[':path'] ?? ''),
          headers: this.getUnauthorizedClientRequestHeaders(headers),
          body,
          signal: state.controller.signal,
        },
        state.controller,
      );
      if (state.controller.signal.aborted) {
        return;
      }
      if (result === undefined) {
        this.refuseUnauthorizedClientStream(stream);
        return;
      }
      this.writeUnauthorizedClientResponse(stream, result);
    } catch (error) {
      if (!session.closed && !session.destroyed && !stream.closed && !stream.destroyed) {
        const statusCode = error instanceof UnauthorizedClientFailure ? error.statusCode : 500;
        this.sendUnauthorizedClientFailure(stream, statusCode);
        if (statusCode === 408) {
          this.refuseUnauthorizedClientStream(stream);
        }
      }
    } finally {
      this.closeUnauthorizedClientSession(session, state);
    }
  }

  private getUnauthorizedClientRequestHeaders(
    headers: http2.IncomingHttpHeaders,
  ): Readonly<Record<string, string | readonly string[]>> {
    const ordinaryHeaders: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith(':') || value === undefined) {
        continue;
      }
      ordinaryHeaders[name] = Array.isArray(value)
        ? value.map((entry) => String(entry))
        : String(value);
    }
    return ordinaryHeaders;
  }

  private readUnauthorizedClientRequestBody(
    stream: http2.ServerHttp2Stream,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const gate = this.gate;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('aborted', onAborted);
        stream.off('error', onError);
        stream.off('close', onClose);
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const fail = (statusCode: number, message: string): void => {
        finish(() => reject(new UnauthorizedClientFailure(statusCode, message)));
      };
      const onData = (chunk: Buffer): void => {
        const buffer = Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > gate.maxRequestBodyBytes) {
          fail(413, 'Unauthorized client request body exceeds the configured limit');
          return;
        }
        chunks.push(buffer);
      };
      const onEnd = (): void => finish(() => resolve(Buffer.concat(chunks, totalBytes)));
      const onAborted = (): void => fail(400, 'Unauthorized client request was aborted');
      const onError = (): void => fail(400, 'Unauthorized client request failed');
      const onClose = (): void => fail(400, 'Unauthorized client request closed before completion');
      const onAbort = (): void => fail(408, 'Unauthorized client request was cancelled');
      const timeout = setTimeout(
        () => fail(408, 'Unauthorized client request timed out'),
        gate.requestTimeoutMs,
      );

      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('aborted', onAborted);
      stream.once('error', onError);
      stream.once('close', onClose);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private invokeUnauthorizedClientHandler(
    context: Parameters<VerserUnauthorizedClientHandler>[0],
    controller: AbortController,
  ): Promise<VerserUnauthorizedClientHandlerResult | undefined> {
    const gate = this.gate;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() =>
          reject(new UnauthorizedClientFailure(408, 'Unauthorized client handler was cancelled')),
        );
      };
      const timeout = setTimeout(() => {
        finish(() =>
          reject(new UnauthorizedClientFailure(500, 'Unauthorized client handler timed out')),
        );
        controller.abort();
      }, gate.handlerTimeoutMs);

      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => gate.handler(context))
        .then(
          (result) => finish(() => resolve(result)),
          () =>
            finish(() =>
              reject(new UnauthorizedClientFailure(500, 'Unauthorized client handler failed')),
            ),
        );
    });
  }

  private writeUnauthorizedClientResponse(
    stream: http2.ServerHttp2Stream,
    result: VerserUnauthorizedClientHandlerResult,
  ): void {
    if (result === null || typeof result !== 'object') {
      throw new UnauthorizedClientFailure(
        500,
        'Unauthorized client handler returned an invalid result',
      );
    }
    if (
      !Number.isSafeInteger(result.statusCode) ||
      result.statusCode < 100 ||
      result.statusCode > 599
    ) {
      throw new UnauthorizedClientFailure(
        500,
        'Unauthorized client handler returned an invalid status code',
      );
    }
    if (result.headers !== undefined) {
      const headers = result.headers;
      const headersPrototype = headers === null ? null : Object.getPrototypeOf(headers);
      if (
        headers === null ||
        typeof headers !== 'object' ||
        (headersPrototype !== Object.prototype && headersPrototype !== null)
      ) {
        throw new UnauthorizedClientFailure(
          500,
          'Unauthorized client handler returned invalid headers',
        );
      }
    }

    let body: Buffer;
    if (result.body === undefined) {
      body = Buffer.alloc(0);
    } else if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
      body = Buffer.from(result.body);
    } else {
      throw new UnauthorizedClientFailure(
        500,
        'Unauthorized client handler returned an invalid body',
      );
    }
    if (body.length > this.gate.maxResponseBodyBytes) {
      throw new UnauthorizedClientFailure(
        500,
        'Unauthorized client response body exceeds the configured limit',
      );
    }

    const sanitizedHeaders = sanitizeHttp2ResponseHeaders(
      validateVerserHeaders(result.headers ?? {}),
    );
    const responseHeaders = Object.fromEntries(
      Object.entries(sanitizedHeaders).filter(([name]) => name !== 'content-length'),
    );
    if (stream.closed || stream.destroyed || stream.headersSent) {
      return;
    }
    stream.respond({
      ':status': result.statusCode,
      ...responseHeaders,
      'content-length': String(body.length),
    });
    stream.end(body);
  }

  private sendUnauthorizedClientFailure(stream: http2.ServerHttp2Stream, statusCode: number): void {
    if (stream.closed || stream.destroyed || stream.headersSent) {
      return;
    }
    try {
      stream.respond({ ':status': statusCode, 'content-length': '0' });
      stream.end();
    } catch {
      this.refuseUnauthorizedClientStream(stream);
    }
  }

  private closeUnauthorizedClientSession(
    session: http2.ServerHttp2Session,
    state: UnauthorizedClientSession,
  ): void {
    if (state.closing) {
      return;
    }
    state.closing = true;
    state.controller.abort();
    if (session.destroyed) {
      return;
    }
    if (!session.closed) {
      session.close();
    }
    state.hardCloseTimer = setTimeout(() => {
      if (!session.destroyed) {
        session.destroy();
      }
    }, UNAUTHORIZED_CLIENT_HARD_CLOSE_TIMEOUT_MS);
    state.hardCloseTimer.unref();
  }
}

import { EventEmitter } from 'node:events';
import type * as http2 from 'node:http2';
import { PassThrough, Readable } from 'node:stream';

import {
  createRoutedResponseEnvelope,
  createVerserError,
  encodeVerserEnvelope,
  sanitizeHttp2ResponseHeaders,
  validateVerserHeaders,
} from '@signicode/verser-common';

import type { VerserNodeGuestDispatchRequest, VerserNodeGuestDispatchResponse } from './types';

/**
 * Minimal HTTP/1-style incoming request object for local Guest handlers.
 *
 * Provides `method`, `url`, and `headers` properties plus a `Readable` stream
 * for the request body. Does **not** implement the full Node.js `IncomingMessage`
 * surface — there is no socket access, trailers, upgrade, or informational response
 * support.
 *
 * The body is streamed from the lease stream source or, when constructed from a
 * {@link VerserNodeGuestDispatchRequest}, from the provided body chunks.
 *
 * @public
 */
export class MinimalIncomingMessage extends PassThrough {
  /** HTTP method (e.g. `GET`, `POST`). */
  public readonly method: string;

  /** Request URL path (e.g. `/api/resource?id=1`). */
  public readonly url: string;

  /** Request headers as a flat key-value map. */
  public readonly headers: Record<string, string>;

  /**
   * @param request - The dispatch request envelope containing method, path, and headers.
   * @param source - Optional readable source for the request body. Defaults to a stream from `request.body`.
   */
  public constructor(request: VerserNodeGuestDispatchRequest, source?: Readable) {
    super();
    this.method = request.method;
    this.url = request.path;
    this.headers = request.headers;

    const bodySource = source ?? Readable.from(request.body);
    bodySource.once('error', (error) => this.destroy(error));
    bodySource.pipe(this);
  }
}

/**
 * Minimal HTTP/1-style server response object for local Guest handlers.
 *
 * Provides common `statusCode`, `setHeader`, `getHeader`, `writeHead`, `write`,
 * and `end` methods compatible with standard Node.js `http.ServerResponse` usage.
 *
 * **Limits:**
 * - When no lease stream is available (`output` is `undefined`), the response body
 *   is buffered in memory up to `maxResponseBytes` (default 10 MiB). Exceeding this
 *   limit throws an error.
 * - When a lease stream is available, the response is streamed directly to the Host
 *   with a binary envelope header written before body data.
 * - Does **not** support HTTP upgrade, WebSocket, CONNECT, trailers, or full socket
 *   semantics.
 *
 * Emits `finish` when `end()` is called, `error` on handler failures, and `drain`
 * when the underlying stream is ready for more data.
 *
 * @public
 */
export class MinimalServerResponse extends EventEmitter {
  /** HTTP response status code. Defaults to `200`. */
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly chunks: Buffer[] = [];

  private readonly requestId?: string;

  private readonly output?: http2.ClientHttp2Stream;

  private readonly maxResponseBytes: number;

  private bufferedResponseBytes = 0;

  private responseStarted = false;

  /**
   * @param requestId - The request ID for envelope metadata.
   * @param output - Optional lease stream for direct HTTP/2 response writing.
   * @param maxResponseBytes - Maximum buffered response body when no stream is available.
   */
  public constructor(
    requestId?: string,
    output?: http2.ClientHttp2Stream,
    maxResponseBytes = 10 * 1024 * 1024,
  ) {
    super();
    this.requestId = requestId;
    this.output = output;
    this.maxResponseBytes = maxResponseBytes;
    output?.on('drain', () => this.emit('drain'));
    output?.on('error', (error) => this.emit('error', error));
  }

  /**
   * Whether response headers have been written to the output stream.
   */
  public get headersStarted(): boolean {
    return this.responseStarted;
  }

  /**
   * Sets a response header.
   *
   * Header names are lowercased and values are converted to string.
   *
   * @param name - Header name.
   * @param value - Header value.
   * @returns `this` for chaining.
   */
  public setHeader(name: string, value: string | number | boolean): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  /**
   * Gets a response header by name (case-insensitive).
   *
   * @param name - Header name.
   * @returns The header value or `undefined`.
   */
  public getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  /**
   * Writes the response status line and headers.
   *
   * @param statusCode - HTTP status code.
   * @param headers - Optional headers to set.
   * @returns `this` for chaining.
   */
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

  /**
   * Writes a chunk of response body data.
   *
   * When no lease stream is available the chunk is buffered. Buffered response
   * body bytes are checked against `maxResponseBytes` and an error is thrown
   * if exceeded.
   *
   * When a lease stream is available the response headers are written as a
   * binary envelope before the first data chunk, and subsequent data is
   * streamed directly.
   *
   * @param chunk - Body data chunk.
   * @param encoding - Character encoding when `chunk` is a string.
   * @returns `true` if the data was accepted, `false` if backpressure applies.
   */
  public write(chunk: string | Buffer, encoding: BufferEncoding = 'utf8'): boolean {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.output === undefined) {
      this.bufferedResponseBytes += buffer.length;
      if (this.bufferedResponseBytes > this.maxResponseBytes) {
        const error = createVerserError(
          'local-handler-failure',
          'Response body bytes exceed limit',
          {
            responseBytes: this.bufferedResponseBytes,
            maxResponseBytes: this.maxResponseBytes,
          },
        );
        this.emit('error', error);
        throw error;
      }
      this.chunks.push(buffer);
      return true;
    }

    this.startStreamingResponse();
    return this.output.write(buffer);
  }

  /**
   * Commits response headers to the output stream without writing body data
   * or ending the response.
   *
   * When a lease stream is available the response envelope is written
   * immediately, enabling early header delivery to the Host and Broker.
   *
   * When no lease stream is available (buffered path) this is a no-op,
   * consistent with the current lazy dispatch behaviour where headers are
   * committed on the first `write()` or `end()` call.
   */
  public flushHeaders(): void {
    this.startStreamingResponse();
  }

  /**
   * Finalises the response.
   *
   * If a chunk is provided it is written first. The underlying output stream
   * is ended and a `finish` event is emitted.
   *
   * @param chunk - Optional final body chunk.
   * @param encoding - Character encoding when `chunk` is a string.
   * @returns `this` for chaining.
   */
  public end(chunk?: string | Buffer, encoding: BufferEncoding = 'utf8'): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    } else if (this.output !== undefined) {
      this.startStreamingResponse();
    }
    this.output?.end();
    this.emit('finish');
    return this;
  }

  /**
   * Converts the buffered response to a dispatch response envelope.
   *
   * Used by the `dispatchRoutedRequest` code path where no lease stream is
   * available and the response is returned as a complete buffer.
   *
   * @param requestId - The request ID to include in the response envelope.
   * @returns A fully buffered dispatch response.
   */
  public toDispatchResponse(requestId: string): VerserNodeGuestDispatchResponse {
    const rawHeaders = Object.fromEntries(this.headers);
    return {
      ...createRoutedResponseEnvelope({
        requestId,
        statusCode: this.statusCode,
        headers: sanitizeHttp2ResponseHeaders(rawHeaders),
      }),
      body: Buffer.concat(this.chunks),
    };
  }

  private startStreamingResponse(): void {
    const output = this.output;
    if (output === undefined || this.responseStarted) {
      return;
    }
    this.responseStarted = true;
    output.write(
      encodeVerserEnvelope({
        type: 'response',
        metadata: {
          requestId: this.requestId ?? '',
          statusCode: this.statusCode,
          headers: validateVerserHeaders(
            sanitizeHttp2ResponseHeaders(Object.fromEntries(this.headers)),
          ),
        },
      }),
    );
  }
}

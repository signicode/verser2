import { EventEmitter } from 'node:events';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import * as http2 from 'node:http2';
import { PassThrough, Readable } from 'node:stream';

import {
  type VerserHeaderPair,
  createRoutedResponseEnvelope,
  createVerserError,
  encodeVerserEnvelope,
  requireFinalResponseStatusCode,
  validateVerserStatusText,
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

    // Default error handler to prevent process crashes from unhandled
    // 'error' events (e.g. remote H2 stream cancellation arriving after
    // the request stream has ended normally via the pipe).  Handlers
    // that call `request.on('error', ...)` will still receive the event;
    // handlers that don't listen for errors are protected from crashes.
    this.on('error', () => {});
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

  /** Optional HTTP response reason phrase. An empty string is preserved. */
  public statusMessage?: string;

  /**
   * Whether `end()` has been called on this response.
   *
   * Set to `true` by `end()`, used to detect premature output stream closure.
   */
  public finished = false;

  private readonly headers = new Map<string, string | string[]>();

  /** Exact response-header emission order, including interleaved duplicate names. */
  private readonly headerPairs: VerserHeaderPair[] = [];

  private readonly chunks: Buffer[] = [];

  private readonly requestId?: string;

  private readonly output?: http2.ClientHttp2Stream;

  private readonly maxResponseBytes: number;

  private bufferedResponseBytes = 0;

  private responseStarted = false;

  private commitFailed = false;

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
    super({ captureRejections: true });
    this.requestId = requestId;
    this.output = output;
    this.maxResponseBytes = maxResponseBytes;
    output?.on('drain', () => this.emit('drain'));
    output?.on('error', (error) => this.emit('error', error));
    // If the output stream closes (remote RST) before response ends, emit
    // an error so handlers can detect premature stream closure.
    output?.once('close', () => {
      if (
        !this.finished &&
        output.rstCode !== undefined &&
        output.rstCode !== http2.constants.NGHTTP2_NO_ERROR
      ) {
        const closeError = createVerserError(
          'stream-failure',
          'Output stream was closed by remote peer',
          {
            requestId: this.requestId ?? '',
            rstCode: String(output.rstCode),
          },
        );
        this.emit('error', closeError);
      }
    });
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
  public setHeader(name: string, value: ResponseHeaderValue): this {
    const [normalizedName, normalizedValue] = normalizeResponseHeader(name, value);
    this.headers.set(normalizedName, normalizedValue);
    this.removeHeaderPairs(normalizedName);
    this.headerPairs.push(
      ...(Array.isArray(normalizedValue) ? normalizedValue : [normalizedValue]).map(
        (item): VerserHeaderPair => [normalizedName, item],
      ),
    );
    return this;
  }

  /**
   * Gets a response header by name (case-insensitive).
   *
   * @param name - Header name.
   * @returns The header value or `undefined`.
   */
  public getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  /** Appends a value without replacing existing values for the header. */
  public appendHeader(name: string, value: ResponseHeaderValue): this {
    const [normalizedName, values] = normalizeResponseHeaderValues(name, value);
    const existing = this.getHeader(normalizedName);
    this.headers.set(
      normalizedName,
      existing === undefined
        ? values.length === 1
          ? values[0]
          : values
        : [...(Array.isArray(existing) ? existing : [existing]), ...values],
    );
    this.headerPairs.push(...values.map((item): VerserHeaderPair => [normalizedName, item]));
    return this;
  }

  /**
   * Writes the response status line and headers.
   *
   * @param statusCode - HTTP status code.
   * @param headers - Optional headers to set.
   * @returns `this` for chaining.
   */
  public writeHead(statusCode: number, headers?: ResponseHeaders): this;
  public writeHead(statusCode: number, statusMessage: undefined, headers: ResponseHeaders): this;
  public writeHead(statusCode: number, statusMessage?: string, headers?: ResponseHeaders): this;
  public writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | ResponseHeaders,
    headers?: ResponseHeaders,
  ): this {
    const responseHeaders =
      typeof statusMessageOrHeaders === 'string'
        ? (headers ?? {})
        : (headers ?? statusMessageOrHeaders ?? {});
    requireFinalResponseStatusCode(statusCode);
    if (typeof statusMessageOrHeaders === 'string')
      validateVerserStatusText(statusMessageOrHeaders);
    const nextHeaders = new Map(this.headers);
    const nextPairs = [...this.headerPairs];
    if (Array.isArray(responseHeaders)) {
      const replaced = new Set<string>();
      for (const [name, value] of responseHeaders) {
        const [normalizedName, normalizedValue] = normalizeResponseHeader(name, value);
        if (replaced.has(normalizedName)) {
          appendResponseHeader(nextHeaders, nextPairs, normalizedName, normalizedValue);
        } else {
          setResponseHeader(nextHeaders, nextPairs, normalizedName, normalizedValue);
          replaced.add(normalizedName);
        }
      }
    } else {
      for (const [name, value] of Object.entries(responseHeaders)) {
        const [normalizedName, normalizedValue] = normalizeResponseHeader(name, value);
        setResponseHeader(nextHeaders, nextPairs, normalizedName, normalizedValue);
      }
    }
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders;
    this.headers.clear();
    for (const [name, value] of nextHeaders) this.headers.set(name, value);
    this.headerPairs.splice(0, this.headerPairs.length, ...nextPairs);
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
    if (!this.commitResponse()) return false;
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
    this.commitResponse();
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
    if (this.commitFailed) return this;
    if (chunk !== undefined) {
      this.write(chunk, encoding);
      if (this.commitFailed) return this;
    } else if (!this.commitResponse()) {
      return this;
    }
    this.finished = true;
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
    return {
      ...this.createCanonicalResponse(requestId),
      body: Buffer.concat(this.chunks),
    };
  }

  private startStreamingResponse(): void {
    const output = this.output;
    if (output === undefined || this.responseStarted) {
      return;
    }
    const response = this.createCanonicalResponse(this.requestId ?? '');
    this.responseStarted = true;
    output.write(
      encodeVerserEnvelope({
        type: 'response',
        metadata: response,
      }),
    );
  }

  private commitResponse(): boolean {
    if (this.commitFailed) return false;
    try {
      if (this.output === undefined) {
        // For buffered responses with a known request ID (direct Node Guest
        // dispatch), canonicalize eagerly to surface validation errors early.
        // For standalone adapter use (no request ID), defer validation to
        // toDispatchResponse(realRequestId) to avoid protocol errors from
        // an empty placeholder request ID.
        if (this.requestId !== undefined) {
          this.createCanonicalResponse(this.requestId);
        }
      } else {
        this.startStreamingResponse();
      }
      return true;
    } catch (error) {
      this.commitFailed = true;
      this.emit('error', error);
      return false;
    }
  }

  private createCanonicalResponse(
    requestId: string,
  ): Omit<VerserNodeGuestDispatchResponse, 'body'> {
    return createRoutedResponseEnvelope({
      requestId,
      statusCode: this.statusCode,
      headers: {},
      ...(this.statusMessage === undefined ? {} : { statusText: this.statusMessage }),
      headerPairs: this.toHeaderPairs(),
    });
  }

  private toHeaderPairs(): VerserHeaderPair[] {
    return [...this.headerPairs];
  }

  private removeHeaderPairs(name: string): void {
    for (let index = this.headerPairs.length - 1; index >= 0; index -= 1) {
      if (this.headerPairs[index][0] === name) {
        this.headerPairs.splice(index, 1);
      }
    }
  }
}

type ResponseHeaderValue = string | number | boolean | readonly (string | number | boolean)[];
type ResponseHeaders =
  | Record<string, ResponseHeaderValue>
  | readonly (readonly [string, ResponseHeaderValue])[];

function normalizeResponseHeader(
  name: string,
  value: ResponseHeaderValue,
): [string, string | string[]] {
  const [normalizedName, values] = normalizeResponseHeaderValues(name, value);
  return [normalizedName, Array.isArray(value) ? values : values[0]];
}

function normalizeResponseHeaderValues(
  name: string,
  value: ResponseHeaderValue,
): [string, string[]] {
  validateHeaderName(name);
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  for (const item of values) validateHeaderValue(name, item);
  return [name.toLowerCase(), values];
}

function setResponseHeader(
  headers: Map<string, string | string[]>,
  pairs: VerserHeaderPair[],
  name: string,
  value: string | string[],
): void {
  headers.set(name, value);
  removeResponseHeaderPairs(pairs, name);
  pairs.push(
    ...(Array.isArray(value) ? value : [value]).map((item): VerserHeaderPair => [name, item]),
  );
}

function appendResponseHeader(
  headers: Map<string, string | string[]>,
  pairs: VerserHeaderPair[],
  name: string,
  value: string | string[],
): void {
  const values = Array.isArray(value) ? value : [value];
  const existing = headers.get(name);
  headers.set(
    name,
    existing === undefined
      ? values.length === 1
        ? values[0]
        : values
      : [...(Array.isArray(existing) ? existing : [existing]), ...values],
  );
  pairs.push(...values.map((item): VerserHeaderPair => [name, item]));
}

function removeResponseHeaderPairs(pairs: VerserHeaderPair[], name: string): void {
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    if (pairs[index][0] === name) pairs.splice(index, 1);
  }
}

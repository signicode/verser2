import { EventEmitter } from 'node:events';
import type * as http2 from 'node:http2';
import { PassThrough, Readable } from 'node:stream';

import {
  createRoutedResponseEnvelope,
  createVerserError,
  encodeVerserEnvelope,
  validateVerserHeaders,
} from '@signicode/verser-common';

import type { VerserNodeGuestDispatchRequest, VerserNodeGuestDispatchResponse } from './types';

export class MinimalIncomingMessage extends PassThrough {
  public readonly method: string;

  public readonly url: string;

  public readonly headers: Record<string, string>;

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

export class MinimalServerResponse extends EventEmitter {
  public statusCode = 200;

  private readonly headers = new Map<string, string>();

  private readonly chunks: Buffer[] = [];

  private readonly requestId?: string;

  private readonly output?: http2.ClientHttp2Stream;

  private readonly maxResponseBytes: number;

  private bufferedResponseBytes = 0;

  private responseStarted = false;

  public constructor(requestId?: string, output?: http2.ClientHttp2Stream, maxResponseBytes = 10 * 1024 * 1024) {
    super();
    this.requestId = requestId;
    this.output = output;
    this.maxResponseBytes = maxResponseBytes;
    output?.on('drain', () => this.emit('drain'));
    output?.on('error', (error) => this.emit('error', error));
  }

  public get headersStarted(): boolean {
    return this.responseStarted;
  }

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
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.output === undefined) {
      this.bufferedResponseBytes += buffer.length;
      if (this.bufferedResponseBytes > this.maxResponseBytes) {
        const error = createVerserError('local-handler-failure', 'Response body bytes exceed limit', {
          responseBytes: this.bufferedResponseBytes,
          maxResponseBytes: this.maxResponseBytes,
        });
        this.emit('error', error);
        throw error;
      }
      this.chunks.push(buffer);
      return true;
    }

    this.startStreamingResponse();
    return this.output.write(buffer);
  }

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
          headers: validateVerserHeaders(Object.fromEntries(this.headers)),
        },
      }),
    );
  }
}

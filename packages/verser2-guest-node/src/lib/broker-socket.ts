import type * as http from 'node:http';
import { Duplex, PassThrough, Writable } from 'node:stream';

import { ChunkedBodyDecoder } from './chunked-body-decoder';
import { normalizeRequestHeaders, parseContentLength } from './header-utils';
import type { BrokerRequestRouter } from './types';
import { serializeHttpResponseHead } from './utils';

type BrokerSocketGuestOptions = http.RequestOptions;

export class VerserBrokerSocket extends Duplex {
  public override writable = true;

  public override readable = true;

  public connecting = false;

  private readonly broker: BrokerRequestRouter;

  private readonly targetId: string;

  private readonly options: BrokerSocketGuestOptions;

  private requestBuffer = Buffer.alloc(0);

  private bodyStream?: PassThrough;

  private chunkDecoder?: ChunkedBodyDecoder;

  private expectedBodyBytes = 0;

  private receivedBodyBytes = 0;

  private forwardingStarted = false;

  private pendingResponseWriteCallback?: () => void;

  public constructor(
    broker: BrokerRequestRouter,
    targetId: string,
    options: BrokerSocketGuestOptions,
  ) {
    super();
    this.broker = broker;
    this.targetId = targetId;
    this.options = options;
    process.nextTick(() => this.emit('connect'));
  }

  public override _read(): void {
    const callback = this.pendingResponseWriteCallback;
    if (callback === undefined) {
      return;
    }

    this.pendingResponseWriteCallback = undefined;
    callback();
  }

  public override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.consumeRequestBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  public override _final(callback: () => void): void {
    this.bodyStream?.end();
    callback();
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.bodyStream?.end();
    this.pendingResponseWriteCallback?.();
    this.pendingResponseWriteCallback = undefined;
    callback(error);
  }

  public setTimeout(_timeout: number, callback?: () => void): this {
    if (callback !== undefined) {
      this.once('timeout', callback);
    }
    return this;
  }

  public setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  public setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }

  public forwardRequestOnce(): void {
    if (this.forwardingStarted) {
      return;
    }
    this.forwardingStarted = true;
    this.forwardRequest().catch((error: unknown) => {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async forwardRequest(): Promise<void> {
    const bodyStream = this.bodyStream ?? new PassThrough();
    this.bodyStream = bodyStream;
    const requestHeaders = this.options.headers;
    const response = (await this.broker.request({
      targetId: this.targetId,
      method: String(this.options.method ?? 'GET'),
      path: String(this.options.path ?? '/'),
      headers: normalizeRequestHeaders(
        Array.isArray(requestHeaders)
          ? undefined
          : (requestHeaders as http.OutgoingHttpHeaders | undefined),
      ),
      body: bodyStream,
    })) as unknown as {
      statusCode: number;
      headers: Record<string, string>;
      body: {
        pipe(destination: NodeJS.WritableStream): void;
        on(event: 'error', handler: (error: Error) => void): void;
      };
    };
    this.push(
      serializeHttpResponseHead({ statusCode: response.statusCode, headers: response.headers }),
    );
    response.body.pipe(this.createResponseSink());
    response.body.on('error', (error) => this.destroy(error));
  }

  private createResponseSink(): Writable {
    return new Writable({
      write: (chunk: Buffer | string, _encoding, callback): void => {
        const shouldContinue = this.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, _encoding),
        );
        if (shouldContinue) {
          callback();
          return;
        }

        this.pendingResponseWriteCallback = callback;
      },
      final: (callback): void => {
        this.bodyStream?.end();
        this.push(null);
        process.nextTick(() => this.destroy());
        callback();
      },
    });
  }

  private consumeRequestBytes(chunk: Buffer): void {
    if (this.bodyStream !== undefined) {
      this.writeBodyBytes(chunk);
      return;
    }

    this.requestBuffer = Buffer.concat([this.requestBuffer, chunk]);
    const separatorIndex = this.requestBuffer.indexOf('\r\n\r\n', 0, 'latin1');
    if (separatorIndex === -1) {
      return;
    }

    const headerText = this.requestBuffer.slice(0, separatorIndex).toString('latin1');
    const bodyStart = separatorIndex + 4;
    const firstBodyChunk = this.requestBuffer.subarray(bodyStart);
    this.requestBuffer = Buffer.alloc(0);
    this.bodyStream = new PassThrough();
    this.expectedBodyBytes = parseContentLength(headerText);
    const isChunked = /transfer-encoding:\s*chunked/i.test(headerText);
    if (isChunked) {
      this.chunkDecoder = new ChunkedBodyDecoder(this.bodyStream);
    }

    this.forwardRequestOnce();
    if (firstBodyChunk.length > 0) {
      this.writeBodyBytes(firstBodyChunk);
    }

    const expectsBody = this.expectedBodyBytes > 0 || isChunked;
    if (!expectsBody) {
      this.bodyStream.end();
    }
  }

  private writeBodyBytes(chunk: Buffer): void {
    if (this.bodyStream === undefined) {
      return;
    }

    if (this.chunkDecoder !== undefined) {
      this.chunkDecoder.write(chunk);
      return;
    }

    if (this.expectedBodyBytes > 0) {
      const remaining = this.expectedBodyBytes - this.receivedBodyBytes;
      const toWrite = chunk.subarray(0, remaining);
      this.receivedBodyBytes += toWrite.length;
      if (toWrite.length > 0) {
        this.bodyStream.write(toWrite);
      }
      if (this.receivedBodyBytes >= this.expectedBodyBytes) {
        this.bodyStream.end();
      }
      return;
    }

    this.bodyStream.write(chunk);
  }
}

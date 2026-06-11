import type { PassThrough } from 'node:stream';

import { createVerserError } from '@signicode/verser-common';

export interface ChunkedBodyDecoderOptions {
  readonly maxChunkSizeLineBytes: number;
  readonly maxPendingBytes: number;
}

export class ChunkedBodyDecoder {
  private pending = Buffer.alloc(0);

  private expectedChunkBytes: number | undefined;

  public constructor(
    private readonly output: PassThrough,
    private readonly options: ChunkedBodyDecoderOptions,
  ) {}

  public write(chunk: Buffer): boolean {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.assertPendingWithinLimit();
    return this.flush();
  }

  public flush(): boolean {
    while (this.pending.length > 0) {
      if (this.expectedChunkBytes === undefined) {
        const lineEnd = this.pending.indexOf('\r\n', 0, 'latin1');
        if (lineEnd === -1) {
          if (this.pending.length > this.options.maxChunkSizeLineBytes) {
            throw createVerserError('protocol-error', 'Chunk size line bytes exceed limit', {
              lineBytes: this.pending.length,
              maxChunkSizeLineBytes: this.options.maxChunkSizeLineBytes,
            });
          }
          return true;
        }
        if (lineEnd > this.options.maxChunkSizeLineBytes) {
          throw createVerserError('protocol-error', 'Chunk size line bytes exceed limit', {
            lineBytes: lineEnd,
            maxChunkSizeLineBytes: this.options.maxChunkSizeLineBytes,
          });
        }
        const sizeText = this.pending.subarray(0, lineEnd).toString('ascii');
        if (!/^[0-9a-fA-F]+(?:;.*)?$/.test(sizeText)) {
          throw createVerserError('protocol-error', 'Invalid chunk size line', { sizeText });
        }
        const size = Number.parseInt(sizeText, 16);
        this.pending = this.pending.subarray(lineEnd + 2);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw createVerserError('protocol-error', 'Invalid chunk size line', { sizeText });
        }
        if (size === 0) {
          this.output.end();
          this.pending = Buffer.alloc(0);
          return true;
        }
        this.expectedChunkBytes = size;
      }

      if (this.pending.length < this.expectedChunkBytes + 2) {
        this.assertPendingWithinLimit();
        return true;
      }
      const accepted = this.output.write(this.pending.subarray(0, this.expectedChunkBytes));
      this.pending = this.pending.subarray(this.expectedChunkBytes + 2);
      this.expectedChunkBytes = undefined;
      if (!accepted) {
        return false;
      }
    }

    return true;
  }

  private assertPendingWithinLimit(): void {
    if (this.pending.length <= this.options.maxPendingBytes) {
      return;
    }

    throw createVerserError('protocol-error', 'Chunk decoder pending bytes exceed limit', {
      pendingBytes: this.pending.length,
      maxPendingBytes: this.options.maxPendingBytes,
    });
  }
}

import type { PassThrough } from 'node:stream';

export class ChunkedBodyDecoder {
  private pending = Buffer.alloc(0);

  private expectedChunkBytes: number | undefined;

  public constructor(private readonly output: PassThrough) {}

  public write(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.flush();
  }

  private flush(): void {
    while (this.pending.length > 0) {
      if (this.expectedChunkBytes === undefined) {
        const lineEnd = this.pending.indexOf('\r\n', 0, 'latin1');
        if (lineEnd === -1) {
          return;
        }
        const size = Number.parseInt(this.pending.subarray(0, lineEnd).toString('ascii'), 16);
        this.pending = this.pending.subarray(lineEnd + 2);
        if (size === 0 || !Number.isFinite(size)) {
          this.output.end();
          this.pending = Buffer.alloc(0);
          return;
        }
        this.expectedChunkBytes = size;
      }

      if (this.pending.length < this.expectedChunkBytes + 2) {
        return;
      }
      this.output.write(this.pending.subarray(0, this.expectedChunkBytes));
      this.pending = this.pending.subarray(this.expectedChunkBytes + 2);
      this.expectedChunkBytes = undefined;
    }
  }
}

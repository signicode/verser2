import type { EventEmitter } from 'node:events';

import { createVerserError } from './errors';
import type { VerserError } from './errors';
import { getErrorMessage } from './utils';

export function readNdjsonLines<T>(
  stream: EventEmitter,
  onFrame: (frame: T) => void,
  onError?: (error: VerserError) => void,
): void {
  let pending = '';
  const readable = stream as EventEmitter & {
    destroy?(error?: Error): void;
    setEncoding?(encoding: BufferEncoding): void;
  };
  readable.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    let lineBreak = pending.indexOf('\n');
    while (lineBreak !== -1) {
      const line = pending.slice(0, lineBreak);
      pending = pending.slice(lineBreak + 1);
      if (line.length > 0) {
        try {
          onFrame(JSON.parse(line) as T);
        } catch (error) {
          const verserError = createVerserError('protocol-error', 'Invalid NDJSON control frame', {
            cause: getErrorMessage(error),
          });
          onError?.(verserError);
          readable.destroy?.();
          return;
        }
      }
      lineBreak = pending.indexOf('\n');
    }
  });
}

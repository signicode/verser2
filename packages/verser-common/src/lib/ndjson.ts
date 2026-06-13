import type { EventEmitter } from 'node:events';

import { createVerserError } from './errors';
import type { VerserError } from './errors';
import { getErrorMessage } from './utils';

/**
 * Encodes a value as a newline-terminated JSON line (NDJSON).
 *
 * Used for Broker route-control frames on the control stream and for
 * Host registration responses sent to Brokers.
 *
 * @param value - The value to serialize as JSON.
 * @returns A buffer containing `JSON.stringify(value)` followed by `\n`.
 * @public
 */
export function encodeJsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

/**
 * Reads newline-delimited JSON (NDJSON) frames from a readable stream.
 *
 * Attaches `data`, `end`, `error`, and `close` event handlers. Each complete
 * line is parsed as JSON and passed to the `onFrame` callback. Parse errors
 * destroy the stream and invoke `onError`.
 *
 * @typeParam T - The expected type of each parsed frame.
 * @param stream - The readable stream (EventEmitter-based) to consume.
 * @param onFrame - Called with each successfully parsed JSON frame.
 * @param onError - Optional callback for parse errors; the stream is destroyed on error.
 * @public
 */
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

import type { Readable } from 'node:stream';

import { createVerserError } from './errors';
import type { VerserStreamReadContext } from './types';

/**
 * Reads exactly `byteCount` bytes from a Node.js `Readable` stream.
 *
 * Uses internal buffering and `stream.read()` calls. If insufficient data is
 * available, waits for the `'readable'` event. The stream must not be in
 * flowing mode.
 *
 * @param stream - The readable stream to read from.
 * @param byteCount - The exact number of bytes to read.
 * @param context - Optional diagnostic context for error messages.
 * @returns A buffer containing exactly `byteCount` bytes.
 * @throws {VerserError} With code `protocol-error` if the stream ends or closes
 *   before the requested number of bytes is available.
 * @public
 */
export async function readExactly(
  stream: Readable,
  byteCount: number,
  context: VerserStreamReadContext = {},
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remainingBytes = byteCount;

  while (remainingBytes > 0) {
    const chunk = stream.read(remainingBytes) as Buffer | string | null;
    if (chunk === null) {
      await waitForReadable(stream, context);
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

function waitForReadable(stream: Readable, context: VerserStreamReadContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReadable = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(
        createVerserError('protocol-error', 'Lease stream ended before metadata', {
          ...context,
        }),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(
        error instanceof Error
          ? error
          : createVerserError('protocol-error', String(error), { ...context }),
      );
    };
    const onClose = (): void => {
      cleanup();
      reject(
        createVerserError('protocol-error', 'Lease stream closed before metadata', {
          ...context,
        }),
      );
    };
    const cleanup = (): void => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    };

    stream.once('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

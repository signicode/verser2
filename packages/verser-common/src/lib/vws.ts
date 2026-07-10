/**
 * VWS/1 WebSocket frame types and helpers.
 *
 * VWS/1 uses NDJSON (newline-delimited JSON) over existing TLS HTTP/2
 * streams. Each frame is a single JSON object terminated by `\n`.
 * Binary payloads are base64-encoded inside the JSON.
 *
 * Frame types: open, accept, text, binary, close, error.
 *
 * @public
 */

import type { Readable } from 'node:stream';

/**
 * Default maximum VWS frame/message byte size (1 MiB).
 * @public
 */
export const VWS_MAX_FRAME_BYTES = 1 * 1024 * 1024;

/**
 * Discriminated VWS/1 frame type union.
 * @public
 */
export type VwsFrameType = 'open' | 'accept' | 'text' | 'binary' | 'close' | 'error';

/**
 * VWS/1 open frame — Broker → Host → Guest to initiate a WebSocket.
 * @public
 */
export interface VwsOpenFrame {
  readonly type: 'open';
  readonly domain: string;
  readonly path?: string;
  readonly protocol?: string;
}

/**
 * VWS/1 accept frame — Guest → Host → Broker to confirm the WebSocket.
 * @public
 */
export interface VwsAcceptFrame {
  readonly type: 'accept';
  readonly protocol?: string;
}

/**
 * VWS/1 text frame — carries a UTF-8 text payload.
 * @public
 */
export interface VwsTextFrame {
  readonly type: 'text';
  readonly data: string;
}

/**
 * VWS/1 binary frame — base64-encoded binary payload.
 * @public
 */
export interface VwsBinaryFrame {
  readonly type: 'binary';
  readonly data: string; // base64-encoded
}

/**
 * VWS/1 close frame — code and optional reason.
 * @public
 */
export interface VwsCloseFrame {
  readonly type: 'close';
  readonly code: number;
  readonly reason?: string;
}

/**
 * VWS/1 error frame — protocol error.
 * @public
 */
export interface VwsErrorFrame {
  readonly type: 'error';
  readonly message: string;
}

/**
 * Union of all VWS/1 frame types.
 * @public
 */
export type VwsFrame =
  | VwsOpenFrame
  | VwsAcceptFrame
  | VwsTextFrame
  | VwsBinaryFrame
  | VwsCloseFrame
  | VwsErrorFrame;

/**
 * Encodes a VWS frame as a single NDJSON line.
 *
 * @param frame - The VWS frame to encode.
 * @returns A string ending with `\n`.
 * @public
 */
export function encodeVwsFrame(frame: VwsFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Decodes a single VWS NDJSON line into a typed frame.
 *
 * @param line - A single JSON line (with or without trailing `\n`).
 * @returns The parsed VWS frame.
 * @throws {Error} If the line is not valid JSON or the frame type is missing,
 *   or if the frame exceeds {@link VWS_MAX_FRAME_BYTES}.
 * @public
 */
export function decodeVwsFrame(line: string): VwsFrame {
  if (Buffer.byteLength(line, 'utf8') > VWS_MAX_FRAME_BYTES) {
    throw Object.assign(new Error('VWS frame exceeds maximum allowed size'), { closeCode: 1009 });
  }
  const trimmed = line.trimEnd();
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid VWS frame: expected a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    throw new Error('Invalid VWS frame: missing or non-string type');
  }
  return parsed as VwsFrame;
}

/**
 * Reads a single VWS/1 NDJSON line from a `Readable` stream, enforcing a
 * maximum byte limit. Preserves bytes after the first `\n` by calling
 * `stream.unshift()`, preventing data loss when switching to a framed parser.
 *
 * @param stream - A `Readable` stream (e.g. an HTTP/2 stream).
 * @param maxBytes - Maximum bytes to accumulate before giving up.
 *   Defaults to {@link VWS_MAX_FRAME_BYTES}.
 * @returns The line content **without** the trailing `\n`.
 * @throws {Error} If the stream ends before a newline is found, or if the
 *   line exceeds `maxBytes`. The error carries a `closeCode` property set
 *   to 1009 when the line is oversized.
 * @public
 */
export function readVwsLine(
  stream: Readable,
  maxBytes: number = VWS_MAX_FRAME_BYTES,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';

    const rejectOversize = (): void => {
      stream.off('data', onData);
      const err = new Error(
        `VWS frame exceeds maximum allowed size (${maxBytes} bytes)`,
      ) as Error & { closeCode: number };
      err.closeCode = 1009;
      reject(err);
    };

    const onData = (chunk: Buffer): void => {
      const str = chunk.toString();
      const idx = str.indexOf('\n');
      if (idx >= 0) {
        const line = buffer + str.slice(0, idx);
        // Enforce maxBytes before resolving, even when newline is in this chunk
        if (Buffer.byteLength(line, 'utf8') > maxBytes) {
          rejectOversize();
          return;
        }
        stream.off('data', onData);
        // Preserve remaining bytes after newline for subsequent parsers
        const remaining = str.slice(idx + 1);
        if (remaining.length > 0) {
          stream.unshift(Buffer.from(remaining));
        }
        resolve(line);
        return;
      }
      // No newline in this chunk — accumulate and check size
      const newBuffer = buffer + str;
      const newByteLength = Buffer.byteLength(newBuffer, 'utf8');
      if (newByteLength > maxBytes) {
        rejectOversize();
        return;
      }
      buffer = newBuffer;
    };

    stream.on('data', onData);
    stream.once('end', () => {
      stream.off('data', onData);
      if (buffer.length > 0) {
        resolve(buffer);
      } else {
        reject(new Error('Stream ended before VWS frame'));
      }
    });
    stream.once('error', (err: Error) => {
      stream.off('data', onData);
      reject(err);
    });
    stream.once('close', () => {
      stream.off('data', onData);
      reject(new Error('Stream closed before VWS frame'));
    });
  });
}

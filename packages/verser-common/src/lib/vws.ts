/**
 * VWS/1 WebSocket frame types and helpers.
 *
 * VWS/1 uses NDJSON (newline-delimited JSON) over existing TLS HTTP/2
 * streams. Each frame is a single JSON object terminated by `\n`.
 * Binary payloads are base64-encoded inside the JSON.
 *
 * Frame types: open, accept, text, binary, ping, pong, close, error.
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
export type VwsFrameType =
  | 'open'
  | 'accept'
  | 'text'
  | 'binary'
  | 'ping'
  | 'pong'
  | 'close'
  | 'error';

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

export interface VwsPingFrame {
  readonly type: 'ping';
  readonly data?: string;
}

export interface VwsPongFrame {
  readonly type: 'pong';
  readonly data?: string;
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
  | VwsPingFrame
  | VwsPongFrame
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
  const protocolError = (message: string): never => {
    throw Object.assign(new Error(message), { closeCode: 1002 });
  };
  const optionalString = (name: string): void => {
    if (obj[name] !== undefined && typeof obj[name] !== 'string')
      protocolError(`Invalid VWS ${name}`);
  };
  switch (obj.type) {
    case 'open':
      if (
        typeof obj.domain !== 'string' ||
        (obj.path !== undefined && typeof obj.path !== 'string')
      )
        protocolError('Invalid VWS open frame');
      optionalString('protocol');
      break;
    case 'accept':
      optionalString('protocol');
      break;
    case 'text':
      if (typeof obj.data !== 'string') protocolError('Invalid VWS text frame');
      break;
    case 'binary':
      if (
        typeof obj.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(obj.data)
      )
        protocolError('Invalid VWS binary frame');
      break;
    case 'ping':
    case 'pong':
      optionalString('data');
      break;
    case 'close': {
      if (
        typeof obj.code !== 'number' ||
        !Number.isInteger(obj.code) ||
        (obj.reason !== undefined && typeof obj.reason !== 'string')
      )
        protocolError('Invalid VWS close frame');
      const code = obj.code as number;
      if (
        !(
          (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
          (code >= 3000 && code <= 4999)
        )
      )
        protocolError('Invalid VWS close code');
      if (typeof obj.reason === 'string' && Buffer.byteLength(obj.reason, 'utf8') > 123)
        protocolError('VWS close reason exceeds 123 UTF-8 bytes');
      break;
    }
    case 'error':
      if (typeof obj.message !== 'string') protocolError('Invalid VWS error frame');
      break;
    default:
      protocolError('Unknown VWS frame type');
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
    let buffer = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const oversize = (): void => {
      const err = new Error(
        `VWS frame exceeds maximum allowed size (${maxBytes} bytes)`,
      ) as Error & { closeCode: number };
      err.closeCode = 1009;
      finish(err);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const idx = buffer.indexOf(0x0a);
      if (idx < 0) {
        if (buffer.byteLength > maxBytes) oversize();
        return;
      }
      const line = buffer.subarray(0, idx);
      const remaining = buffer.subarray(idx + 1);
      if (line.byteLength > maxBytes) {
        oversize();
        return;
      }
      finish(undefined, line.toString('utf8'));
      if (remaining.byteLength > 0) stream.unshift(remaining);
    };
    const onEnd = (): void =>
      finish(
        buffer.byteLength > 0 ? undefined : new Error('Stream ended before VWS frame'),
        buffer.toString('utf8'),
      );
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('Stream closed before VWS frame'));
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

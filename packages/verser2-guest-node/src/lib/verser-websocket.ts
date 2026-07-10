/**
 * VWS/1 WebSocket EventEmitter class used by both the Node Guest handler
 * and the Broker response.
 *
 * Each instance wraps a single HTTP/2 stream and speaks the VWS/1 NDJSON
 * frame protocol.  Binary payloads are base64-encoded on the wire.
 *
 * @public
 */

import { EventEmitter } from 'node:events';
import type * as http2 from 'node:http2';

import { VWS_MAX_FRAME_BYTES } from '@signicode/verser-common';

/**
 * Options for {@link VerserWebSocket.send}.
 * @public
 */
export interface VerserWebSocketSendOptions {
  readonly type: 'text' | 'binary';
}

/**
 * Event map for the {@link VerserWebSocket} EventEmitter.
 * @public
 */
export interface VerserWebSocketEvents {
  message: (data: string | Buffer, options: VerserWebSocketSendOptions) => void;
  close: (code: number, reason: string) => void;
  error: (error: Error) => void;
}

/**
 * VWS/1 WebSocket-like object returned by `broker.webSocket()`
 * and passed to `guest.attachWebSocket()` handlers.
 *
 * @example
 * ```ts
 * ws.send('hello', { type: 'text' });
 * ws.send(Buffer.from([0x00, 0xff]), { type: 'binary' });
 * ws.on('message', (data, { type }) => ws.send(data, { type }));
 * ws.close(1000, 'normal');
 * ```
 *
 * @public
 */
export class VerserWebSocket extends EventEmitter {
  /** The negotiated VWS sub-protocol, if any. */
  public protocol = '';

  /** True after close frame has been sent via {@link close}. Prevents further sends. */
  private closeSent = false;

  /** True after the connection is fully closed (no more reading or writing). */
  private destroyed = false;

  /** True after the handshake accept frame has been sent. */
  private accepted = false;

  /**
   * Queue of pre-accept send promises, keyed by JSON string.
   * Flushed (resolved) in order after accept is sent.
   */
  private sendQueue: Array<{ json: string; resolve: () => void }> = [];

  /**
   * @param stream - The underlying HTTP/2 stream for VWS/1 frames.
   * @param protocol - The sub-protocol to use (from open frame or accept).
   * @param alreadyAccepted - Set to `true` when the VWS/1 handshake is
   *   already complete (Broker side). When `false` (Guest side), the
   *   instance starts in pre-accept mode and queues `send()` calls
   *   until {@link sendAccept} is called.
   */
  public constructor(
    private readonly stream: http2.ClientHttp2Stream | http2.ServerHttp2Stream,
    protocol = '',
    alreadyAccepted = false,
  ) {
    super();
    this.protocol = protocol;
    this.accepted = alreadyAccepted;

    // Default error handler prevents process crash when remote sends
    // malformed/oversized frames and no ws.on('error') listener is attached.
    // Registered error listeners are still notified normally via emit().
    this.on('error', () => {
      /* swallow unhandled protocol faults */
    });

    // Byte-counting VWS/1 NDJSON parser with bounded buffering.
    // Enforces VWS_MAX_FRAME_BYTES before appending data (unlike readline
    // which buffers unboundedly until newline).
    let lineBuffer = '';

    const processIncoming = (chunk: Buffer): void => {
      if (this.destroyed) return;

      const str = chunk.toString();
      const idx = str.indexOf('\n');

      if (idx < 0) {
        // No newline — accumulate with size check
        const nextBuf = lineBuffer + str;
        if (Buffer.byteLength(nextBuf, 'utf8') > VWS_MAX_FRAME_BYTES) {
          lineBuffer = '';
          this.handleProtocolFault(
            new Error(`VWS frame exceeds maximum size (${VWS_MAX_FRAME_BYTES} bytes)`),
            1009,
            'frame too large',
          );
          return;
        }
        lineBuffer = nextBuf;
        return;
      }

      // Newline found — extract and process the complete line
      const line = lineBuffer + str.slice(0, idx);
      lineBuffer = '';

      // Enforce size before processing (even when newline is in this chunk)
      if (Buffer.byteLength(line, 'utf8') > VWS_MAX_FRAME_BYTES) {
        this.handleProtocolFault(
          new Error(`VWS frame exceeds maximum size (${VWS_MAX_FRAME_BYTES} bytes)`),
          1009,
          'frame too large',
        );
        // Still need to process remaining bytes after the oversized line
        const afterNewline = str.slice(idx + 1);
        if (afterNewline.length > 0) {
          setImmediate(() => processIncoming(Buffer.from(afterNewline)));
        }
        return;
      }

      // Parse and handle the frame
      try {
        const frame: Record<string, unknown> = JSON.parse(line);
        this.handleFrame(frame);
      } catch (err) {
        this.handleProtocolFault(
          err instanceof Error ? err : new Error(String(err)),
          1002,
          'protocol error',
        );
        // Still process remaining bytes after malformed line
        const afterNewline = str.slice(idx + 1);
        if (afterNewline.length > 0) {
          setImmediate(() => processIncoming(Buffer.from(afterNewline)));
        }
        return;
      }

      // Process remaining bytes after the newline (may contain more frames)
      const remaining = str.slice(idx + 1);
      if (remaining.length > 0) {
        setImmediate(() => processIncoming(Buffer.from(remaining)));
      }
    };

    (this.stream as NodeJS.ReadableStream).on('data', processIncoming);
    (this.stream as NodeJS.ReadableStream).on('end', () => {
      if (!this.destroyed && lineBuffer.length > 0) {
        // Silently drop incomplete trailing data (no newline at end)
        lineBuffer = '';
      }
      if (!this.destroyed) {
        this.destroyed = true;
        // Drain pre-accept queue on premature end
        if (!this.accepted) {
          this.drainSendQueue(false);
        }
        this.emit('close', 1006, '');
      }
    });
    stream.on('error', (err: Error) => {
      if (!this.destroyed) {
        this.emit('error', err);
      }
    });
  }

  /**
   * Handles a protocol fault (invalid JSON, oversized frame) by emitting
   * an error event and sending a close frame. Does NOT throw, even when
   * no 'error' listener is registered (the default no-op listener in the
   * constructor prevents the EventEmitter throw behavior).
   */
  private handleProtocolFault(error: Error, closeCode: number, closeReason: string): void {
    (error as Error & { closeCode?: number }).closeCode = closeCode;
    this.emit('error', error);
    this.close(closeCode, closeReason);
  }

  /**
   * Sends a text or binary message over the VWS/1 connection.
   *
   * Returns a promise that resolves when the data has been written
   * (or queued by the runtime). When the underlying stream's
   * `write()` returns `false`, the promise waits for `drain` before
   * resolving, providing backpressure.
   *
   * @param data - The payload (string for text, Buffer or string for binary).
   * @param options - Must include `type`: `'text'` or `'binary'`.
   * @returns A promise that resolves when the write is accepted.
   */
  public send(data: string | Buffer, options: VerserWebSocketSendOptions): Promise<void> {
    if (this.closeSent || this.destroyed) {
      return Promise.resolve();
    }

    // Serialize: binary payloads must be base64-encoded inside the JSON
    const json =
      options.type === 'binary'
        ? JSON.stringify({
            type: 'binary',
            data: (Buffer.isBuffer(data) ? data : Buffer.from(data as string)).toString('base64'),
          })
        : JSON.stringify({ type: 'text', data: String(data) });
    if (Buffer.byteLength(json, 'utf8') + 1 > VWS_MAX_FRAME_BYTES) {
      const err = Object.assign(
        new Error(`VWS message exceeds maximum size (${VWS_MAX_FRAME_BYTES} bytes)`),
        { closeCode: 1009 },
      );
      this.emit('error', err);
      this.close(1009, 'message too large');
      return Promise.resolve();
    }

    // Queue pre-accept sends; flush after accept to ensure the accept
    // frame arrives before any data frames on the wire.
    if (!this.accepted) {
      return new Promise<void>((resolve) => {
        this.sendQueue.push({ json, resolve });
      });
    }

    return this.writeLine(json);
  }

  /**
   * Sends a VWS/1 close frame.  The connection stays readable until the
   * peer responds with its own close frame, at which point the 'close'
   * event fires with the peer's code and reason.
   *
   * @param code - WebSocket close code (default 1000).
   * @param reason - Optional close reason string.
   */
  public close(code = 1000, reason = ''): void {
    if (this.closeSent || this.destroyed) {
      return;
    }
    this.closeSent = true;
    // Discard any pre-accept queued sends — data frames must not arrive
    // after close and should not appear before accept.
    if (!this.accepted) {
      this.drainSendQueue(false);
    }
    void this.writeLine(JSON.stringify({ type: 'close', code, reason }));
    // Do NOT end the stream — the peer's close response is still expected.
    // The handleFrame 'close' case will end the stream when the echo arrives.
  }

  /**
   * Sends a VWS/1 accept frame to complete the handshake.
   *
   * Marks the WebSocket as no longer pending. After this call, data
   * frames may be sent and received.
   *
   * Called internally by the Guest when handling an open frame.
   *
   * @internal
   */
  public sendAccept(protocol?: string): void {
    if (this.destroyed) {
      // Discard pre-accept queue on rejection/teardown
      this.drainSendQueue(false);
      return;
    }
    this.protocol = protocol ?? this.protocol;
    this.accepted = true;
    // Write accept frame first
    void this.writeLine(JSON.stringify({ type: 'accept', protocol: this.protocol })).then(() => {
      // Flush queued pre-accept sends in order
      this.drainSendQueue(true);
    });
  }

  /**
   * Drains the pre-accept send queue. When `flush` is true, each queued
   * message is written to the stream in FIFO order. When false, the queue
   * is discarded (e.g. on rejection).
   */
  private drainSendQueue(flush: boolean): void {
    const queue = this.sendQueue;
    this.sendQueue = [];
    if (flush) {
      for (const entry of queue) {
        void this.writeLine(entry.json).then(entry.resolve, entry.resolve);
      }
    } else {
      for (const entry of queue) {
        entry.resolve();
      }
    }
  }

  /**
   * Writes a JSON line (with trailing `\n`) to the underlying stream,
   * observing backpressure.
   *
   * @param json - The JSON string (without trailing newline).
   * @returns A promise that resolves when the write is accepted.
   */
  private writeLine(json: string): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const stream = this.stream as NodeJS.WritableStream;
        const canContinue = stream.write(`${json}\n`);
        if (canContinue) {
          resolve();
        } else {
          stream.once('drain', () => resolve());
        }
      } catch {
        resolve();
      }
    });
  }

  /**
   * Ends the underlying stream when not already ended.
   */
  private endStream(): void {
    const s = this.stream as { writableEnded?: boolean; end(): void };
    if (s.writableEnded !== true) {
      try {
        s.end();
      } catch {
        // Already ended or destroyed
      }
    }
  }

  /**
   * Processes an incoming VWS/1 frame and emits the appropriate event.
   */
  private handleFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'text': {
        this.emit('message', String(frame.data ?? ''), { type: 'text' as const });
        break;
      }
      case 'binary': {
        const raw = String(frame.data ?? '');
        this.emit('message', Buffer.from(raw, 'base64'), { type: 'binary' as const });
        break;
      }
      case 'close': {
        this.destroyed = true;
        const code = Number(frame.code ?? 1000);
        const reason = String(frame.reason ?? '');
        this.emit('close', code, reason);
        // Echo the close frame back if we haven't already sent one
        if (!this.closeSent) {
          void this.writeLine(JSON.stringify({ type: 'close', code, reason }));
        }
        this.endStream();
        break;
      }
      case 'error': {
        this.emit('error', new Error(String(frame.message ?? 'VWS/1 protocol error')));
        break;
      }
      default:
        // Ignore unknown frames (open/accept already consumed by handshake)
        break;
    }
  }
}

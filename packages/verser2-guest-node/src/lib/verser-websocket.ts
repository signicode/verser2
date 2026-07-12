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
import { StringDecoder } from 'node:string_decoder';

import { VWS_MAX_FRAME_BYTES, decodeVwsFrame } from '@signicode/verser-common';

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
  pong: (data: string) => void;
}

const MAX_INBOUND_MESSAGES = 64;
const MAX_INBOUND_BYTES = VWS_MAX_FRAME_BYTES;
const MAX_PRE_ACCEPT_MESSAGES = 64;
const MAX_PRE_ACCEPT_BYTES = VWS_MAX_FRAME_BYTES;
const VWS_CLOSE_TIMEOUT_MS = 1_000;

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
  private sendQueue: Array<{
    json: string;
    bytes: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private sendQueueBytes = 0;
  private inboundQueue: Array<{
    data: string | Buffer;
    options: VerserWebSocketSendOptions;
    bytes: number;
  }> = [];
  private inboundQueueBytes = 0;
  private processingInbound = false;
  private closeTimer?: NodeJS.Timeout;

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
    const decoder = new StringDecoder('utf8');

    const processIncoming = (chunk: Buffer): void => {
      if (this.destroyed) return;

      lineBuffer += decoder.write(chunk);
      while (!this.destroyed) {
        const idx = lineBuffer.indexOf('\n');
        if (idx < 0) {
          if (Buffer.byteLength(lineBuffer, 'utf8') > VWS_MAX_FRAME_BYTES) {
            lineBuffer = '';
            this.handleProtocolFault(
              new Error(`VWS frame exceeds maximum size (${VWS_MAX_FRAME_BYTES} bytes)`),
              1009,
              'frame too large',
            );
          }
          return;
        }
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        if (Buffer.byteLength(line, 'utf8') > VWS_MAX_FRAME_BYTES) {
          this.handleProtocolFault(
            new Error(`VWS frame exceeds maximum size (${VWS_MAX_FRAME_BYTES} bytes)`),
            1009,
            'frame too large',
          );
          return;
        }
        try {
          this.handleFrame(decodeVwsFrame(line) as unknown as Record<string, unknown>);
        } catch (err) {
          this.handleProtocolFault(
            err instanceof Error ? err : new Error(String(err)),
            1002,
            'protocol error',
          );
          return;
        }
      }
    };

    (this.stream as NodeJS.ReadableStream).on('data', processIncoming);
    (this.stream as NodeJS.ReadableStream).on('end', () => {
      if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
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
    (this.stream as NodeJS.ReadableStream).on('close', () => {
      if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
      if (!this.destroyed) {
        this.destroyed = true;
        if (!this.accepted) this.drainSendQueue(false);
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
      const bytes = Buffer.byteLength(json, 'utf8') + 1;
      if (
        this.sendQueue.length >= MAX_PRE_ACCEPT_MESSAGES ||
        this.sendQueueBytes + bytes > MAX_PRE_ACCEPT_BYTES
      ) {
        const error = new Error('VWS pre-accept send queue exceeded');
        this.handleProtocolFault(error, 1009, 'message queue too large');
        return Promise.reject(error);
      }
      return new Promise<void>((resolve, reject) => {
        this.sendQueue.push({ json, bytes, resolve, reject });
        this.sendQueueBytes += bytes;
      });
    }

    return this.writeLine(json);
  }

  /** Sends a VWS ping. The peer automatically responds with a pong. */
  public ping(data = ''): Promise<void> {
    if (this.closeSent || this.destroyed) return Promise.resolve();
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') + 40 > VWS_MAX_FRAME_BYTES) {
      const error = new Error('VWS ping exceeds maximum size');
      this.handleProtocolFault(error, 1009, 'message too large');
      return Promise.reject(error);
    }
    return this.writeLine(JSON.stringify({ type: 'ping', data: String(data) }));
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
    validateClose(code, reason);
    this.closeSent = true;
    // Discard any pre-accept queued sends — data frames must not arrive
    // after close and should not appear before accept.
    if (!this.accepted) {
      this.drainSendQueue(false);
    }
    void this.writeLine(JSON.stringify({ type: 'close', code, reason })).catch(() => undefined);
    this.closeTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.endStream();
      const stream = this.stream as unknown as { destroy?: (error?: Error) => void };
      stream.destroy?.(new Error('VWS close handshake timed out'));
      this.emit('close', 1006, 'close handshake timeout');
    }, VWS_CLOSE_TIMEOUT_MS);
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
    void this.writeLine(JSON.stringify({ type: 'accept', protocol: this.protocol }))
      .then(() => {
        // Flush queued pre-accept sends in order
        this.drainSendQueue(true);
      })
      .catch(() => undefined);
  }

  /**
   * Drains the pre-accept send queue. When `flush` is true, each queued
   * message is written to the stream in FIFO order. When false, the queue
   * is discarded (e.g. on rejection).
   */
  private drainSendQueue(flush: boolean): void {
    const queue = this.sendQueue;
    this.sendQueue = [];
    this.sendQueueBytes = 0;
    if (flush) {
      const flushNext = async (index: number): Promise<void> => {
        if (index >= queue.length) return;
        const entry = queue[index];
        try {
          await this.writeLine(entry.json);
          entry.resolve();
          await flushNext(index + 1);
        } catch (error) {
          entry.reject(error instanceof Error ? error : new Error(String(error)));
          for (const pending of queue.slice(index + 1))
            pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      void flushNext(0);
    } else {
      for (const entry of queue) entry.reject(new Error('WebSocket closed before accept'));
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
    return new Promise<void>((resolve, reject) => {
      const stream = this.stream as unknown as {
        write: (chunk: string) => boolean;
        once: (event: string, listener: (...args: never[]) => void) => void;
        off?: (event: string, listener: (...args: never[]) => void) => void;
      };
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        stream.off?.('drain', onDrain);
        stream.off?.('error', onError);
        stream.off?.('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onDrain = (): void => settle();
      const onError = (error: Error): void => settle(error);
      const onClose = (): void => settle(new Error('VWS stream closed while writing'));
      try {
        stream.once('error', onError);
        stream.once('close', onClose);
        const canContinue = stream.write(`${json}\n`);
        if (canContinue) {
          settle();
        } else {
          stream.once('drain', onDrain);
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
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
        if (typeof frame.data !== 'string') {
          this.handleProtocolFault(new Error('Invalid VWS text frame'), 1002, 'protocol error');
          return;
        }
        this.enqueueInbound(frame.data, { type: 'text' }, Buffer.byteLength(frame.data, 'utf8'));
        break;
      }
      case 'binary': {
        if (
          typeof frame.data !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
        ) {
          this.handleProtocolFault(new Error('Invalid VWS binary frame'), 1002, 'protocol error');
          return;
        }
        const data = Buffer.from(frame.data, 'base64');
        this.enqueueInbound(data, { type: 'binary' }, data.byteLength);
        break;
      }
      case 'ping': {
        if (frame.data !== undefined && typeof frame.data !== 'string') {
          this.handleProtocolFault(new Error('Invalid VWS ping frame'), 1002, 'protocol error');
          return;
        }
        void this.writeLine(JSON.stringify({ type: 'pong', data: frame.data ?? '' })).catch(
          () => undefined,
        );
        break;
      }
      case 'pong': {
        if (frame.data !== undefined && typeof frame.data !== 'string') {
          this.handleProtocolFault(new Error('Invalid VWS pong frame'), 1002, 'protocol error');
          return;
        }
        this.emit('pong', frame.data ?? '');
        break;
      }
      case 'close': {
        if (
          typeof frame.code !== 'number' ||
          !Number.isInteger(frame.code) ||
          (typeof frame.reason !== 'string' && frame.reason !== undefined)
        ) {
          this.handleProtocolFault(new Error('Invalid VWS close frame'), 1002, 'protocol error');
          return;
        }
        const code = frame.code;
        const reason = frame.reason ?? '';
        try {
          validateClose(code, reason);
        } catch (error) {
          this.handleProtocolFault(
            error instanceof Error ? error : new Error(String(error)),
            1002,
            'protocol error',
          );
          return;
        }
        this.destroyed = true;
        if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
        this.emit('close', code, reason);
        // Echo the close frame back if we haven't already sent one
        if (!this.closeSent) {
          void this.writeLine(JSON.stringify({ type: 'close', code, reason })).catch(
            () => undefined,
          );
        }
        this.endStream();
        break;
      }
      case 'error': {
        if (typeof frame.message !== 'string') {
          this.handleProtocolFault(new Error('Invalid VWS error frame'), 1002, 'protocol error');
          return;
        }
        this.emit('error', new Error(frame.message));
        break;
      }
      case 'open':
      case 'accept':
        this.handleProtocolFault(
          new Error(`Unexpected VWS ${String(frame.type)} frame`),
          1002,
          'protocol error',
        );
        break;
      default:
        this.handleProtocolFault(new Error('Unknown VWS frame type'), 1002, 'protocol error');
    }
  }

  private enqueueInbound(
    data: string | Buffer,
    options: VerserWebSocketSendOptions,
    bytes: number,
  ): void {
    if (
      bytes > MAX_INBOUND_BYTES ||
      this.inboundQueue.length >= MAX_INBOUND_MESSAGES ||
      this.inboundQueueBytes + bytes > MAX_INBOUND_BYTES
    ) {
      this.handleProtocolFault(
        new Error('VWS inbound message queue exceeded'),
        1009,
        'message too large',
      );
      return;
    }
    this.inboundQueue.push({ data, options, bytes });
    this.inboundQueueBytes += bytes;
    (this.stream as { pause?: () => void }).pause?.();
    void this.processInboundQueue();
  }

  private async processInboundQueue(): Promise<void> {
    if (this.processingInbound) return;
    this.processingInbound = true;
    try {
      while (!this.destroyed && this.inboundQueue.length > 0) {
        const entry = this.inboundQueue.shift() as {
          data: string | Buffer;
          options: VerserWebSocketSendOptions;
          bytes: number;
        };
        this.inboundQueueBytes -= entry.bytes;
        const listeners = this.listeners('message');
        for (const listener of listeners) {
          const result = listener.call(this, entry.data, entry.options);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') await result;
        }
      }
    } catch (error) {
      this.handleProtocolFault(
        error instanceof Error ? error : new Error(String(error)),
        1011,
        'message handler failure',
      );
    } finally {
      this.processingInbound = false;
      if (!this.destroyed && this.inboundQueue.length === 0) {
        (this.stream as { resume?: () => void }).resume?.();
      }
    }
  }
}

function validateClose(code: number, reason: string): void {
  if (
    !Number.isInteger(code) ||
    !(
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999)
    )
  ) {
    throw new RangeError(`Invalid WebSocket close code: ${code}`);
  }
  if (Buffer.byteLength(reason, 'utf8') > 123) {
    throw new RangeError('WebSocket close reason exceeds 123 UTF-8 bytes');
  }
}

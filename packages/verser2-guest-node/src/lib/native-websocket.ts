import type { VerserWebSocket } from './verser-websocket';

export type NativeWebSocketBinaryType = 'nodebuffer' | 'arraybuffer';

export interface NativeWebSocketMessageEvent {
  readonly type: 'message';
  readonly data: string | Buffer | ArrayBuffer;
  readonly target: NativeVerserWebSocket;
}

export interface NativeWebSocketEvent {
  readonly type: 'open' | 'close' | 'error';
  readonly target: NativeVerserWebSocket;
  readonly code?: number;
  readonly reason?: string;
  readonly error?: Error;
}

export type NativeWebSocketListener =
  | ((event: NativeWebSocketMessageEvent) => void | Promise<void>)
  | ((event: NativeWebSocketEvent) => void | Promise<void>);

/** Native-facing EventTarget adapter over the legacy VWS EventEmitter object. */
export class NativeVerserWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readonly CONNECTING = NativeVerserWebSocket.CONNECTING;
  public readonly OPEN = NativeVerserWebSocket.OPEN;
  public readonly CLOSING = NativeVerserWebSocket.CLOSING;
  public readonly CLOSED = NativeVerserWebSocket.CLOSED;

  public readyState: 0 | 1 | 2 | 3;
  public binaryType: NativeWebSocketBinaryType = 'nodebuffer';
  public readonly protocol: string;
  public onopen: ((event: NativeWebSocketEvent) => void) | null = null;
  public onmessage: ((event: NativeWebSocketMessageEvent) => void) | null = null;
  public onclose: ((event: NativeWebSocketEvent) => void) | null = null;
  public onerror: ((event: NativeWebSocketEvent) => void) | null = null;

  private readonly listeners = new Map<string, Set<NativeWebSocketListener>>();
  private closed = false;

  public constructor(
    private readonly legacy: VerserWebSocket,
    initiallyOpen = true,
  ) {
    this.protocol = legacy.protocol;
    this.readyState = initiallyOpen ? this.OPEN : this.CONNECTING;
    void this.markOpen;
    legacy.on('message', (data, options) => {
      const converted =
        options.type === 'binary' ? this.convertBinary(data as Buffer) : String(data);
      this.dispatch({ type: 'message', data: converted, target: this });
    });
    legacy.on('close', (code, reason) => {
      this.closed = true;
      this.readyState = this.CLOSED;
      this.dispatch({ type: 'close', code, reason, target: this });
    });
    legacy.on('error', (error) => {
      this.dispatch({ type: 'error', error, target: this });
    });
  }

  public addEventListener(type: string, listener: NativeWebSocketListener): void {
    const entries = this.listeners.get(type) ?? new Set<NativeWebSocketListener>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  public removeEventListener(type: string, listener: NativeWebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string | Buffer | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== this.OPEN) {
      throw new Error('WebSocket is not open');
    }
    const binary = { type: typeof data === 'string' ? ('text' as const) : ('binary' as const) };
    const payload =
      typeof data === 'string' || Buffer.isBuffer(data)
        ? data
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    void this.legacy.send(payload, binary).catch((error: unknown) => {
      this.dispatch({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        target: this,
      });
      this.close(1011, 'send failed');
    });
  }

  public close(code = 1000, reason = ''): void {
    if (this.closed || this.readyState === this.CLOSING) return;
    this.readyState = this.CLOSING;
    this.legacy.close(code, reason);
  }

  public ping(data = ''): Promise<void> {
    return this.legacy.ping(data);
  }

  public pong(data = ''): Promise<void> {
    return this.legacy.pong(data);
  }

  public terminate(): void {
    this.legacy.terminate();
  }

  public getBufferedAmount(): number {
    return this.legacy.getBufferedAmount();
  }

  public get bufferedAmount(): number {
    return this.getBufferedAmount();
  }

  /** Completes a server-side adapter open after the Guest accepts the VWS lease. */
  private markOpen(): void {
    if (this.readyState !== this.CONNECTING) return;
    this.readyState = this.OPEN;
    this.dispatch({ type: 'open', target: this });
  }

  private convertBinary(data: Buffer): Buffer | ArrayBuffer {
    if (this.binaryType === 'nodebuffer') return data;
    return new Uint8Array(data).slice().buffer;
  }

  private dispatch(event: NativeWebSocketMessageEvent | NativeWebSocketEvent): void {
    const entries = this.listeners.get(event.type);
    if (entries !== undefined) {
      for (const listener of [...entries]) {
        try {
          const result = listener(event as never);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(result).catch((error: unknown) =>
              this.handleCallbackError(event.type, error),
            );
          }
        } catch (error) {
          this.handleCallbackError(event.type, error);
        }
      }
    }
    try {
      if (event.type === 'message') this.onmessage?.(event);
      if (event.type === 'open') this.onopen?.(event);
      if (event.type === 'close') this.onclose?.(event);
      if (event.type === 'error') this.onerror?.(event);
    } catch (error) {
      this.handleCallbackError(event.type, error);
    }
  }

  private handleCallbackError(type: string, error: unknown): void {
    if (type === 'error') return;
    const callbackError = error instanceof Error ? error : new Error(String(error));
    this.dispatch({ type: 'error', error: callbackError, target: this });
    this.close(1011, 'WebSocket callback failed');
  }
}

/** Internal Guest adapter hook, deliberately omitted from the package barrel. */
export function markNativeVerserWebSocketOpen(ws: NativeVerserWebSocket): void {
  (ws as unknown as { markOpen(): void }).markOpen();
}

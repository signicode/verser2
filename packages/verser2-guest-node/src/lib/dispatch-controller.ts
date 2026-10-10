import type * as http from 'node:http';
import type { Readable } from 'node:stream';
import type { Dispatcher } from 'undici';

export class VerserDispatchController {
  private terminalState: 'active' | 'failed' | 'completed' = 'active';
  private readonly abortController = new AbortController();
  public rawHeaders?: Buffer[] | string[] | http.IncomingHttpHeaders | null;

  public rawTrailers?: Buffer[] | string[] | http.IncomingHttpHeaders | null;

  private responseBody?: Readable;

  private requestBody?: Readable;

  private pausedState = false;

  private abortReason: Error | null = null;

  private failureNotified = false;

  private totalBytesSent = 0;

  private readonly cleanupCallbacks = new Set<() => void>();

  public constructor(private readonly handler: Dispatcher.DispatchHandler) {}

  public get aborted(): boolean {
    return this.terminalState === 'failed';
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public get paused(): boolean {
    return this.pausedState;
  }

  public get reason(): Error | null {
    return this.abortReason;
  }

  public attachResponseBody(body: Readable): void {
    this.responseBody = body;
    if (this.pausedState) {
      body.pause();
    }
  }

  /** Track the request body stream so it can be destroyed when the controller is aborted. */
  public attachRequestBody(body: Readable): void {
    if (this.terminalState !== 'active') return;
    this.requestBody = body;
    const onError = (error: Error): void => {
      if (this.terminalState === 'active') this.abort(error);
    };
    const onClose = (): void => {
      body.off('error', onError);
      body.off('close', onClose);
    };
    body.on('error', onError);
    body.once('close', onClose);
  }

  public onTerminal(cleanup: () => void): () => void {
    if (this.terminalState !== 'active') {
      cleanup();
      return () => {};
    }
    this.cleanupCallbacks.add(cleanup);
    return () => this.cleanupCallbacks.delete(cleanup);
  }

  public complete(): void {
    if (this.terminalState !== 'active') return;
    this.terminalState = 'completed';
    this.cleanup();
  }

  public abort(reason: Error): void {
    if (this.terminalState !== 'active') return;
    this.terminalState = 'failed';
    this.abortReason = reason;
    this.abortController.abort(reason);
    this.cleanup();
    // Destroy the request body to stop sending data upstream when abort fires
    // mid-upload. Destroy the response body to stop consuming downstream data.
    this.requestBody?.destroy(reason);
    this.responseBody?.destroy();
    this.notifyFailure(reason);
  }

  public pause(): void {
    this.pausedState = true;
    this.responseBody?.pause();
  }

  public resume(): void {
    this.pausedState = false;
    this.responseBody?.resume();
  }

  public fail(error: Error): void {
    this.abort(error);
  }

  private notifyFailure(error: Error): void {
    if (this.failureNotified) return;
    this.failureNotified = true;
    if (this.handler.onResponseError !== undefined) {
      this.handler.onResponseError(this, error);
      return;
    }
    this.handler.onError?.(error);
  }

  private cleanup(): void {
    for (const cleanup of this.cleanupCallbacks) {
      try {
        cleanup();
      } catch {
        // Cleanup must not interfere with the one terminal notification.
      }
    }
    this.cleanupCallbacks.clear();
  }

  public failFromUnknown(error: unknown): void {
    this.abort(error instanceof Error ? error : new Error(String(error)));
  }

  public invoke(callback: () => void): boolean {
    try {
      callback();
      return true;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.abort(failure);
      return false;
    }
  }

  public emitBodySent(chunk: Buffer): void {
    if (this.terminalState !== 'active') return;
    this.totalBytesSent += chunk.byteLength;
    try {
      this.handler.onBodySent?.(chunk.byteLength, this.totalBytesSent);
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public emitRequestSent(): void {
    // Undici 7 has no request-sent callback; body progress is reported through onBodySent.
  }
}

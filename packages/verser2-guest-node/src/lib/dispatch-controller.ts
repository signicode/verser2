import type * as http from 'node:http';
import type { Readable } from 'node:stream';
import type { Dispatcher } from 'undici';

export class VerserDispatchController {
  public rawHeaders?: Buffer[] | string[] | http.IncomingHttpHeaders | null;

  public rawTrailers?: Buffer[] | string[] | http.IncomingHttpHeaders | null;

  private responseBody?: Readable;

  private abortedState = false;

  private pausedState = false;

  private abortReason: Error | null = null;

  private errorEmitted = false;

  private totalBytesSent = 0;

  public constructor(private readonly handler: Dispatcher.DispatchHandler) {}

  public get aborted(): boolean {
    return this.abortedState;
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

  public abort(reason: Error): void {
    if (this.abortedState) {
      return;
    }
    this.abortedState = true;
    this.abortReason = reason;
    this.responseBody?.destroy(reason);
    this.fail(reason);
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
    if (this.errorEmitted) {
      return;
    }
    this.errorEmitted = true;
    this.handler.onResponseError?.(this, error);
  }

  public emitBodySent(chunk: Buffer): void {
    this.totalBytesSent += chunk.byteLength;
    this.handler.onBodySent?.(chunk);
  }

  public emitRequestSent(): void {
    this.handler.onRequestSent?.();
  }
}

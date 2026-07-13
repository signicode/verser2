import type * as http from 'node:http';
import type { Readable } from 'node:stream';
import type { Dispatcher } from 'undici';

export class VerserDispatchController {
  public rawHeaders?: Buffer[] | string[] | http.IncomingHttpHeaders | null;

  public rawTrailers?: Buffer[] | string[] | http.IncomingHttpHeaders | null;

  private responseBody?: Readable;

  private requestBody?: Readable;

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

  /** Track the request body stream so it can be destroyed when the controller is aborted. */
  public attachRequestBody(body: Readable): void {
    this.requestBody = body;
  }

  public abort(reason: Error): void {
    if (this.abortedState) {
      return;
    }
    this.abortedState = true;
    this.abortReason = reason;
    // Destroy the request body to stop sending data upstream when abort fires
    // mid-upload. Destroy the response body to stop consuming downstream data.
    this.requestBody?.destroy(reason);
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
    if (this.handler.onResponseError !== undefined) {
      this.handler.onResponseError(this, error);
      return;
    }
    this.handler.onError?.(error);
  }

  public failFromUnknown(error: unknown): void {
    this.fail(error instanceof Error ? error : new Error(String(error)));
  }

  public invoke(callback: () => void): boolean {
    try {
      callback();
      return true;
    } catch (error) {
      this.failFromUnknown(error);
      return false;
    }
  }

  public emitBodySent(chunk: Buffer): void {
    this.totalBytesSent += chunk.byteLength;
    this.handler.onBodySent?.(chunk.byteLength, this.totalBytesSent);
  }

  public emitRequestSent(): void {
    // Undici 7 has no request-sent callback; body progress is reported through onBodySent.
  }
}

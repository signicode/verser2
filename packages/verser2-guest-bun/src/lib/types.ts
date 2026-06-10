export interface VerserBunGuestOptions {
  readonly hostUrl: string;
  readonly guestId: string;
  readonly routedDomains?: readonly string[];
}

export interface VerserBunGuestLifecycleEvent {
  readonly name: string;
  readonly guestId: string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly error?: unknown;
}

export interface VerserBunGuest {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(reason?: string): Promise<void>;
  attach(serverOrListener: VerserBunGuestServerLike, domain?: string): this;
  onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void;
}

export type VerserBunGuestServerLike =
  | VerserBunGuestRequestHandler
  | {
      readonly server: unknown;
      readonly fetch?: VerserBunGuestRequestHandler;
    };

export interface VerserBunGuestRequestHandler {
  readonly origin: string;
  readonly fetch: (request: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface VerserBunGuestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

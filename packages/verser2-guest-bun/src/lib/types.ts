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

export type VerserBunDispatchMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'OPTIONS'
  | 'TRACE'
  | 'CONNECT';

export interface VerserBunDispatchRequest {
  readonly method: string;
  readonly path: string;
  readonly origin: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit | null;
}

export interface VerserBunDispatchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

export interface VerserBunDispatchServer {
  upgrade: (request: Request) => boolean;
}

export type VerserBunDispatchRouteMethodHandler = (
  request: Request,
) => Promise<Response> | Response;

export type VerserBunDispatchRouteHandlers = Partial<{
  [method in VerserBunDispatchMethod]: VerserBunDispatchRouteMethodHandler;
}>;

export type VerserBunDispatchRouteEntry =
  | Response
  | VerserBunDispatchRouteMethodHandler
  | VerserBunDispatchRouteHandlers;

export type VerserBunDispatchRoutes = Readonly<Record<string, VerserBunDispatchRouteEntry>>;

export interface VerserBunDispatchRequestHandler {
  readonly fetch?: (
    request: Request,
    server: VerserBunDispatchServer,
  ) => Promise<unknown> | unknown;
  readonly routes?: VerserBunDispatchRoutes;
}

export const DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE = 'Handler must return a Response instance.';

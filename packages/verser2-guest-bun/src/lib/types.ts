import type { VerserClientTlsOptions } from '@signicode/verser-common';
import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
} from '@signicode/verser2-guest-node';

export type { VerserBroker, VerserBrokerOptions, VerserBrokerRequest, VerserBrokerResponse };

export interface VerserBunGuestOptions {
  readonly hostUrl: string;
  readonly guestId: string;
  readonly routedDomains?: readonly string[];
  readonly minWaitingStreams?: number;
  readonly maxOpenStreams?: number;
  readonly leaseAcquireTimeoutMs?: number;
  readonly maxMetadataBytes?: number;
  readonly tls?: VerserClientTlsOptions;
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
  attach(handler: VerserBunGuestRequestHandler, domain?: string): this;
  onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void;
}

export interface VerserBunRequest extends Request {
  readonly params: Record<string, string>;
}

export type VerserBunRouteMethod =
  | 'ACL'
  | 'BIND'
  | 'CHECKOUT'
  | 'CONNECT'
  | 'COPY'
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'LINK'
  | 'LOCK'
  | 'M-SEARCH'
  | 'MERGE'
  | 'MKACTIVITY'
  | 'MKCOL'
  | 'MKREDIRECTREF'
  | 'MKWORKSPACE'
  | 'MOVE'
  | 'OPTIONS'
  | 'PATCH'
  | 'POST'
  | 'PROPFIND'
  | 'PROPPATCH'
  | 'PURGE'
  | 'PUT'
  | 'REBIND'
  | 'REPORT'
  | 'SEARCH'
  | 'TRACE'
  | 'UNBIND'
  | 'UNLINK'
  | 'UNLOCK';

export type VerserBunRouteHandler = (
  request: VerserBunRequest,
  server: VerserBunGuestServer,
) => Promise<Response> | Response;

export type VerserBunRouteValue = Response | VerserBunRouteHandler;

export type VerserBunRoutesPerMethod = {
  readonly [METHOD in VerserBunRouteMethod]?: VerserBunRouteValue;
};

export type VerserBunRoutes = {
  readonly [pathname: string]: VerserBunRouteValue | VerserBunRoutesPerMethod;
};

export interface VerserBunGuestRequestHandler {
  readonly fetch?: (
    request: VerserBunRequest,
    server: VerserBunGuestServer,
  ) => Promise<unknown> | unknown;
  readonly routes?: VerserBunRoutes;
}

export interface VerserBunGuestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

export interface VerserBunGuestServer {
  upgrade: (request: Request) => boolean;
}

export { DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE } from './constants';

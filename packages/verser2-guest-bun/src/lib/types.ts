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

export interface VerserBunGuestRequestHandler {
  readonly fetch: (request: Request, server: VerserBunGuestServer) => Promise<unknown> | unknown;
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

export const DISPATCH_BUN_NOT_A_RESPONSE_MESSAGE = 'Handler must return a Response instance.';

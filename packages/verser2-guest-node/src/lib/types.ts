import type * as http from 'node:http';
import type { Readable } from 'node:stream';
import type { Dispatcher, fetch as undiciFetch } from 'undici';

import type {
  RoutedDomainRegistration,
  RoutedRequestEnvelope,
  RoutedResponseEnvelope,
  VerserBrokerControlFrame,
  VerserError,
} from '@signicode/verser-common';

export interface VerserNodeGuestOptions {
  readonly hostUrl: string;
  readonly guestId: string;
  readonly routedDomains?: readonly string[];
  readonly minWaitingStreams?: number;
  readonly maxOpenStreams?: number;
  readonly leaseAcquireTimeoutMs?: number;
  readonly maxMetadataBytes?: number;
}

export interface VerserNodeGuestLifecycleEvent {
  readonly name: string;
  readonly guestId: string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly error?: VerserError;
}

export interface VerserNodeGuestDispatchRequest extends RoutedRequestEnvelope {
  readonly body: readonly (string | Buffer)[];
}

export interface VerserNodeGuestDispatchResponse extends RoutedResponseEnvelope {
  readonly body: Buffer;
}

export interface VerserBrokerOptions {
  readonly hostUrl: string;
  readonly brokerId: string;
  readonly leaseAcquireTimeoutMs?: number;
}

export interface VerserBrokerRequest {
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: readonly Buffer[] | Readable;
}

export interface VerserBrokerResponse extends RoutedResponseEnvelope {
  readonly body: Readable;
}

export interface VerserBroker {
  readonly sessionCount: number;
  readonly routedRequestCount: number;
  connect(): Promise<void>;
  close(reason?: string): Promise<void>;
  createAgent(): http.Agent;
  createDispatcher(): Dispatcher;
  createFetch(): typeof undiciFetch;
  getRoutes(): { targetId: string; domain: string }[];
  waitForRoute(domain: string): Promise<void>;
  request(request: VerserBrokerRequest): Promise<VerserBrokerResponse>;
}

export interface VerserNodeGuest {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(reason?: string): Promise<void>;
  attach(serverOrListener: import('node:http').Server | NodeRequestListener, domain?: string): this;
  dispatchRoutedRequest(
    request: VerserNodeGuestDispatchRequest,
  ): Promise<VerserNodeGuestDispatchResponse>;
  onLifecycle(listener: (event: VerserNodeGuestLifecycleEvent) => void): () => void;
}

export type NodeRequestListener = (
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
  },
  response: {
    statusCode: number;
    setHeader: (name: string, value: string | number | boolean) => unknown;
    getHeader: (name: string) => string | undefined;
    writeHead: (statusCode: number, headers?: Record<string, string | number | boolean>) => unknown;
    write: (chunk: string | Buffer, encoding?: BufferEncoding) => boolean;
    end: (chunk?: string | Buffer, encoding?: BufferEncoding) => unknown;
    once?: (eventName: string | symbol, listener: (...args: unknown[]) => void) => unknown;
  },
) => void;

export interface BrokerRequestRouter {
  request(request: VerserBrokerRequest): Promise<VerserBrokerResponse>;
  getRoutes(): { targetId: string; domain: string }[];
}

export type BrokerControlFrame = VerserBrokerControlFrame;

export type BrokerRoute = RoutedDomainRegistration;

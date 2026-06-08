import type { AddressInfo } from 'node:net';

import type { RoutedDomainRegistration, VerserError } from '@signicode/verser-common';

export type VerserPeerRole = 'broker' | 'guest';

export interface VerserHostOptions {
  readonly port?: number;
  readonly host?: string;
}

export interface VerserHostRegistrationRequest {
  readonly peerId: string;
  readonly role: VerserPeerRole;
  readonly routedDomains?: readonly string[];
}

export interface VerserHostLifecycleEvent {
  readonly name: string;
  readonly peerId?: string;
  readonly role?: VerserPeerRole;
  readonly reason?: string;
  readonly error?: VerserError;
}

export interface VerserHost {
  readonly running: boolean;
  readonly address: AddressInfo;
  start(): Promise<void>;
  close(reason?: string): Promise<void>;
  getRoutedDomains(): RoutedDomainRegistration[];
  onLifecycle(listener: (event: VerserHostLifecycleEvent) => void): () => void;
}

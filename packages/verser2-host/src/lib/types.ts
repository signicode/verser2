import type { AddressInfo } from 'node:net';

import type {
  VerserPeerRole as CommonVerserPeerRole,
  RoutedDomainRegistration,
  VerserError,
  VerserRegistrationRequest,
} from '@signicode/verser-common';

export interface VerserHostOptions {
  readonly port?: number;
  readonly host?: string;
}

export type VerserHostRegistrationRequest = VerserRegistrationRequest;

export interface VerserHostLifecycleEvent {
  readonly name: string;
  readonly peerId?: string;
  readonly role?: CommonVerserPeerRole;
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

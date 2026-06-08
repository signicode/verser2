export { VERSER2_GUEST_NODE_PACKAGE_NAME } from './lib/constants';
export { MinimalIncomingMessage, MinimalServerResponse } from './lib/minimal-http';

export type {
  NodeRequestListener,
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
  VerserNodeGuestDispatchRequest,
  VerserNodeGuestDispatchResponse,
  VerserNodeGuest,
  VerserNodeGuestLifecycleEvent,
  VerserNodeGuestOptions,
} from './lib/types';

import { Http2VerserBroker } from './lib/http2-verser-broker';
import { Http2VerserNodeGuest } from './lib/http2-verser-node-guest';
import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserNodeGuest,
  VerserNodeGuestOptions,
} from './lib/types';

export function createVerserNodeGuest(options: VerserNodeGuestOptions): VerserNodeGuest {
  return new Http2VerserNodeGuest(options);
}

export function createVerserBroker(options: VerserBrokerOptions): VerserBroker {
  return new Http2VerserBroker(options);
}

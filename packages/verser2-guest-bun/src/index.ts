export { VERSER2_GUEST_BUN_PACKAGE_NAME } from './lib/constants';

export type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBrokerRequest,
  VerserBrokerResponse,
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunRequest,
  VerserBunRoutes,
  VerserBunRouteMethod,
  VerserBunRouteHandler,
  VerserBunRouteValue,
  VerserBunRoutesPerMethod,
  VerserBunGuestRequestHandler,
} from './lib/types';

import type {
  VerserBroker,
  VerserBrokerOptions,
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestRequestHandler,
} from './lib/types';

import {
  type VerserNodeGuest,
  createVerserBroker as createVerserNodeBroker,
  createVerserNodeGuest,
} from '@signicode/verser2-guest-node';
import { createNodeStyleHandler } from './lib/adapter';

export function createVerserBunGuest(options: VerserBunGuestOptions): VerserBunGuest {
  const nodeGuest: VerserNodeGuest = createVerserNodeGuest(options);

  const guest: VerserBunGuest = {
    get connected(): boolean {
      return nodeGuest.connected;
    },

    attach(handler: VerserBunGuestRequestHandler, domain?: string): VerserBunGuest {
      const domainName = domain ?? options.guestId;
      const nodeHandler = createNodeStyleHandler(domainName, handler);
      nodeGuest.attach(nodeHandler, domainName);
      return guest;
    },

    async connect(): Promise<void> {
      await nodeGuest.connect();
    },

    async close(reason?: string): Promise<void> {
      await nodeGuest.close(reason);
    },

    onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void {
      return nodeGuest.onLifecycle((event) => {
        listener(event);
      });
    },
  };

  return guest;
}

export function createVerserBroker(options: VerserBrokerOptions): VerserBroker {
  return createVerserNodeBroker(options);
}

export { VERSER2_GUEST_BUN_PACKAGE_NAME } from './lib/constants';

export type {
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestServerLike,
  VerserBunGuestRequestHandler,
} from './lib/types';

import type {
  VerserBunGuest,
  VerserBunGuestLifecycleEvent,
  VerserBunGuestOptions,
  VerserBunGuestServerLike,
} from './lib/types';

export function createVerserBunGuest(_options: VerserBunGuestOptions): VerserBunGuest {
  let connected = false;
  const lifecycleListeners: Array<(event: VerserBunGuestLifecycleEvent) => void> = [];

  const notifyLifecycle = (name: string, reason?: string): void => {
    const event = { name, guestId: _options.guestId, reason };
    for (const listener of lifecycleListeners) {
      listener(event);
    }
  };

  const guest: VerserBunGuest = {
    get connected() {
      return connected;
    },

    async connect(): Promise<void> {
      connected = true;
      notifyLifecycle('connected');
    },

    async close(reason?: string): Promise<void> {
      connected = false;
      notifyLifecycle('closed', reason);
    },

    attach(_serverOrListener: VerserBunGuestServerLike, _domain?: string): VerserBunGuest {
      return guest;
    },

    onLifecycle(listener: (event: VerserBunGuestLifecycleEvent) => void): () => void {
      lifecycleListeners.push(listener);
      return () => {
        const index = lifecycleListeners.indexOf(listener);
        if (index >= 0) {
          lifecycleListeners.splice(index, 1);
        }
      };
    },
  };

  return guest;
}

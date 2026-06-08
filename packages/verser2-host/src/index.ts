export { VERSER2_HOST_PACKAGE_NAME } from './lib/constants';

import { NodeHttp2VerserHost } from './lib/node-http2-verser-host';
import type { VerserHost, VerserHostOptions } from './lib/types';

export type {
  VerserHost,
  VerserHostLifecycleEvent,
  VerserHostOptions,
  VerserHostRegistrationRequest,
} from './lib/types';

export type { VerserPeerRole } from '@signicode/verser-common';

export function createVerserHost(options: VerserHostOptions = {}): VerserHost {
  return new NodeHttp2VerserHost(options);
}

export const VERSER2_GUEST_JS_COMMON_PACKAGE_NAME = '@signicode/verser2-guest-js-common';

export type {
  VerserRoute,
  VerserCommonBrokerRequest,
  VerserCommonBrokerResponse,
  VerserCommonBroker,
  VerserHeaderValue,
  VerserHeaderInput,
  VerserStreamChunkSource,
} from './lib/types';

export {
  AbstractVerserFetchDispatcher,
  flattenHeaderValue,
  normalizeHeaders,
  resolveRouteForHostname,
  resolveRouteForUrl,
  appendQueryString,
  createCommonBrokerRequest,
} from './lib';

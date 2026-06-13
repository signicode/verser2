/**
 * The package name for
 * {@link https://www.npmjs.com/package/@signicode/verser2-guest-js-common | `@signicode/verser2-guest-js-common`}.
 *
 * @public
 */
export const VERSER2_GUEST_JS_COMMON_PACKAGE_NAME = '@signicode/verser2-guest-js-common';

/**
 * Re-exports common types used across adapter Guest implementations.
 *
 * @public
 */
export type {
  /** A route record associating a target identity with a domain. */
  VerserRoute,
  /** Request shape accepted by a Broker for forwarding to a target. */
  VerserCommonBrokerRequest,
  /** Response shape returned by a Broker after forwarding. */
  VerserCommonBrokerResponse,
  /** Common Broker interface exposing `request()` and `getRoutes()`. */
  VerserCommonBroker,
  /** A single header value (string or string array). */
  VerserHeaderValue,
  /** Input types accepted for header values. */
  VerserHeaderInput,
  /** An async-iterable source of stream chunks. */
  VerserStreamChunkSource,
} from './lib/types';

/**
 * Re-exports runtime helpers shared across adapter Guest implementations.
 *
 * @public
 */
export {
  AbstractVerserFetchDispatcher,
  flattenHeaderValue,
  normalizeHeaders,
  resolveRouteForHostname,
  resolveRouteForUrl,
  appendQueryString,
  createCommonBrokerRequest,
} from './lib';

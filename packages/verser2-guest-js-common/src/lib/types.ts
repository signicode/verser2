import type { RoutedDomainRegistration } from '@signicode/verser-common';

export type {
  VerserCommonBroker,
  VerserCommonBrokerRequest,
  VerserCommonBrokerResponse,
  VerserHeaderInput,
  VerserHeaderValue,
} from '@signicode/verser-common';

/**
 * An advertised route binding a target identity (Guest) to a domain.
 *
 * Route matching is exact URL hostname equality; wildcard or suffix matching
 * is not supported. The Host sends route-control frames to Brokers, and
 * retraction is represented by an empty route list.
 *
 * @public
 */
export type VerserRoute = RoutedDomainRegistration;

/**
 * Minimal route descriptor used internally by adapter implementations.
 *
 * @internal
 */
export interface AbstractRoute {
  readonly targetId: string;
  readonly domain: string;
}

/**
 * An async-iterable source of typed stream chunks.
 *
 * Adapters may expose response bodies as `VerserStreamChunkSource` for
 * chunk-at-a-time consumption without buffering the entire body.
 *
 * @typeParam TChunk - The chunk element type (typically `Buffer` or `Uint8Array`).
 *
 * @public
 */
export interface VerserStreamChunkSource<TChunk> extends AsyncIterable<TChunk> {}

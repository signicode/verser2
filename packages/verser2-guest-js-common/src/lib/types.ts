import type { RoutedDomainRegistration } from '@signicode/verser-common';

export type {
  VerserCommonBroker,
  VerserCommonBrokerRequest,
  VerserCommonBrokerResponse,
  VerserHeaderInput,
  VerserHeaderValue,
} from '@signicode/verser-common';

export type VerserRoute = RoutedDomainRegistration;

export interface AbstractRoute {
  readonly targetId: string;
  readonly domain: string;
}

export interface VerserStreamChunkSource<TChunk> extends AsyncIterable<TChunk> {}

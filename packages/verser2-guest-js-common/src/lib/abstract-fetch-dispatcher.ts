import { createCommonBrokerRequest } from '@signicode/verser-common';
import { resolveRouteForUrl } from '@signicode/verser-common';
import type { VerserCommonBroker, VerserCommonBrokerRequest, VerserRoute } from './types';

export abstract class AbstractVerserFetchDispatcher<TRequestBody, TResponseBody> {
  protected constructor(
    protected readonly broker: VerserCommonBroker<TRequestBody, TResponseBody>,
  ) {}

  protected resolveRouteForUrl(url: URL): VerserRoute {
    const route = resolveRouteForUrl(this.broker.getRoutes(), url);
    if (route === undefined) {
      throw new Error(`No Verser route advertised for host ${url.hostname}`);
    }
    return route;
  }

  protected createBrokerRequest(
    request: VerserCommonBrokerRequest<TRequestBody>,
  ): VerserCommonBrokerRequest<TRequestBody> {
    return createCommonBrokerRequest(request);
  }
}

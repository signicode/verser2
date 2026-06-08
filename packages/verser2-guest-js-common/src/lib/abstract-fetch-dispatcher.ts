import { resolveRouteForHostname } from './routes';
import type { VerserCommonBroker, VerserCommonBrokerRequest, VerserRoute } from './types';
import { createCommonBrokerRequest } from './utils';

export abstract class AbstractVerserFetchDispatcher<TRequestBody, TResponseBody> {
  protected constructor(
    protected readonly broker: VerserCommonBroker<TRequestBody, TResponseBody>,
  ) {}

  protected resolveRouteForUrl(url: URL): VerserRoute {
    const route = resolveRouteForHostname(this.broker.getRoutes(), url.hostname);
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

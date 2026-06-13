import { createCommonBrokerRequest } from '@signicode/verser-common';
import { resolveRouteForUrl } from '@signicode/verser-common';
import type { VerserCommonBroker, VerserCommonBrokerRequest, VerserRoute } from './types';

/**
 * Abstract base class for fetch-style dispatchers that route through a Verser Broker.
 *
 * Subclasses provide the request/response body type mapping; this class handles
 * route resolution by URL hostname and Broker request creation.
 *
 * Not intended for direct app-level dispatch — subclass to adapt to a specific
 * runtime's fetch or HTTP abstractions.
 *
 * @typeParam TRequestBody - The Broker request body type.
 * @typeParam TResponseBody - The Broker response body type.
 *
 * @public
 */
export abstract class AbstractVerserFetchDispatcher<TRequestBody, TResponseBody> {
  protected constructor(
    protected readonly broker: VerserCommonBroker<TRequestBody, TResponseBody>,
  ) {}

  /**
   * Resolves a URL to its advertised Verser route.
   *
   * Throws if no route is advertised for the URL's hostname.
   *
   * @param url - The target URL whose hostname is matched against advertised routes.
   * @returns The matching route record.
   */
  protected resolveRouteForUrl(url: URL): VerserRoute {
    const route = resolveRouteForUrl(this.broker.getRoutes(), url);
    if (route === undefined) {
      throw new Error(`No Verser route advertised for host ${url.hostname}`);
    }
    return route;
  }

  /**
   * Creates a validated Broker request from a raw request object.
   *
   * Delegates to {@link createCommonBrokerRequest} for common header
   * and envelope normalization.
   *
   * @param request - The raw Broker request to normalize.
   * @returns The normalized Broker request.
   */
  protected createBrokerRequest(
    request: VerserCommonBrokerRequest<TRequestBody>,
  ): VerserCommonBrokerRequest<TRequestBody> {
    return createCommonBrokerRequest(request);
  }
}

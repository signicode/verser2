import { validateVerserHeaders } from '@signicode/verser-common';

export const VERSER2_GUEST_JS_COMMON_PACKAGE_NAME = '@signicode/verser2-guest-js-common';

export interface VerserRoute {
  readonly targetId: string;
  readonly domain: string;
}

export interface VerserCommonBrokerRequest<TBody> {
  readonly targetId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: TBody;
}

export interface VerserCommonBrokerResponse<TBody> {
  readonly requestId: string;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: TBody;
}

export interface VerserCommonBroker<TRequestBody, TResponseBody> {
  getRoutes(): VerserRoute[];
  waitForRoute(domain: string): Promise<void>;
  request(
    request: VerserCommonBrokerRequest<TRequestBody>,
  ): Promise<VerserCommonBrokerResponse<TResponseBody>>;
}

export type VerserHeaderValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

export type VerserHeaderInput =
  | Readonly<Record<string, VerserHeaderValue>>
  | readonly string[]
  | Iterable<readonly [string, VerserHeaderValue]>;

export interface VerserStreamChunkSource<TChunk> extends AsyncIterable<TChunk> {}

export function resolveRouteForHostname(
  routes: readonly VerserRoute[],
  hostname: string,
): VerserRoute | undefined {
  return routes.find((route) => route.domain === hostname);
}

export function flattenHeaderValue(value: VerserHeaderValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ');
  }
  return String(value);
}

export function normalizeHeaders(headers: VerserHeaderInput | undefined): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  if (headers === undefined) {
    return normalizedHeaders;
  }

  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index];
      const value = headers[index + 1];
      if (typeof name === 'string' && typeof value === 'string') {
        normalizedHeaders[name.toLowerCase()] = value;
      }
    }
    return validateVerserHeaders(normalizedHeaders) as Record<string, string>;
  }

  if (isHeaderPairIterable(headers)) {
    for (const [name, value] of headers) {
      const flattenedValue = flattenHeaderValue(value);
      if (flattenedValue !== undefined) {
        normalizedHeaders[name.toLowerCase()] = flattenedValue;
      }
    }
    return validateVerserHeaders(normalizedHeaders) as Record<string, string>;
  }

  for (const [name, value] of Object.entries(headers)) {
    const flattenedValue = flattenHeaderValue(value);
    if (flattenedValue !== undefined) {
      normalizedHeaders[name.toLowerCase()] = flattenedValue;
    }
  }
  return validateVerserHeaders(normalizedHeaders) as Record<string, string>;
}

export function createCommonBrokerRequest<TBody>(
  request: VerserCommonBrokerRequest<TBody>,
): VerserCommonBrokerRequest<TBody> {
  return {
    ...request,
    headers: normalizeHeaders(request.headers),
  };
}

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

function isHeaderPairIterable(
  value: VerserHeaderInput,
): value is Iterable<readonly [string, VerserHeaderValue]> {
  return Symbol.iterator in Object(value) && !Array.isArray(value);
}

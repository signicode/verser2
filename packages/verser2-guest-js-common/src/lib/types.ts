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

export interface AbstractRoute {
  readonly targetId: string;
  readonly domain: string;
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

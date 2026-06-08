import { normalizeHeaders } from './headers';
import type { VerserCommonBrokerRequest, VerserHeaderInput } from './types';

export function createCommonBrokerRequest<TBody>(
  request: VerserCommonBrokerRequest<TBody>,
): VerserCommonBrokerRequest<TBody> {
  return {
    ...request,
    headers: normalizeHeaders(request.headers as VerserHeaderInput | undefined),
  };
}

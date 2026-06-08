import { normalizeBrokerRequestBody } from './body';
import { normalizeHeaders } from './headers';
import type { VerserCommonBrokerRequest, VerserHeaderInput, VerserHeaders } from './types';
import { requireNonEmpty } from './utils';

export function createCommonBrokerRequest<TBody>(
  request: VerserCommonBrokerRequest<TBody>,
): VerserCommonBrokerRequest<TBody> {
  const normalizedBody =
    request.body === undefined ? undefined : normalizeBrokerRequestBody(request.body);
  const normalizedPath = normalizeBrokerRequestPath(request.path);
  const normalizedMethod = normalizeBrokerRequestMethod(request.method);
  const normalizedHeaders = normalizeHeaders(request.headers as VerserHeaderInput | undefined);

  return {
    targetId: requireNonEmpty(request.targetId, 'target id'),
    method: normalizedMethod,
    path: normalizedPath,
    headers: normalizedHeaders as VerserHeaders,
    body: normalizedBody as unknown as TBody,
  };
}

function normalizeBrokerRequestMethod(method: string): string {
  const normalizedMethod = method.trim().toUpperCase();
  return requireNonEmpty(normalizedMethod, 'request method');
}

function normalizeBrokerRequestPath(path: string): string {
  const normalizedPath = path.trim();
  if (normalizedPath === '*') {
    return normalizedPath;
  }
  if (normalizedPath.length === 0) {
    return '/';
  }
  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
}

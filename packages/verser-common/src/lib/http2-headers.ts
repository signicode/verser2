import type { RoutedRequestEnvelope, RoutedResponseEnvelope } from './types';
import { requireNonEmpty, requireValidStatusCode } from './utils';

export function toHttp2RequestHeaders(
  request: Pick<RoutedRequestEnvelope, 'method' | 'path'>,
): Record<string, string> {
  return {
    ':method': request.method,
    ':path': request.path,
  };
}

export function fromHttp2RequestHeaders(headers: Record<string, string | number | undefined>): {
  method: string;
  path: string;
} {
  return {
    method: requireNonEmpty(String(headers[':method'] ?? ''), 'HTTP/2 :method'),
    path: requireNonEmpty(String(headers[':path'] ?? ''), 'HTTP/2 :path'),
  };
}

export function toHttp2ResponseHeaders(
  response: Pick<RoutedResponseEnvelope, 'statusCode'>,
): Record<string, number> {
  return { ':status': response.statusCode };
}

export function fromHttp2ResponseHeaders(headers: Record<string, string | number | undefined>): {
  statusCode: number;
} {
  return { statusCode: requireValidStatusCode(Number(headers[':status'])) };
}

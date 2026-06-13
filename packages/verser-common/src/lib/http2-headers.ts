import type { RoutedRequestEnvelope, RoutedResponseEnvelope } from './types';
import { requireNonEmpty, requireValidStatusCode } from './utils';

/**
 * Converts a routed request's method and path into HTTP/2 pseudo-header format.
 *
 * Returns `:method` and `:path` pseudo-headers suitable for use in HTTP/2 frames.
 *
 * @param request - The request with `method` and `path` fields.
 * @returns A record with `:method` and `:path` pseudo-headers.
 * @public
 */
export function toHttp2RequestHeaders(
  request: Pick<RoutedRequestEnvelope, 'method' | 'path'>,
): Record<string, string> {
  return {
    ':method': request.method,
    ':path': request.path,
  };
}

/**
 * Extracts `:method` and `:path` pseudo-headers from an HTTP/2 header map
 * and converts them to a plain method/path object.
 *
 * @param headers - HTTP/2 headers including pseudo-headers.
 * @returns An object with `method` and `path` strings.
 * @throws {VerserError} If `:method` or `:path` is empty.
 * @public
 */
export function fromHttp2RequestHeaders(headers: Record<string, string | number | undefined>): {
  method: string;
  path: string;
} {
  return {
    method: requireNonEmpty(String(headers[':method'] ?? ''), 'HTTP/2 :method'),
    path: requireNonEmpty(String(headers[':path'] ?? ''), 'HTTP/2 :path'),
  };
}

/**
 * Converts a response status code to an HTTP/2 `:status` pseudo-header.
 *
 * @param response - The response with a `statusCode` field.
 * @returns A record with `:status` pseudo-header.
 * @public
 */
export function toHttp2ResponseHeaders(
  response: Pick<RoutedResponseEnvelope, 'statusCode'>,
): Record<string, number> {
  return { ':status': response.statusCode };
}

/**
 * Extracts `:status` pseudo-header from an HTTP/2 header map and converts it
 * to a status code number.
 *
 * @param headers - HTTP/2 headers including `:status`.
 * @returns An object with the numeric `statusCode`.
 * @throws {VerserError} If the status code is not a valid integer between 100 and 599.
 * @public
 */
export function fromHttp2ResponseHeaders(headers: Record<string, string | number | undefined>): {
  statusCode: number;
} {
  return { statusCode: requireValidStatusCode(Number(headers[':status'])) };
}

/**
 * Removes HTTP/2 pseudo-headers (those starting with `:`) from a header record
 * and converts remaining values to strings.
 *
 * Pseudo-headers (`:method`, `:path`, `:status`, etc.) have no meaning outside
 * HTTP/2 framing and are stripped when converting to application-level headers.
 *
 * @param headers - HTTP/2 headers including pseudo-headers.
 * @returns A record with only non-pseudo headers as strings.
 * @public
 */
export function stripHttp2PseudoHeaders(
  headers: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(':') || value === undefined) {
      continue;
    }
    normalizedHeaders[key] = String(value);
  }

  return normalizedHeaders;
}

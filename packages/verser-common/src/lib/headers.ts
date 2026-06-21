import { createVerserError } from './errors';
import type { VerserHeaderInput, VerserHeaderValue, VerserHeaders } from './types';
import { isValidHttpHeaderName } from './utils';

const FORBIDDEN_HTTP1_HEADERS = new Set(['connection', 'upgrade', 'keep-alive']);

function isHeaderPairIterable(
  value: VerserHeaderInput,
): value is Iterable<readonly [string, VerserHeaderValue]> {
  return Symbol.iterator in Object(value) && !Array.isArray(value);
}

/**
 * Checks whether a string is a valid HTTP header name per RFC 7230.
 *
 * Allows token characters: `!#$%&'*+.^_``|~0-9A-Za-z-`.
 *
 * @param headerName - The header name to validate.
 * @returns `true` if the name is a valid HTTP token.
 * @public
 */
export function isValidHeaderName(headerName: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName);
}

/**
 * Checks whether a string is a valid HTTP header value per RFC 7230.
 *
 * Rejects control characters (0x00–0x08, 0x0a–0x1f, 0x7f).
 * Backslash and DEL are also rejected.
 *
 * @param headerValue - The header value to validate.
 * @returns `true` if the value contains no forbidden control characters.
 * @public
 */
export function isValidHeaderValue(headerValue: string): boolean {
  for (let index = 0; index < headerValue.length; index += 1) {
    const code = headerValue.charCodeAt(index);
    if ((code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
      return false;
    }
  }

  return true;
}

/**
 * Validates header names and values according to runtime-neutral HTTP rules.
 *
 * Throws a `VerserError` with code `protocol-error` if any header name or value
 * is invalid.
 *
 * @param headers - The headers to validate (name → string).
 * @returns The same headers object if valid (pass-through).
 * @throws {VerserError} If any header name or value is invalid.
 * @public
 */
export function validateRuntimeNeutralHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const validatedHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!isValidHeaderName(headerName)) {
      throw createVerserError('protocol-error', `Invalid header name: ${headerName}`, {
        header: headerName,
      });
    }
    if (!isValidHeaderValue(headerValue)) {
      throw createVerserError('protocol-error', `Invalid header value for ${headerName}`, {
        header: headerName,
      });
    }
    validatedHeaders[headerName] = headerValue;
  }

  return validatedHeaders;
}

/**
 * Flattens a single {@link VerserHeaderValue} to a string or `undefined`.
 *
 * - `null` / `undefined` → `undefined` (omitted)
 * - Arrays → joined with `,`
 * - Other values → `String(value)`
 *
 * @param value - The header value to flatten.
 * @returns The flattened string, or `undefined` if the value should be omitted.
 * @public
 */
export function flattenHeaderValue(value: VerserHeaderValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(',');
  }

  return String(value);
}

/**
 * Normalizes a {@link VerserHeaderInput} into a flat `Record<string, string>`.
 *
 * Accepts a record, an even-length array `[name, value, name, value, …]`,
 * or an iterable of `[name, value]` pairs. All header names are lowercased.
 * Null and undefined values are omitted; booleans and numbers are stringified.
 * The result is validated via
 * {@link validateRuntimeNeutralHeaders}.
 *
 * @param headers - The headers to normalize.
 * @returns A flat record of lowercase header names to string values.
 * @throws {VerserError} If any header name or value is invalid.
 * @public
 */
export function normalizeHeaders(headers: VerserHeaderInput | undefined): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  if (headers === undefined) {
    return normalizedHeaders;
  }

  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index];
      const value = headers[index + 1];
      if (typeof name === 'string') {
        const flattenedValue = flattenHeaderValue(value);
        if (flattenedValue !== undefined) {
          normalizedHeaders[name.toLowerCase()] = flattenedValue;
        }
      }
    }

    return validateRuntimeNeutralHeaders(normalizedHeaders);
  }

  if (isHeaderPairIterable(headers)) {
    for (const [name, value] of headers) {
      const flattenedValue = flattenHeaderValue(value);
      if (flattenedValue !== undefined) {
        normalizedHeaders[name.toLowerCase()] = flattenedValue;
      }
    }
    return validateRuntimeNeutralHeaders(normalizedHeaders);
  }

  for (const [name, value] of Object.entries(headers)) {
    const flattenedValue = flattenHeaderValue(value as VerserHeaderValue);
    if (flattenedValue !== undefined) {
      normalizedHeaders[name.toLowerCase()] = flattenedValue;
    }
  }

  return validateRuntimeNeutralHeaders(normalizedHeaders);
}

/**
 * Normalizes Node.js `OutgoingHttpHeaders` into a flat string record.
 *
 * Supports string, number, and array values. Intended for use when forwarding
 * headers from a Node Guest's local HTTP handler response.
 *
 * @param headers - Node.js outgoing HTTP headers.
 * @returns A flat record of header names to string values.
 * @public
 */
export function normalizeRequestHeaders(
  headers: import('node:http').OutgoingHttpHeaders | undefined,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') {
      normalizedHeaders[key] = value;
    } else if (typeof value === 'number') {
      normalizedHeaders[key] = String(value);
    } else if (Array.isArray(value)) {
      normalizedHeaders[key] = value.join(',');
    }
  }

  return normalizedHeaders;
}

/**
 * Validates headers for inclusion in a Verser routed envelope.
 *
 * Forbids `connection`, `upgrade`, and `keep-alive` as they have no meaning in
 * the Verser HTTP/2 transport. All header names are lowercased and validated.
 *
 * @param headers - The headers to validate.
 * @returns The validated headers with string or string[] values.
 * @throws {VerserError} If a header name is invalid or a forbidden header is present.
 * @public
 */
export function validateVerserHeaders(headers: VerserHeaders): Record<string, string | string[]> {
  const validatedHeaders: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (!isValidHttpHeaderName(normalizedName)) {
      throw createVerserError('protocol-error', 'Invalid header name', { header: name });
    }
    if (FORBIDDEN_HTTP1_HEADERS.has(normalizedName)) {
      throw createVerserError('protocol-error', 'Forbidden header for routed metadata', {
        header: normalizedName,
      });
    }

    validatedHeaders[normalizedName] = Array.isArray(value)
      ? value.map((entry) => String(entry))
      : String(value);
  }

  return validatedHeaders;
}

/**
 * Standard HTTP/1 hop-by-hop headers that MUST NOT be forwarded over HTTP/2.
 *
 * @internal
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Sanitizes response headers for HTTP/2 transport by removing hop-by-hop
 * headers that have no meaning in HTTP/2.
 *
 * Removes:
 * - Standard hop-by-hop headers (`connection`, `keep-alive`,
 *   `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
 *   `transfer-encoding`, `upgrade`).
 * - Any header whose name appears as a value in the `Connection` header
 *   (parsed as a comma-separated list of tokens).
 *
 * @param headers - Response headers to sanitize.
 * @returns A new headers object with hop-by-hop headers removed.
 * @public
 */
export function sanitizeHttp2ResponseHeaders(headers: VerserHeaders): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const connectionTokens = new Set<string>();

  // Collect connection tokens from the Connection header value.
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'connection' && value !== null && value !== undefined) {
      const rawValue = Array.isArray(value)
        ? value.map((entry) => String(entry)).join(',')
        : String(value);
      for (const token of rawValue.split(',')) {
        const trimmed = token.trim().toLowerCase();
        if (trimmed.length > 0) {
          connectionTokens.add(trimmed);
        }
      }
    }
  }

  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedName)) {
      // Skip hop-by-hop headers.
      continue;
    }
    if (connectionTokens.has(normalizedName)) {
      // Skip headers listed in the Connection header value.
      continue;
    }
    sanitized[name] = Array.isArray(value)
      ? value.map((entry) => String(entry)).join(',')
      : String(value);
  }

  return sanitized;
}

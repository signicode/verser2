import { createVerserError } from './errors';
import type { VerserHeaderInput, VerserHeaderValue, VerserHeaders } from './types';
import { isValidHttpHeaderName } from './utils';

const FORBIDDEN_HTTP1_HEADERS = new Set(['connection', 'upgrade', 'keep-alive']);

function isHeaderPairIterable(
  value: VerserHeaderInput,
): value is Iterable<readonly [string, VerserHeaderValue]> {
  return Symbol.iterator in Object(value) && !Array.isArray(value);
}

export function isValidHeaderName(headerName: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName);
}

export function isValidHeaderValue(headerValue: string): boolean {
  for (let index = 0; index < headerValue.length; index += 1) {
    const code = headerValue.charCodeAt(index);
    if ((code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
      return false;
    }
  }

  return true;
}

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

export function flattenHeaderValue(value: VerserHeaderValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(',');
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

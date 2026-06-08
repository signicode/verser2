import { createVerserError } from './errors';
import type { VerserHeaders } from './types';
import { isValidHttpHeaderName } from './utils';

const FORBIDDEN_HTTP1_HEADERS = new Set(['connection', 'upgrade', 'keep-alive']);

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

    validatedHeaders[normalizedName] = Array.isArray(value) ? [...value] : String(value);
  }

  return validatedHeaders;
}

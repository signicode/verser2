import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

import type { VerserHeaderPair } from '@signicode/verser-common';

export function parseContentLength(headerText: string): number {
  const match = /content-length:\s*(\d+)/i.exec(headerText);
  if (match === null) {
    return 0;
  }

  return Number.parseInt(match[1], 10);
}

export function normalizeRequestHeaders(
  headers: OutgoingHttpHeaders | undefined,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') {
      normalizedHeaders[key] = value;
    } else if (typeof value === 'number') {
      normalizedHeaders[key] = String(value);
    } else if (Array.isArray(value)) {
      normalizedHeaders[key] = value.join(', ');
    }
  }
  return normalizedHeaders;
}

export function toHeaderPairs(
  headers: Record<string, string>,
  headerPairs: readonly VerserHeaderPair[] | undefined,
): readonly VerserHeaderPair[] {
  return headerPairs ?? Object.entries(headers);
}

export function toRawHeaderList(
  headers: Record<string, string>,
  headerPairs?: readonly VerserHeaderPair[],
): Buffer[] {
  return toHeaderPairs(headers, headerPairs).flatMap(([name, value]) => [
    Buffer.from(name, 'latin1'),
    Buffer.from(value, 'latin1'),
  ]);
}

export function toIncomingHeaders(
  headers: Record<string, string>,
  headerPairs?: readonly VerserHeaderPair[],
): IncomingHttpHeaders {
  const incoming = Object.create(null) as IncomingHttpHeaders;
  for (const [name, value] of toHeaderPairs(headers, headerPairs)) {
    const existing = incoming[name];
    incoming[name] =
      existing === undefined
        ? value
        : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return incoming;
}

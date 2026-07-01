import type { OutgoingHttpHeaders } from 'node:http';

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

export function toRawHeaderList(headers: Record<string, string>): Buffer[] {
  return Object.entries(headers).flatMap(([name, value]) => [
    Buffer.from(name),
    Buffer.from(value),
  ]);
}

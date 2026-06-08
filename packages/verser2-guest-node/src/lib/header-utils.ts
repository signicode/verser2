import type { Dispatcher } from 'undici';

export function parseContentLength(headerText: string): number {
  const match = /content-length:\s*(\d+)/i.exec(headerText);
  if (match === null) {
    return 0;
  }

  return Number.parseInt(match[1], 10);
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
      normalizedHeaders[key] = value.join(', ');
    }
  }
  return normalizedHeaders;
}

export function normalHeaders(
  headers: import('node:http2').IncomingHttpHeaders,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith(':') && typeof value === 'string') {
      normalizedHeaders[key] = value;
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

export function flattenHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  const flattenedHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    flattenedHeaders[headerName] =
      typeof headerValue === 'string' ? headerValue : headerValue.join(',');
  }
  return flattenedHeaders;
}

export function appendQueryString(
  path: string,
  query: Dispatcher.DispatchOptions['query'] | undefined,
): string {
  if (query === undefined || Object.keys(query).length === 0) {
    return path;
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        searchParams.append(key, String(entry));
      }
      continue;
    }
    searchParams.append(key, String(value));
  }
  const separator = path.includes('?') ? '&' : '?';
  const queryString = searchParams.toString();
  return queryString.length === 0 ? path : `${path}${separator}${queryString}`;
}

export function decodeHeaderMap(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

export function flattenValidatedHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === 'string' ? value : value.join(','),
    ]),
  );
}

export function parseLeaseAcquireTimeoutMs(
  headers: import('node:http2').IncomingHttpHeaders,
): number {
  const value = Number(headers['x-verser-lease-acquire-timeout-ms'] ?? 5000);
  if (!Number.isFinite(value) || value < 0) {
    return 5000;
  }

  return value;
}

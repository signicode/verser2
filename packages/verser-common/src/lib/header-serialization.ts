export function flattenVerserHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  const flattenedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattenedHeaders[name] = typeof value === 'string' ? value : value.join(',');
  }

  return flattenedHeaders;
}

export function decodeHeaderMap(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

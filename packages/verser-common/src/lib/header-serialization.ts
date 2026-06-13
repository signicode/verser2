/**
 * Flattens a header record where values may be strings or string arrays into
 * a `Record<string, string>` by joining array values with `,`.
 *
 * Used to prepare headers for inclusion in envelope metadata where each header
 * must be a single string.
 *
 * @param headers - Headers with string or string-array values.
 * @returns A flat record of header names to single string values.
 * @public
 */
export function flattenVerserHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  const flattenedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattenedHeaders[name] = typeof value === 'string' ? value : value.join(',');
  }

  return flattenedHeaders;
}

/**
 * Decodes a JSON-encoded header map string into a flat `Record<string, string>`.
 *
 * Used on the Host to parse the `x-verser-headers` request header that carries
 * the serialized header map from Brokers.
 *
 * @param value - JSON string encoding a header record.
 * @returns The decoded header record.
 * @public
 */
export function decodeHeaderMap(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

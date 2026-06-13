/**
 * Appends query-string parameters to a path.
 *
 * Array values produce repeated `key=value` pairs. `null` and `undefined`
 * values are skipped. If the path already contains a query string the
 * additional parameters are appended with `&`.
 *
 * @param path - The base path (may already contain a query string).
 * @param query - A map of query parameter names to values, or `undefined` to skip.
 * @returns The path with query parameters appended, or the original path unchanged.
 *
 * @public
 */
export function appendQueryString(
  path: string,
  query: Record<string, unknown> | undefined,
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

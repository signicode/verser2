/**
 * The HTTP header name for specifying a lease acquisition timeout in milliseconds.
 *
 * Brokers can set this header on routed requests to control how long the Host
 * waits to acquire a lease stream from the target Guest before timing out.
 * Defaults to 5000 ms if not set or invalid.
 *
 * @public
 */
export const VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER = 'x-verser-lease-acquire-timeout-ms';

/**
 * Parses the lease acquisition timeout from request headers.
 *
 * Reads the {@link VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER} header and returns the
 * numeric value. Falls back to `5000` if the header is missing or the value
 * is not a non-negative finite number.
 *
 * @param headers - The request headers.
 * @returns The timeout in milliseconds (default 5000).
 * @public
 */
export function parseLeaseAcquireTimeoutMs(
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
): number {
  const value = Number(headers[VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER] ?? 5000);
  if (!Number.isFinite(value) || value < 0) {
    return 5000;
  }

  return value;
}

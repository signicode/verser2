export const VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER = 'x-verser-lease-acquire-timeout-ms';

export function parseLeaseAcquireTimeoutMs(
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
): number {
  const value = Number(headers[VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER] ?? 5000);
  if (!Number.isFinite(value) || value < 0) {
    return 5000;
  }

  return value;
}

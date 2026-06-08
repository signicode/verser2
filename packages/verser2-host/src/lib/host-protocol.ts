import { createVerserError } from '@signicode/verser-common';
import type { VerserHostRegistrationRequest } from './types';

export function parseRegistrationRequest(body: string): VerserHostRegistrationRequest {
  const parsed = JSON.parse(body) as Partial<VerserHostRegistrationRequest>;
  if (parsed.role !== 'broker' && parsed.role !== 'guest') {
    throw createVerserError('invalid-registration', 'Registration role must be broker or guest', {
      role: String(parsed.role ?? ''),
    });
  }

  return {
    peerId: String(parsed.peerId ?? ''),
    role: parsed.role,
    routedDomains: parsed.routedDomains ?? [],
  };
}

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

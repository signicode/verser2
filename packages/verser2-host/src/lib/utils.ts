import { createVerserError } from '@signicode/verser-common';
import type { VerserError } from '@signicode/verser-common';

export function toVerserError(error: unknown): VerserError {
  if (error instanceof Error && 'code' in error && error.name === 'VerserError') {
    return error as VerserError;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createVerserError('protocol-error', message);
}

export function activeLeaseKey(guestId: string, leaseId: string): string {
  return `${guestId}:${leaseId}`;
}

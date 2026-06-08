import { createVerserError } from '@signicode/verser-common';
import type { VerserError } from '@signicode/verser-common';

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly context: Record<string, string | number | boolean>;
  };
}

export function toErrorResponse(error: VerserError): ErrorResponse {
  const context = Object.fromEntries(
    Object.entries(error.context).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );

  return { error: { code: error.code, message: error.message, context } };
}

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

import { createVerserError } from '@signicode/verser-common';
import type { VerserError, VerserErrorCode } from '@signicode/verser-common';

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toVerserError(error: unknown): VerserError {
  return createVerserError('protocol-error', getErrorMessage(error), { guestId: 'unknown' });
}

export function toVerserErrorCode(code: string | undefined): VerserErrorCode {
  if (
    code === 'missing-guest' ||
    code === 'disconnected-target' ||
    code === 'timeout' ||
    code === 'stream-failure' ||
    code === 'protocol-error' ||
    code === 'local-handler-failure' ||
    code === 'invalid-registration' ||
    code === 'certificate-verification-failure'
  ) {
    return code;
  }

  return 'local-handler-failure';
}

export function errorFromBody(body: Buffer, targetId: string): VerserError {
  const parsed = JSON.parse(body.toString('utf8')) as {
    error?: {
      code?: string;
      message?: string;
      context?: Record<string, string | number | boolean>;
    };
  };
  const code = toVerserErrorCode(parsed.error?.code);
  return createVerserError(code, parsed.error?.message ?? 'Broker request failed', {
    targetId,
    ...(parsed.error?.context ?? {}),
  });
}

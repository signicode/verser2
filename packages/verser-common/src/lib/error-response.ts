import type { VerserError } from './errors';
import { createVerserError } from './errors';
import type { VerserErrorCode } from './types';

export interface VerserHttpErrorResponse {
  readonly error: {
    readonly code: VerserErrorCode;
    readonly message: string;
    readonly context: Record<string, string | number | boolean>;
  };
}

export function toVerserHttpErrorResponse(error: VerserError): VerserHttpErrorResponse {
  const context = Object.fromEntries(
    Object.entries(error.context).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );

  return { error: { code: error.code, message: error.message, context } };
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

export function verserErrorFromResponseBody(body: Buffer, targetId: string): VerserError {
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

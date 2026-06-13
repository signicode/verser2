import type { VerserError } from './errors';
import { createVerserError } from './errors';
import type { VerserErrorCode } from './types';

/**
 * A serializable HTTP error response body, used in Host 502 responses
 * and in error envelopes returned to Brokers.
 *
 * Contains a machine-readable error code, human-readable message, and
 * optional structured context.
 *
 * @public
 */
export interface VerserHttpErrorResponse {
  readonly error: {
    /** Machine-readable error code. */
    readonly code: VerserErrorCode;
    /** Human-readable error description. */
    readonly message: string;
    /** Structured context for debugging. */
    readonly context: Record<string, string | number | boolean>;
  };
}

/**
 * Converts a {@link VerserError} to the serializable {@link VerserHttpErrorResponse} shape.
 *
 * Filters out `undefined` context values to produce a clean JSON body.
 *
 * @param error - The Verser error to convert.
 * @returns A serializable error response object.
 * @public
 */
export function toVerserHttpErrorResponse(error: VerserError): VerserHttpErrorResponse {
  const context = Object.fromEntries(
    Object.entries(error.context).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );

  return { error: { code: error.code, message: error.message, context } };
}

/**
 * Validates and normalizes an error code string to a known {@link VerserErrorCode}.
 *
 * If the code is not recognized, defaults to `'local-handler-failure'`.
 *
 * @param code - The raw error code string.
 * @returns A valid `VerserErrorCode`.
 * @public
 */
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

/**
 * Parses a `VerserError` from a JSON response body returned by the Host or Guest.
 *
 * Expected format: `{ error: { code, message, context } }`.
 * If the error code is not recognized, defaults to `'local-handler-failure'`.
 *
 * @param body - The JSON response body buffer.
 * @param targetId - The target Guest ID for error context.
 * @returns A `VerserError` instance parsed from the body.
 * @public
 */
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

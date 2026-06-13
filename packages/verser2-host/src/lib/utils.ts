import { createVerserError } from '@signicode/verser-common';
import type { VerserError } from '@signicode/verser-common';

/**
 * Wraps an unknown error value into a {@link VerserError} for Host error handling.
 *
 * If the error is already a `VerserError` (detected by checking the `code` property
 * and `name === 'VerserError'`), it is returned as-is. Otherwise a new
 * `protocol-error` `VerserError` is created from the error message.
 *
 * @param error - The error value to wrap.
 * @returns A `VerserError` instance.
 * @public
 */
export function toVerserError(error: unknown): VerserError {
  if (error instanceof Error && 'code' in error && error.name === 'VerserError') {
    return error as VerserError;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createVerserError('protocol-error', message);
}

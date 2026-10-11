import {
  createVerserError,
  getErrorMessage,
  verserErrorFromResponseBody,
} from '@signicode/verser-common';
import { VerserError } from '@signicode/verser-common';

export function toVerserError(error: unknown): ReturnType<typeof createVerserError> {
  if (error instanceof VerserError) return error;
  return createVerserError('protocol-error', getErrorMessage(error), { guestId: 'unknown' });
}

export function createAbortError(reason?: unknown): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  Object.assign(error, { code: 'ABORT_ERR', cause: reason });
  return error;
}

export { verserErrorFromResponseBody };

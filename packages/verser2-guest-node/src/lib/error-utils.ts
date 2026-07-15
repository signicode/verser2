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

export { verserErrorFromResponseBody };

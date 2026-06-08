import {
  createVerserError,
  getErrorMessage,
  verserErrorFromResponseBody,
} from '@signicode/verser-common';
import type { VerserError } from '@signicode/verser-common';

export function toVerserError(error: unknown): VerserError {
  return createVerserError('protocol-error', getErrorMessage(error), { guestId: 'unknown' });
}

export { verserErrorFromResponseBody };

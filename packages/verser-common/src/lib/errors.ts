import type { VerserErrorCode, VerserErrorContext } from './types';

export interface VerserErrorContextInput {
  guestId?: string;
}

type MutableVerserErrorContext = Record<string, string | number | boolean | undefined>;

function formatVerserErrorMessage(
  code: VerserErrorCode,
  message: string,
  context: VerserErrorContext,
): string {
  const contextPairs = Object.entries(context)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  const contextSuffix = contextPairs.length > 0 ? ` (${contextPairs.join(', ')}` : '';
  return `[${code}] ${message}${contextSuffix}`;
}

export class VerserError extends Error {
  public readonly code: VerserErrorCode;

  public readonly context: VerserErrorContext;

  public constructor(code: VerserErrorCode, message: string, context: VerserErrorContext = {}) {
    super(formatVerserErrorMessage(code, message, context));
    this.name = 'VerserError';
    this.code = code;
    this.context = context;
  }
}

export function createVerserError(
  code: VerserErrorCode,
  message: string,
  context: VerserErrorContext = {},
): VerserError {
  return new VerserError(code, message, context);
}

export function toVerserError(error: unknown, context: VerserErrorContextInput = {}): VerserError {
  if (error instanceof VerserError) {
    if (context.guestId !== undefined && error.context.guestId !== context.guestId) {
      (error.context as MutableVerserErrorContext).guestId = context.guestId;
    }
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createVerserError('protocol-error', message, context as VerserErrorContext);
}

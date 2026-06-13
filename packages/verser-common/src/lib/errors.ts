import type { VerserErrorCode, VerserErrorContext } from './types';

/**
 * Input context for {@link toVerserError} when wrapping an unknown error.
 *
 * @internal
 */
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

/**
 * A typed error used throughout Verser protocol handling.
 *
 * Includes a machine-readable `code` from the {@link VerserErrorCode} union and an
 * optional `context` map for structured diagnostics. The `message` is formatted as
 * `[code] message (key=val, ...)`.
 *
 * @public
 */
export class VerserError extends Error {
  /** Machine-readable error code. */
  public readonly code: VerserErrorCode;

  /** Structured context key-value pairs for diagnostics. */
  public readonly context: VerserErrorContext;

  public constructor(code: VerserErrorCode, message: string, context: VerserErrorContext = {}) {
    super(formatVerserErrorMessage(code, message, context));
    this.name = 'VerserError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Creates a new {@link VerserError} with the given code, message, and optional context.
 *
 * @param code - Machine-readable error code.
 * @param message - Human-readable error description.
 * @param context - Optional structured context key-value pairs.
 * @returns A new `VerserError` instance.
 * @public
 */
export function createVerserError(
  code: VerserErrorCode,
  message: string,
  context: VerserErrorContext = {},
): VerserError {
  return new VerserError(code, message, context);
}

/**
 * Wraps an unknown error value into a {@link VerserError}.
 *
 * If the error is already a `VerserError` it is returned as-is (optionally updating
 * the `guestId` context field). Otherwise a new `protocol-error` `VerserError` is
 * created from the error message.
 *
 * @param error - The error value to wrap.
 * @param context - Optional context; only `guestId` is used to patch existing errors.
 * @returns A `VerserError` instance.
 * @public
 */
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

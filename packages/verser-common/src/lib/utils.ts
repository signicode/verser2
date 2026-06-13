import { createVerserError } from './errors';
import type { VerserEnvelopeTypeName } from './types';

/**
 * Type guard that checks whether a value is a non-null, non-array object.
 *
 * @param value - The value to check.
 * @returns `true` if the value is a plain object (`Record<string, unknown>`).
 * @public
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely extracts an error message from any thrown value.
 *
 * @param error - The error value (Error instance or unknown).
 * @returns The error message string.
 * @public
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates that a string is non-empty after trimming.
 *
 * @param value - The string to validate.
 * @param label - A human-readable label for error messages.
 * @returns The trimmed non-empty string.
 * @throws {VerserError} With code `invalid-registration` if the value is empty.
 * @public
 */
export function requireNonEmpty(value: string, label: string): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw createVerserError('invalid-registration', `${label} must not be empty`, {
      field: label,
    });
  }

  return normalizedValue;
}

/**
 * Validates that a number is a valid HTTP status code (integer, 100–599).
 *
 * @param value - The status code to validate.
 * @returns The validated status code.
 * @throws {VerserError} With code `protocol-error` if the value is not a valid status code.
 * @public
 */
export function requireValidStatusCode(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw createVerserError('protocol-error', 'HTTP status code must be between 100 and 599', {
      statusCode: value,
    });
  }

  return value;
}

/**
 * Checks whether a string is a valid lowercase HTTP header name token.
 *
 * Less permissive than {@link isValidHeaderName} — requires lowercase only.
 * Used for validating already-normalized header names.
 *
 * @param name - The header name to validate.
 * @returns `true` if the name is a valid lowercase token.
 * @public
 */
export function isValidHttpHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name);
}

/**
 * Resolves a numeric envelope type code to its string name.
 *
 * @param code - The numeric code from the envelope prefix.
 * @param envelopeTypes - The type map (e.g. `VERSER_ENVELOPE_TYPES`).
 * @returns The envelope type name (`'request'`, `'response'`, or `'error'`).
 * @throws {VerserError} With code `protocol-error` if the code is unknown.
 * @internal
 */
export function envelopeTypeNameFromCode(
  code: number,
  envelopeTypes: Record<string, number>,
): VerserEnvelopeTypeName {
  for (const [name, value] of Object.entries(envelopeTypes)) {
    if (value === code) {
      return name as VerserEnvelopeTypeName;
    }
  }

  throw createVerserError('protocol-error', 'Unknown envelope type', { envelopeType: code });
}

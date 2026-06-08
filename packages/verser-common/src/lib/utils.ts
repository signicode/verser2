import { createVerserError } from './errors';
import type { VerserEnvelopeTypeName } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireNonEmpty(value: string, label: string): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw createVerserError('invalid-registration', `${label} must not be empty`, {
      field: label,
    });
  }

  return normalizedValue;
}

export function requireValidStatusCode(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw createVerserError('protocol-error', 'HTTP status code must be between 100 and 599', {
      statusCode: value,
    });
  }

  return value;
}

export function isValidHttpHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name);
}

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

import {
  VERSER_RESPONSE_METADATA_MAX_BYTES,
  VERSER_RESPONSE_METADATA_MAX_HEADER_PAIRS,
  VERSER_RESPONSE_METADATA_VERSION,
} from './constants';
import { createVerserError } from './errors';
import {
  isValidHeaderName,
  isValidHeaderValue,
  normalizeHeaderPairs,
  sanitizeHttp2ResponseHeaderPairs,
  validateVerserStatusText,
} from './headers';
import type {
  VerserHeaderPair,
  VerserResponseClassification,
  VerserResponseMetadata,
  VerserSerializedHeaderMap,
} from './types';
import { requireFinalResponseStatusCode } from './utils';

/**
 * Flattens a header record where values may be strings or string arrays into
 * a `Record<string, string>` by joining array values with `,`.
 *
 * Used to prepare headers for inclusion in envelope metadata where each header
 * must be a single string.
 *
 * @param headers - Headers with string or string-array values.
 * @returns A flat record of header names to single string values.
 * @public
 */
export function flattenVerserHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  const flattenedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattenedHeaders[name] = typeof value === 'string' ? value : value.join(',');
  }

  return flattenedHeaders;
}

/**
 * Decodes a JSON-encoded header map string while preserving repeated string values.
 *
 * Used on the Host to parse the `x-verser-headers` request header that carries
 * the serialized header map from Brokers.
 *
 * @param value - JSON string encoding a header record.
 * @returns The decoded header record with own properties only.
 * @public
 */
export function decodeHeaderMap(value: string): VerserSerializedHeaderMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw protocolError('Invalid request header map JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw protocolError('Request header map must be an object');
  }
  const entries: [string, string | readonly string[]][] = [];
  for (const [name, rawValue] of Object.entries(parsed)) {
    if (!isValidHeaderName(name)) throw protocolError(`Invalid header name: ${name}`);
    if (typeof rawValue === 'string') {
      if (!isValidHeaderValue(rawValue)) throw protocolError(`Invalid header value for ${name}`);
      entries.push([name, rawValue]);
      continue;
    }
    if (
      !Array.isArray(rawValue) ||
      rawValue.length === 0 ||
      rawValue.some((entry) => typeof entry !== 'string' || !isValidHeaderValue(entry))
    ) {
      throw protocolError(`Invalid header value for ${name}`);
    }
    entries.push([name, rawValue]);
  }
  return Object.fromEntries(entries);
}

/** Projects repeated-safe header pairs into the legacy flat response header map. @public */
export function flattenVerserHeaderPairs(
  headerPairs: readonly VerserHeaderPair[],
): Record<string, string> {
  return Object.fromEntries(normalizeHeaderPairs(headerPairs));
}

/** Encodes version-1 application response metadata for the reserved HTTP/2 header. @public */
export function encodeVerserResponseMetadata(metadata: VerserResponseMetadata): string {
  const validated = validateResponseMetadata(metadata, true);
  const encoded = JSON.stringify(validated);
  assertMetadataByteLength(encoded);
  return encoded;
}

/** Strictly decodes version-1 application response metadata from the reserved HTTP/2 header. @public */
export function decodeVerserResponseMetadata(value: string): VerserResponseMetadata {
  if (typeof value !== 'string') throw protocolError('Response metadata must be a string');
  assertMetadataByteLength(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw protocolError('Invalid response metadata JSON');
  }
  return validateResponseMetadata(parsed, false);
}

/**
 * Classifies the final Host-to-Broker response using its outer status and optional
 * response metadata header values. Invalid present metadata always fails closed.
 *
 * @public
 */
export function classifyVerserResponseMetadata(
  outerStatusCode: number,
  expectedRequestId: string,
  metadataValues: readonly string[] | undefined,
): VerserResponseClassification {
  if (metadataValues === undefined || metadataValues.length === 0) {
    return outerStatusCode < 400 ? { type: 'application-response' } : { type: 'transport-error' };
  }
  if (metadataValues.length !== 1) throw protocolError('Response metadata header must occur once');
  const metadata = decodeVerserResponseMetadata(metadataValues[0]);
  if (metadata.requestId !== expectedRequestId)
    throw protocolError('Response metadata requestId mismatch');
  if (metadata.statusCode !== outerStatusCode)
    throw protocolError('Response metadata statusCode mismatch');
  return { type: 'application-response', metadata };
}

function validateResponseMetadata(value: unknown, sanitize: boolean): VerserResponseMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('Response metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(['version', 'requestId', 'statusCode', 'statusText', 'headers']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw protocolError('Response metadata has unknown fields');
  }
  if (record.version !== VERSER_RESPONSE_METADATA_VERSION) {
    throw protocolError('Unsupported response metadata version');
  }
  if (
    typeof record.requestId !== 'string' ||
    !isWellFormedUnicode(record.requestId) ||
    record.requestId.trim() === ''
  ) {
    throw protocolError('Response metadata requestId must be a non-empty string');
  }
  let statusCode: number;
  try {
    statusCode = requireFinalResponseStatusCode(record.statusCode as number);
  } catch {
    throw protocolError('Response metadata statusCode must be a final status (200-599)');
  }
  let statusText: string | undefined;
  if (record.statusText !== undefined) {
    if (typeof record.statusText !== 'string' || !isWellFormedUnicode(record.statusText)) {
      throw protocolError('Invalid response metadata status text');
    }
    try {
      statusText = validateVerserStatusText(record.statusText);
    } catch {
      throw protocolError('Invalid response metadata status text');
    }
  }
  if (
    !Array.isArray(record.headers) ||
    record.headers.length > VERSER_RESPONSE_METADATA_MAX_HEADER_PAIRS
  ) {
    throw protocolError('Invalid response metadata header pairs');
  }
  const rawPairs: VerserHeaderPair[] = record.headers.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string' ||
      !isWellFormedUnicode(pair[1])
    ) {
      throw protocolError('Invalid response metadata header pair');
    }
    return [pair[0], pair[1]];
  });
  let normalizedHeaders: VerserHeaderPair[];
  try {
    normalizedHeaders = normalizeHeaderPairs(rawPairs);
  } catch {
    throw protocolError('Invalid response metadata header pair');
  }
  const sanitizedHeaders = sanitizeHttp2ResponseHeaderPairs(normalizedHeaders);
  if (!sanitize && sanitizedHeaders.length !== normalizedHeaders.length) {
    throw protocolError('Response metadata contains forbidden header pair');
  }
  return {
    version: VERSER_RESPONSE_METADATA_VERSION,
    requestId: record.requestId,
    statusCode,
    ...(statusText === undefined ? {} : { statusText }),
    headers: sanitize ? sanitizedHeaders : normalizedHeaders,
  };
}

function assertMetadataByteLength(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > VERSER_RESPONSE_METADATA_MAX_BYTES) {
    throw protocolError('Response metadata exceeds maximum encoded bytes');
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function protocolError(message: string) {
  return createVerserError('protocol-error', message);
}

import type { Readable } from 'node:stream';

import {
  DEFAULT_MAX_ENVELOPE_METADATA_BYTES,
  VERSER_ENVELOPE_PREFIX_BYTES,
  VERSER_ENVELOPE_TYPES,
  VERSER_ENVELOPE_VERSION,
} from './constants';
import { createVerserError } from './errors';
import { readExactly } from './stream-readers';
import type {
  LeaseRequestMetadataReadOptions,
  LeaseResponseMetadataReadOptions,
  ParsedVerserEnvelope,
  VerserEnvelopeMetadata,
  VerserEnvelopeParserOptions,
  VerserEnvelopeStreamReadOptions,
  VerserEnvelopeToEncode,
  VerserEnvelopeTypeName,
  VerserErrorEnvelopeMetadata,
  VerserRequestEnvelopeMetadata,
  VerserResponseEnvelopeMetadata,
} from './types';
import { envelopeTypeNameFromCode, isRecord } from './utils';

export function encodeVerserEnvelope(envelope: VerserEnvelopeToEncode): Buffer {
  const envelopeType = VERSER_ENVELOPE_TYPES[envelope.type];
  const metadata = Buffer.from(JSON.stringify(envelope.metadata), 'utf8');
  const prefix = Buffer.alloc(VERSER_ENVELOPE_PREFIX_BYTES);
  prefix[0] = VERSER_ENVELOPE_VERSION;
  prefix[1] = envelopeType;
  prefix.writeUInt32BE(metadata.length, 2);
  return Buffer.concat([prefix, metadata]);
}

export function createVerserEnvelopeParser(options: VerserEnvelopeParserOptions = {}): {
  push(chunk: Buffer): ParsedVerserEnvelope | undefined;
} {
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_ENVELOPE_METADATA_BYTES;
  let buffered = Buffer.alloc(0);

  return {
    push(chunk: Buffer): ParsedVerserEnvelope | undefined {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < VERSER_ENVELOPE_PREFIX_BYTES) {
        return undefined;
      }

      const version = buffered[0];
      if (version !== VERSER_ENVELOPE_VERSION) {
        throw createVerserError('protocol-error', 'Invalid envelope version', { version });
      }

      const type = envelopeTypeNameFromCode(buffered[1], VERSER_ENVELOPE_TYPES);
      const metadataLength = buffered.readUInt32BE(2);
      if (metadataLength > maxMetadataBytes) {
        throw createVerserError('protocol-error', 'Envelope metadata length exceeds limit', {
          metadataLength,
          maxMetadataBytes,
        });
      }

      const metadataEnd = VERSER_ENVELOPE_PREFIX_BYTES + metadataLength;
      if (buffered.length < metadataEnd) {
        return undefined;
      }

      const metadataBytes = buffered.subarray(VERSER_ENVELOPE_PREFIX_BYTES, metadataEnd);
      const metadata = parseEnvelopeMetadata(metadataBytes, type);
      const bodyRemainder = buffered.subarray(metadataEnd);
      buffered = Buffer.alloc(0);

      return { type, metadata, bodyRemainder };
    },
  };
}

export async function readVerserEnvelopeFromStream(
  stream: Readable,
  options: VerserEnvelopeStreamReadOptions = {},
): Promise<ParsedVerserEnvelope> {
  const context = options.context ?? {};
  const parser = createVerserEnvelopeParser({ maxMetadataBytes: options.maxMetadataBytes });
  const prefix = await readExactly(stream, 2, context);
  const lengthBytes = await readExactly(stream, 4, context);
  const metadataLength = lengthBytes.readUInt32BE(0);
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_ENVELOPE_METADATA_BYTES;
  if (metadataLength > maxMetadataBytes) {
    throw createVerserError('protocol-error', 'Envelope metadata length exceeds limit', {
      ...context,
      metadataLength,
      maxMetadataBytes,
    });
  }
  const metadataBytes = await readExactly(stream, metadataLength, context);
  const parsed = parser.push(Buffer.concat([prefix, lengthBytes, metadataBytes]));

  if (parsed === undefined) {
    throw createVerserError('protocol-error', 'Lease stream metadata parser did not complete', {
      ...context,
    });
  }

  if (parsed.bodyRemainder.length > 0) {
    stream.unshift(parsed.bodyRemainder);
  }

  return parsed;
}

export async function readLeaseResponseMetadataFromStream(
  stream: Readable,
  options: LeaseResponseMetadataReadOptions,
): Promise<VerserResponseEnvelopeMetadata> {
  const parsed = await readVerserEnvelopeFromStream(stream, {
    maxMetadataBytes: options.maxMetadataBytes,
    context: { requestId: options.requestId, targetId: options.targetId },
  });

  if (parsed.type === 'response') {
    return parsed.metadata as VerserResponseEnvelopeMetadata;
  }

  if (parsed.type === 'error') {
    const errorMetadata = parsed.metadata as VerserErrorEnvelopeMetadata;
    throw createVerserError(
      errorMetadata.code === 'local-handler-failure' ? 'local-handler-failure' : 'protocol-error',
      errorMetadata.message,
      {
        targetId: options.targetId,
        requestId: options.requestId,
        ...(errorMetadata.context ?? {}),
      },
    );
  }

  throw createVerserError('protocol-error', 'Lease stream returned a non-response envelope', {
    targetId: options.targetId,
    requestId: options.requestId,
  });
}

export async function readLeaseRequestMetadataFromStream(
  stream: Readable,
  options: LeaseRequestMetadataReadOptions,
): Promise<VerserRequestEnvelopeMetadata> {
  const parsed = await readVerserEnvelopeFromStream(stream, {
    maxMetadataBytes: options.maxMetadataBytes,
    context: { guestId: options.guestId, leaseId: options.leaseId },
  });

  if (parsed.type === 'request') {
    return parsed.metadata as VerserRequestEnvelopeMetadata;
  }

  throw createVerserError('protocol-error', 'Lease stream received a non-request envelope', {
    guestId: options.guestId,
    leaseId: options.leaseId,
  });
}

function parseEnvelopeMetadata(
  metadataBytes: Buffer,
  type: VerserEnvelopeTypeName,
): VerserEnvelopeMetadata {
  try {
    const parsed: unknown = JSON.parse(metadataBytes.toString('utf8'));
    if (!isRecord(parsed)) {
      throw createVerserError('protocol-error', 'Envelope metadata must be a JSON object', {
        type,
      });
    }

    return parsed as unknown as VerserEnvelopeMetadata;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.name === 'VerserError') {
      throw error;
    }
    throw createVerserError('protocol-error', 'Invalid envelope metadata JSON', { type });
  }
}

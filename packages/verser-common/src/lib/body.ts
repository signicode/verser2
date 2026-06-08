import { Readable } from 'node:stream';

export function isIterableBody(value: unknown): value is Iterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.iterator in value;
}

export function isAsyncIterableBody(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
}

export function normalizeBrokerRequestBody(
  body: unknown,
): readonly Buffer[] | Readable | undefined {
  if (body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return [Buffer.from(body)];
  }

  if (Buffer.isBuffer(body)) {
    return [body];
  }

  if (body instanceof Uint8Array) {
    return [Buffer.from(body)];
  }

  if (body instanceof Readable) {
    return body;
  }

  if (isIterableBody(body) || isAsyncIterableBody(body)) {
    return Readable.from(body);
  }

  throw new Error('Verser Dispatcher does not support this request body type');
}

import { Readable } from 'node:stream';

/**
 * Checks whether a value is a synchronous iterable (has `Symbol.iterator`).
 *
 * @param value - The value to check.
 * @returns `true` if the value is an iterable (not null).
 * @public
 */
export function isIterableBody(value: unknown): value is Iterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.iterator in value;
}

/**
 * Checks whether a value is an async iterable (has `Symbol.asyncIterator`).
 *
 * @param value - The value to check.
 * @returns `true` if the value is an async iterable (not null).
 * @public
 */
export function isAsyncIterableBody(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
}

/**
 * Normalizes a Broker request body into a form suitable for transmission over HTTP/2.
 *
 * Supported input types:
 * - `null` → `undefined` (no body)
 * - `string` → `[Buffer.from(string)]`
 * - `Buffer` → `[buffer]`
 * - `Uint8Array` → `[Buffer.from(uint8)]`
 * - `Readable` → returned as-is (streamed)
 * - Iterable / async iterable → converted to a `Readable` via `Readable.from()`
 *
 * @param body - The raw request body.
 * @returns An array of buffers, a `Readable` stream, or `undefined` for a `null` body.
 * @throws {Error} If the body type is not supported.
 * @public
 */
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

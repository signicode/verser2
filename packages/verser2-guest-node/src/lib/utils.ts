import { Readable } from 'node:stream';

import type { VerserDispatchController } from './dispatch-controller';

export function toBrokerRequestBody(
  body: unknown,
  controller: VerserDispatchController,
): readonly Buffer[] | Readable | undefined {
  if (body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    const buffer = Buffer.from(body);
    controller.emitBodySent(buffer);
    controller.emitRequestSent();
    return [buffer];
  }
  if (Buffer.isBuffer(body)) {
    controller.emitBodySent(body);
    controller.emitRequestSent();
    return [body];
  }
  if (body instanceof Uint8Array) {
    const buffer = Buffer.from(body);
    controller.emitBodySent(buffer);
    controller.emitRequestSent();
    return [buffer];
  }
  if (body instanceof Readable) {
    body.on('data', (chunk: Buffer | string) => {
      controller.emitBodySent(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    body.once('end', () => controller.emitRequestSent());
    return body;
  }
  if (isIterableBody(body) || isAsyncIterableBody(body)) {
    const stream = Readable.from(body);
    stream.on('data', (chunk: Buffer | string | Uint8Array) => {
      controller.emitBodySent(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once('end', () => controller.emitRequestSent());
    return stream;
  }
  throw new Error('Verser Dispatcher does not support this request body type');
}

export function isIterableBody(value: unknown): value is Iterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.iterator in value;
}

export function isAsyncIterableBody(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
}

export function serializeHttpResponseHead(response: {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
}): Buffer {
  const headers = { ...response.headers };
  const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  return Buffer.from(`HTTP/1.1 ${response.statusCode} OK\r\n${headerLines.join('\r\n')}\r\n\r\n`);
}

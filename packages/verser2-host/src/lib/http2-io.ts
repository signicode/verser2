import type * as http2 from 'node:http2';
import { text as readStreamText } from 'node:stream/consumers';

import type { VerserError } from '@signicode/verser-common';
import { toErrorResponse } from './utils';

export function readRequestBody(stream: http2.ServerHttp2Stream): Promise<string> {
  return readStreamText(stream);
}

export function writeJsonLine(stream: http2.ServerHttp2Stream, value: unknown): void {
  if (!stream.headersSent) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
  }
  stream.write(`${JSON.stringify(value)}\n`);
}

export function sendJson(stream: http2.ServerHttp2Stream, value: unknown): void {
  if (!stream.headersSent) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
  }
  stream.end(JSON.stringify(value));
}

export function sendError(stream: http2.ServerHttp2Stream, error: VerserError): void {
  if (stream.closed || stream.destroyed) {
    return;
  }
  if (!stream.headersSent) {
    stream.respond({ ':status': 502, 'content-type': 'application/json' });
  }
  stream.end(JSON.stringify(toErrorResponse(error)));
}

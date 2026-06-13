import type * as http2 from 'node:http2';

import type { VerserError } from '@signicode/verser-common';
import { encodeJsonLine, toVerserHttpErrorResponse } from '@signicode/verser-common';

/**
 * Writes a JSON value as a newline-terminated JSON line to an HTTP/2 stream.
 *
 * If headers have not yet been sent, responds with a 200 status and
 * `application/json` content type before writing.
 *
 * Used for Broker route-control frames and registration responses.
 *
 * @param stream - The HTTP/2 server stream to write to.
 * @param value - The value to serialize as JSON and write.
 * @public
 */
export function writeJsonLine(stream: http2.ServerHttp2Stream, value: unknown): void {
  if (!stream.headersSent) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
  }
  stream.write(encodeJsonLine(value));
}

/**
 * Sends a serialized error response on an HTTP/2 stream.
 *
 * If the stream is not already closed or destroyed, responds with a 502 status
 * and a JSON body containing the {@link VerserHttpErrorResponse} representation
 * of the error.
 *
 * @param stream - The HTTP/2 server stream to write the error to.
 * @param error - The Verser error to serialize.
 * @public
 */
export function sendError(stream: http2.ServerHttp2Stream, error: VerserError): void {
  if (stream.closed || stream.destroyed) {
    return;
  }
  if (!stream.headersSent) {
    stream.respond({ ':status': 502, 'content-type': 'application/json' });
  }
  stream.end(JSON.stringify(toVerserHttpErrorResponse(error)));
}

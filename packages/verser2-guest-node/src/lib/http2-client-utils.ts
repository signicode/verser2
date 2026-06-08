import type { EventEmitter } from 'node:events';
import type * as http2 from 'node:http2';
import { buffer, text } from 'node:stream/consumers';
import { createVerserError } from '@signicode/verser-common';

export function readResponseBody(stream: http2.ClientHttp2Stream): Promise<Buffer> {
  return buffer(stream);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requestJson(
  session: http2.ClientHttp2Session,
  payload: Record<string, string | readonly string[]>,
  guestId: string,
): Promise<{ status?: string }> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    text(stream).then((body) => {
      try {
        resolve(JSON.parse(body) as { status?: string });
      } catch (error) {
        reject(
          createVerserError('protocol-error', 'Host returned invalid registration JSON', {
            guestId,
            cause: getErrorMessage(error),
          }),
        );
      }
    }, reject);
    stream.end(JSON.stringify(payload));
  });
}

export function once(emitter: EventEmitter, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, () => resolve());
    emitter.once('error', reject);
  });
}

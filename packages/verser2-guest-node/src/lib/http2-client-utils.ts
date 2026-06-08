import type { EventEmitter } from 'node:events';
import type * as http2 from 'node:http2';
import { buffer, text } from 'node:stream/consumers';
import {
  type VerserRegistrationResponse,
  parseRegistrationResponse,
} from '@signicode/verser-common';

export function readResponseBody(stream: http2.ClientHttp2Stream): Promise<Buffer> {
  return buffer(stream);
}

export function requestJson(
  session: http2.ClientHttp2Session,
  payload: Record<string, string | readonly string[]>,
  guestId: string,
): Promise<VerserRegistrationResponse> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    text(stream).then(
      (body) => {
        try {
          resolve(parseRegistrationResponse(body, guestId, 'guestId'));
        } catch (error) {
          reject(error);
        }
      },
      (error: unknown) => {
        reject(error);
      },
    );
    stream.end(JSON.stringify(payload));
  });
}

export function once(emitter: EventEmitter, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, () => resolve());
    emitter.once('error', reject);
  });
}

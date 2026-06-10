import { createVerserBunGuest } from '../src/index';

const hostUrl = process.env.VERSER_HOST_URL;
const guestId = process.env.VERSER_GUEST_ID;
const guestDomain = process.env.VERSER_GUEST_DOMAIN;
const tlsCaFile = process.env.VERSER_TLS_CA_FILE;

if (!hostUrl || !guestId || !guestDomain || !tlsCaFile) {
  throw new Error('Missing required Bun guest runtime env vars');
}

const guest = createVerserBunGuest({
  hostUrl,
  guestId,
  tls: {
    caFile: tlsCaFile,
  },
});

guest.attach(
  {
    fetch: async (request, server) => {
      const path = new URL(request.url).pathname;
      const input = request.headers.get('x-input') ?? '';

      if (path === '/upgrade') {
        return new Response(String(server.upgrade(request)), { status: 200 });
      }

      if (path === '/binary') {
        const requestPayload = Buffer.from(await request.arrayBuffer());
        const responseBody = Buffer.concat([
          Buffer.from([0x00, 0x01, 0x02, 0xff]),
          Buffer.from(`|${input}|`),
          requestPayload,
        ]);
        return new Response(responseBody, {
          status: 218,
          headers: {
            'content-type': 'application/octet-stream',
            'x-binary': 'true',
          },
        });
      }

      if (path === '/stream-response') {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('one'));
            queueMicrotask(() => {
              controller.enqueue(new TextEncoder().encode('two'));
              controller.close();
            });
          },
        });
        return new Response(stream, {
          status: 217,
          headers: {
            'content-type': 'text/plain',
          },
        });
      }

      const body = Buffer.from(await request.arrayBuffer());
      return new Response(`${request.method} ${path} ${input} ${body.toString()}`, {
        status: 214,
        headers: {
          'x-hosted': 'bun',
        },
      });
    },
  },
  guestDomain,
);

await guest.connect();

console.log('bun guest ready', JSON.stringify({ hostUrl, guestId, guestDomain }));

await new Promise<void>((resolve) => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});

await guest.close('runtime complete');

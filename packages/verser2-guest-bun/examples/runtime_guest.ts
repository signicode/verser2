import { Readable } from 'node:stream';
import { createVerserBroker, createVerserBunGuest } from '../src/index';
import type { VerserBunGuestOptions } from '../src/index';

const hostUrl = process.env.VERSER_HOST_URL;
const guestId = process.env.VERSER_GUEST_ID;
const guestDomain = process.env.VERSER_GUEST_DOMAIN;
const tlsCaFile = process.env.VERSER_TLS_CA_FILE;
const tlsCertFile = process.env.VERSER_TLS_CERT_FILE;
const tlsKeyFile = process.env.VERSER_TLS_KEY_FILE;
const tlsPfxFile = process.env.VERSER_TLS_PFX_FILE;
const tlsPassphrase = process.env.VERSER_TLS_PASSPHRASE;

if (!hostUrl || !guestId || !guestDomain || !tlsCaFile) {
  throw new Error('Missing required Bun guest runtime env vars');
}

const resolvedHostUrl = hostUrl;
const resolvedGuestId = guestId;
const resolvedGuestDomain = guestDomain;
const resolvedTlsCaFile = tlsCaFile;
const tlsOptions: NonNullable<VerserBunGuestOptions['tls']> = tlsPfxFile
  ? {
      caFile: resolvedTlsCaFile,
      pfxFile: tlsPfxFile,
      ...(tlsPassphrase ? { passphrase: tlsPassphrase } : {}),
    }
  : {
      caFile: resolvedTlsCaFile,
      ...(tlsCertFile ? { certFile: tlsCertFile } : {}),
      ...(tlsKeyFile ? { keyFile: tlsKeyFile } : {}),
      ...(tlsPassphrase ? { passphrase: tlsPassphrase } : {}),
    };

const guest = createVerserBunGuest({
  hostUrl: resolvedHostUrl,
  guestId: resolvedGuestId,
  tls: tlsOptions,
});

guest.attach(
  {
    routes: {
      '/status': new Response('ok', { status: 200 }),
      '/users/:id': (request) => new Response(`user:${request.params.id ?? ''}`),
      '/files/*': new Response('wildcard', { status: 200 }),
      '/items': {
        GET: new Response('read', { status: 200 }),
        POST: () => new Response('create', { status: 201 }),
      },
      '/response-json': Response.json({ ok: true }, { status: 200 }),
      '/response-iterable': async () => {
        const iterator = (async function* () {
          yield new TextEncoder().encode('one');
          yield new TextEncoder().encode('two');
        })();

        return new Response(iterator as unknown as BodyInit, {
          status: 219,
          headers: {
            'content-type': 'text/plain',
          },
        });
      },
      '/response-node-readable': () => {
        const stream = Readable.from([
          Buffer.from('node'),
          Buffer.from('-'),
          Buffer.from('readable'),
        ]);
        return new Response(stream as unknown as BodyInit, {
          status: 220,
          headers: {
            'content-type': 'text/plain',
          },
        });
      },
    },
    fetch: async (request, server) => {
      const requestUrl = new URL(request.url);
      const path = requestUrl.pathname;
      const input = request.headers.get('x-input') ?? '';
      const query = requestUrl.search;

      if (path === '/upgrade') {
        return new Response(String(server.upgrade(request)), { status: 200 });
      }

      if (path === '/status') {
        return new Response('fetched-status', { status: 200 });
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

      if (path === '/request-echo') {
        const requestBody = await request.text();
        return new Response(
          JSON.stringify({
            method: request.method,
            path,
            query,
            header: input,
            body: requestBody,
          }),
          {
            status: 222,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
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
  resolvedGuestDomain,
);

const bunBroker = createVerserBroker({
  hostUrl: resolvedHostUrl,
  brokerId: 'bun-runtime-self-check',
  tls: tlsOptions,
});

const selfCheckTimeoutMs = 15_000;

async function waitWithTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`Bun self-check timed out: ${label}`));
      }, timeoutMs),
    ),
  ]);
}

async function readResponseText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function closeRuntime(reason: string): Promise<void> {
  await Promise.all([guest.close(reason).catch(() => {}), bunBroker.close(reason).catch(() => {})]);
}

async function waitForGuestDomain(domain: string, timeoutMs: number): Promise<void> {
  await waitWithTimeout(
    bunBroker.waitForRoute(domain),
    `bun broker route ready for ${domain}`,
    timeoutMs,
  );
}

async function requestSelfCheckResponse(): Promise<string> {
  const selfCheckRequest = await waitWithTimeout(
    bunBroker.request({
      targetId: resolvedGuestId,
      method: 'GET',
      path: '/status',
    }),
    'bun broker request self-check',
    selfCheckTimeoutMs,
  );
  if (selfCheckRequest.statusCode !== 200) {
    throw new Error(`Bun broker request self-check failed status: ${selfCheckRequest.statusCode}`);
  }

  return await readResponseText(selfCheckRequest.body);
}

async function fetchSelfCheckResponse(domain: string): Promise<unknown> {
  const deadline = Date.now() + selfCheckTimeoutMs;
  let lastError: unknown;
  const routedFetch = bunBroker.createFetch();

  while (Date.now() < deadline) {
    try {
      const fetchResponse = await waitWithTimeout(
        routedFetch(new URL(`http://${domain}/response-json`)),
        'bun createFetch self-check',
        2_500,
      );
      if (fetchResponse.status !== 200) {
        throw new Error(`Bun createFetch self-check failed status: ${fetchResponse.status}`);
      }

      return await waitWithTimeout(fetchResponse.json(), 'bun createFetch body parse', 2_500);
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }

  throw new Error(`Bun createFetch self-check failed: ${String(lastError)}`);
}

try {
  await bunBroker.connect();
  await guest.connect();
  await waitForGuestDomain(resolvedGuestDomain, selfCheckTimeoutMs);
  if (process.env.VERSER_SELF_CHECK_DEBUG === '1') {
    const brokerRoutes = (
      bunBroker as { getRoutes?: () => unknown[] }
    )?.getRoutes?.() as unknown as unknown;
    console.log('bun broker routes at self-check', JSON.stringify(brokerRoutes));
  }

  {
    const selfCheckRequestText = await requestSelfCheckResponse();
    if (selfCheckRequestText !== 'ok') {
      throw new Error(
        `Bun broker request self-check failed with unexpected body: ${selfCheckRequestText}`,
      );
    }
  }

  {
    const fetchResponse = await fetchSelfCheckResponse(resolvedGuestDomain);
    const fetchBody = fetchResponse as {
      ok: unknown;
    };
    if (fetchBody?.ok !== true) {
      throw new Error(`Bun createFetch self-check failed body: ${JSON.stringify(fetchBody)}`);
    }
  }

  console.log('bun broker self-check ready');
  console.log(
    'bun guest ready',
    JSON.stringify({
      hostUrl: resolvedHostUrl,
      guestId: resolvedGuestId,
      guestDomain: resolvedGuestDomain,
    }),
  );

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
} finally {
  await closeRuntime('runtime complete');
}

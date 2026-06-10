const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadVerserGuestBun,
  loadVerserGuestNode,
  loadVerserHost,
} = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserBunGuest } = loadVerserGuestBun();
const { createVerserBroker } = loadVerserGuestNode();
const { createVerserHost } = loadVerserHost();

function createHost(options = {}) {
  return createVerserHost({
    ...options,
    tls: {
      cert: trusted.certificate,
      key: trusted.key,
      ...options.tls,
    },
  });
}

function createBroker(options) {
  return createVerserBroker({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

function createBunGuest(options) {
  return createVerserBunGuest({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function withTimeout(promise, label, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs),
    ),
  ]);
}

test('Host-routed requests reach a Bun fetch handler without opening a listener', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-bun-e2e' });
  const guest = createBunGuest({ hostUrl, guestId: 'guest-bun-e2e' });
  let requestedUrl;

  try {
    guest.attach(
      {
        fetch: async (request) => {
          requestedUrl = request.url;
          return new Response(`Bun handled ${request.method} ${new URL(request.url).pathname}`, {
            status: 207,
            headers: { 'x-bun-guest': request.headers.get('x-test') ?? '' },
          });
        },
      },
      'bun-e2e.local.test',
    );
    await broker.connect();
    await guest.connect();
    await withTimeout(broker.waitForRoute('bun-e2e.local.test'), 'bun route advertisement');

    const response = await broker.request({
      targetId: 'guest-bun-e2e',
      method: 'GET',
      path: '/bun?ok=1',
      headers: { 'x-test': 'yes' },
    });

    assert.equal(response.statusCode, 207);
    assert.equal(response.headers['x-bun-guest'], 'yes');
    assert.deepEqual(await readBody(response.body), Buffer.from('Bun handled GET /bun'));
    assert.equal(requestedUrl, 'http://bun-e2e.local.test/bun?ok=1');
    assert.equal(typeof guest.address, 'undefined');
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

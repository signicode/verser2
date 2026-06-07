const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { fetch } = require('../packages/verser2-guest-node/node_modules/undici');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');

function withTimeout(promise, label, timeoutMs = 5000) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function createConnectedRoute(domain, listener, ids) {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: ids.brokerId });
  const guest = createVerserNodeGuest({ hostUrl, guestId: ids.guestId });
  guest.attach(listener, domain);
  await withTimeout(broker.connect(), `${ids.brokerId} connect`);
  await withTimeout(guest.connect(), `${ids.guestId} connect`);
  await withTimeout(broker.waitForRoute(domain), `${domain} route`);
  return { host, broker, guest };
}

async function closeRoute(route) {
  await withTimeout(route.broker.close('test-complete'), 'broker close');
  await withTimeout(route.guest.close('test-complete'), 'guest close');
  await withTimeout(route.host.close('test-complete'), 'host close');
}

test('Broker exposes an Undici Dispatcher that routes fetch by advertised hostname', async () => {
  const route = await createConnectedRoute(
    'dispatcher.local.test',
    (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(208, { 'x-dispatcher': 'verser' });
        response.end(
          `${request.method} ${request.url} ${request.headers['x-input']} ${Buffer.concat(chunks).toString('utf8')}`,
        );
      });
    },
    { brokerId: 'broker-dispatcher-1', guestId: 'guest-dispatcher-1' },
  );

  try {
    const dispatcher = route.broker.createDispatcher();
    assert.equal(typeof dispatcher.dispatch, 'function');

    const response = await fetch('http://dispatcher.local.test/fetch-path?query=1', {
      method: 'POST',
      headers: { 'x-input': 'fetch' },
      body: 'payload',
      dispatcher,
    });

    assert.equal(response.status, 208);
    assert.equal(response.headers.get('x-dispatcher'), 'verser');
    assert.equal(await response.text(), 'POST /fetch-path?query=1 fetch payload');
  } finally {
    await closeRoute(route);
  }
});

test('Broker Dispatcher rejects fetch requests for non-advertised hostnames', async () => {
  const broker = createVerserBroker({
    hostUrl: 'https://localhost:1',
    brokerId: 'broker-dispatcher-missing-route',
  });
  const dispatcher = broker.createDispatcher();

  await assert.rejects(async () => {
    try {
      await fetch('http://not-advertised.local.test/', { dispatcher });
    } catch (error) {
      assert.match(error.cause.message, /No Verser route advertised/);
      throw error;
    }
  }, /fetch failed/);
});

test('Broker createFetch helper defaults fetch routing through the Broker dispatcher', async () => {
  const route = await createConnectedRoute(
    'helper.local.test',
    (_request, response) => {
      response.writeHead(202, { 'x-fetch-helper': 'verser' });
      response.end('helper-routed');
    },
    { brokerId: 'broker-fetch-helper-1', guestId: 'guest-fetch-helper-1' },
  );

  try {
    const routedFetch = route.broker.createFetch();
    const response = await routedFetch('http://helper.local.test/helper-path');

    assert.equal(response.status, 202);
    assert.equal(response.headers.get('x-fetch-helper'), 'verser');
    assert.equal(await response.text(), 'helper-routed');
  } finally {
    await closeRoute(route);
  }
});

test('Broker Dispatcher streams request bodies before the fetch body ends', async () => {
  const route = await createConnectedRoute(
    'dispatcher-stream-request.local.test',
    (request, response) => {
      request.once('data', (chunk) => response.end(Buffer.from(chunk)));
    },
    { brokerId: 'broker-dispatcher-stream-request', guestId: 'guest-dispatcher-stream-request' },
  );

  try {
    const body = new PassThrough();
    const responsePromise = fetch('http://dispatcher-stream-request.local.test/stream-request', {
      method: 'POST',
      body,
      duplex: 'half',
      dispatcher: route.broker.createDispatcher(),
    });
    body.write(Buffer.from('first'));

    const response = await withTimeout(
      responsePromise,
      'Dispatcher streamed request response',
      250,
    );
    assert.equal(await response.text(), 'first');
    body.end(Buffer.from('second'));
  } finally {
    await closeRoute(route);
  }
});

test('Broker Dispatcher streams response chunks through fetch bodies', async () => {
  const route = await createConnectedRoute(
    'dispatcher-stream-response.local.test',
    (_request, response) => {
      response.write(Buffer.from('first'));
      setTimeout(() => response.end(Buffer.from('second')), 100);
    },
    { brokerId: 'broker-dispatcher-stream-response', guestId: 'guest-dispatcher-stream-response' },
  );

  try {
    const response = await fetch('http://dispatcher-stream-response.local.test/stream-response', {
      dispatcher: route.broker.createDispatcher(),
    });
    const reader = response.body.getReader();
    const firstChunk = await withTimeout(reader.read(), 'first streamed response chunk', 50);
    assert.equal(Buffer.from(firstChunk.value).toString('utf8'), 'first');
    await reader.cancel();
  } finally {
    await closeRoute(route);
  }
});

test('Broker Dispatcher propagates fetch aborts without dangling response streams', async () => {
  const route = await createConnectedRoute(
    'dispatcher-abort.local.test',
    (_request, response) => {
      setTimeout(() => response.end('too-late'), 500);
    },
    { brokerId: 'broker-dispatcher-abort', guestId: 'guest-dispatcher-abort' },
  );

  try {
    const controller = new AbortController();
    const responsePromise = fetch('http://dispatcher-abort.local.test/abort', {
      signal: controller.signal,
      dispatcher: route.broker.createDispatcher(),
    });
    controller.abort();

    await assert.rejects(() => responsePromise, /abort/i);
  } finally {
    await closeRoute(route);
  }
});

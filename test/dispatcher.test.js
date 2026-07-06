const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { fetch } = require('undici');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');
const { trusted } = require('./support/tls-fixtures.cjs');

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

function createGuest(options) {
  return createVerserNodeGuest({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

function withTimeout(promise, label, timeoutMs = 5000) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function createConnectedRoute(domain, listener, ids) {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: ids.brokerId });
  const guest = createGuest({ hostUrl, guestId: ids.guestId });
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

test('Broker Dispatcher follows internal redirects for advertised route targets', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-dispatcher-redirect' });
  const redirectGuest = createGuest({ hostUrl, guestId: 'guest-dispatcher-redirect-a' });
  const targetGuest = createGuest({ hostUrl, guestId: 'guest-dispatcher-redirect-b' });
  redirectGuest.attach((_request, response) => {
    response.writeHead(307, { location: 'http://dispatcher-target.local.test/final?fetch=1' });
    response.end('redirecting');
  }, 'dispatcher-redirect.local.test');
  targetGuest.attach((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      response.writeHead(211, { 'x-dispatcher-redirect': request.url });
      response.end(`${request.method}:${Buffer.concat(chunks).toString('utf8')}`);
    });
  }, 'dispatcher-target.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-dispatcher-redirect connect');
    await withTimeout(redirectGuest.connect(), 'guest-dispatcher-redirect-a connect');
    await withTimeout(targetGuest.connect(), 'guest-dispatcher-redirect-b connect');
    await withTimeout(broker.waitForRoute('dispatcher-redirect.local.test'), 'redirect route');
    await withTimeout(broker.waitForRoute('dispatcher-target.local.test'), 'target route');

    const response = await fetch('http://dispatcher-redirect.local.test/start', {
      method: 'POST',
      body: 'payload',
      dispatcher: broker.createDispatcher(),
      redirect: 'manual',
    });

    assert.equal(response.status, 211);
    assert.equal(response.headers.get('x-dispatcher-redirect'), '/final?fetch=1');
    assert.equal(await response.text(), 'POST:payload');
  } finally {
    await withTimeout(broker.close('test-complete'), 'broker-dispatcher-redirect close');
    await withTimeout(redirectGuest.close('test-complete'), 'guest-dispatcher-redirect-a close');
    await withTimeout(targetGuest.close('test-complete'), 'guest-dispatcher-redirect-b close');
    await withTimeout(host.close('test-complete'), 'host-dispatcher-redirect close');
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

test('Broker createFetch leaves unadvertised internal redirects client-visible by default', async () => {
  const route = await createConnectedRoute(
    'fetch-redirect-fallback.local.test',
    (_request, response) => {
      response.writeHead(307, { location: 'http://not-advertised.local.test/final' });
      response.end('manual redirect');
    },
    { brokerId: 'broker-fetch-redirect-fallback', guestId: 'guest-fetch-redirect-fallback' },
  );

  try {
    const routedFetch = route.broker.createFetch();
    const response = await routedFetch('http://fetch-redirect-fallback.local.test/start');

    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), 'http://not-advertised.local.test/final');
    assert.equal(await response.text(), 'manual redirect');
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

// ================ Characterization: Slow Consumer Backpressure ================

test('Broker Dispatcher streams large response bodies with controlled backpressure', async () => {
  const route = await createConnectedRoute(
    'dispatcher-large-response.local.test',
    (_request, response) => {
      const chunkSize = 64 * 1024;
      const totalSize = 512 * 1024;
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let offset = 0; offset < totalSize; offset += chunkSize) {
        response.write(Buffer.alloc(chunkSize, 0x78));
      }
      response.end();
    },
    { brokerId: 'broker-dispatcher-large-response', guestId: 'guest-dispatcher-large-response' },
  );

  try {
    const response = await fetch('http://dispatcher-large-response.local.test/large', {
      dispatcher: route.broker.createDispatcher(),
    });
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
      // Simulate slow consumer — small delay every few chunks
      if (chunks.length % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(totalBytes, 512 * 1024);
    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    assert.equal(combined.length, 512 * 1024);
  } finally {
    await closeRoute(route);
  }
});

// ================ Characterization: Dispatcher Cancel During Streamed Response ================

test('Broker Dispatcher fetch cancellation during streamed response propagates to Guest-side lease stream', async () => {
  let requestEndResolve;
  const requestEnded = new Promise((resolve) => { requestEndResolve = resolve; });

  const route = await createConnectedRoute(
    'dispatcher-cancel-response.local.test',
    (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write(Buffer.from('first-chunk'));

      // Put the request stream in flowing mode so that buffered data is
      // consumed and the 'end' event can fire when the pipe completes.
      // Without resume(), the PassThrough buffers data and neither 'end'
      // nor 'close' fires even if the underlying source is destroyed.
      request.resume();

      request.once('end', requestEndResolve);
    },
    { brokerId: 'broker-dispatcher-cancel-response', guestId: 'guest-dispatcher-cancel-response' },
  );

  try {
    const response = await fetch('http://dispatcher-cancel-response.local.test/cancel', {
      dispatcher: route.broker.createDispatcher(),
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString('utf8'), 'first-chunk');

    // Cancel the reader — this sends RST_STREAM back through the Host,
    // which closes the Guest lease stream.  The pipe in MinimalIncomingMessage
    // detects the source 'close' and ends the PassThrough, which fires 'end'
    // on the handler's request object.
    await reader.cancel();

    await Promise.race([
      requestEnded,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Guest request stream did not end after fetch reader cancel')), 150),
      ),
    ]);
  } finally {
    await closeRoute(route);
  }
});

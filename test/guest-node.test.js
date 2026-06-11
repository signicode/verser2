const assert = require('node:assert/strict');
const http = require('node:http');
const http2 = require('node:http2');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const { createVerserNodeGuest } = require('../packages/verser2-guest-node/dist/index.js');
const { trusted } = require('./support/tls-fixtures.cjs');

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

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

function createGuest(options) {
  return createVerserNodeGuest({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

async function createLeaseTrackingHost() {
  const server = http2.createSecureServer({ cert: trusted.certificate, key: trusted.key });
  const leases = [];

  server.on('stream', (stream, headers) => {
    const path = String(headers[':path'] ?? '');
    if (path === '/verser/register') {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ status: 'registered', routes: [] }));
      return;
    }

    if (path === '/verser/guest/control') {
      stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
      return;
    }

    if (path === '/verser/guest/lease') {
      const lease = {
        stream,
        peerId: String(headers['x-verser-peer-id'] ?? ''),
        leaseId: String(headers['x-verser-lease-id'] ?? ''),
      };
      leases.push(lease);
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
      return;
    }

    stream.respond({ ':status': 404 });
    stream.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `https://127.0.0.1:${address.port}`,
    leases,
    async close() {
      for (const lease of leases) {
        lease.stream.close();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitForLeaseCount(leases, expectedCount) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (leases.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} leases; saw ${leases.length}`);
}

test('Node Guest connects outbound to Host and registers routed domains', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const events = [];
  let guest;

  try {
    guest = createGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'guest-node-1',
    });
    guest.onLifecycle((event) => events.push(event));
    assert.equal(
      guest.attach((_request, response) => response.end('ok'), 'node.local.test'),
      guest,
    );
    await guest.connect();
    await guest.connect();

    assert.equal(guest.connected, true);
    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'guest-node-1', domain: 'node.local.test' },
    ]);
  } finally {
    if (guest !== undefined) {
      await guest.close('test-complete');
      await guest.close('already-closed');
    }
    await host.close('test-complete');
  }

  assert.deepEqual(
    events.map((event) => event.name),
    ['connected', 'registered', 'disconnected', 'closed'],
  );
});

test('Node Guest dispatches a routed request to an attached request listener', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-2',
  });
  guest.attach((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.statusCode = 201;
      response.setHeader('x-guest', 'node');
      assert.equal(response.getHeader('x-guest'), 'node');
      response.write(`${request.method} `);
      assert.equal(
        response.end(`${request.method} ${request.url} ${request.headers['x-input']} ${body}`),
        response,
      );
    });
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-1',
    sourceId: 'broker-1',
    targetId: 'guest-node-2',
    method: 'POST',
    path: '/hello?name=verser',
    headers: { 'x-input': 'abc' },
    body: ['payload'],
  });

  assert.deepEqual(result, {
    requestId: 'req-node-1',
    statusCode: 201,
    headers: { 'x-guest': 'node' },
    body: Buffer.from('POST POST /hello?name=verser abc payload'),
  });
});

test('Node Guest uses the guest id as the automatic attach domain', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const guest = createGuest({
    hostUrl: `https://127.0.0.1:${host.address.port}`,
    guestId: 'guest-auto-domain',
  });

  try {
    guest.attach((_request, response) => response.end('ok'));
    await guest.connect();

    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'guest-auto-domain', domain: 'guest-auto-domain' },
    ]);
  } finally {
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Node Guest rejects invalid setup and missing handlers with contextual errors', async () => {
  assert.throws(() => createGuest({ hostUrl: 'https://localhost:1', guestId: '' }), /guest id/i);

  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-missing-handler',
  });

  const serverWithoutListener = http.createServer();
  assert.throws(() => guest.attach(serverWithoutListener), /no request listener/i);

  await assert.rejects(
    () =>
      guest.dispatchRoutedRequest({
        requestId: 'req-node-missing-handler',
        sourceId: 'broker-1',
        targetId: 'guest-node-missing-handler',
        method: 'GET',
        path: '/missing-handler',
        headers: {},
        body: [],
      }),
    (error) => {
      assert.equal(error.code, 'local-handler-failure');
      assert.equal(error.context.guestId, 'guest-node-missing-handler');
      return true;
    },
  );
});

test('Node Guest supports response writes before ending without a final chunk', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-write-only',
  });
  guest.attach((_request, response) => {
    response.write(Buffer.from('buffered'));
    response.end();
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-write-only',
    sourceId: 'broker-1',
    targetId: 'guest-node-write-only',
    method: 'GET',
    path: '/write-only',
    headers: {},
    body: [],
  });

  assert.deepEqual(result.body, Buffer.from('buffered'));
});

test('Node Guest preserves binary and encoded response chunks', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-binary',
  });
  guest.attach((_request, response) => {
    response.write(Buffer.from([0, 1, 2, 255]));
    response.end('6869', 'hex');
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-binary',
    sourceId: 'broker-1',
    targetId: 'guest-node-binary',
    method: 'GET',
    path: '/binary',
    headers: {},
    body: [],
  });

  assert.deepEqual(result.body, Buffer.from([0, 1, 2, 255, 104, 105]));
});

test('Node Guest rejects oversized buffered direct-dispatch responses', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-response-limit',
    maxResponseBytes: 4,
  });
  guest.attach((_request, response) => {
    response.write('abcd');
    response.end('e');
  });

  await assert.rejects(
    () =>
      guest.dispatchRoutedRequest({
        requestId: 'req-node-response-limit',
        sourceId: 'broker-1',
        targetId: 'guest-node-response-limit',
        method: 'GET',
        path: '/response-limit',
        headers: {},
        body: [],
      }),
    /response body bytes exceed limit/i,
  );
});

test('Node Guest maps failed Host registration to an actionable error', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const first = createGuest({
    hostUrl: `https://127.0.0.1:${host.address.port}`,
    guestId: 'duplicate-guest',
  });
  const duplicate = createGuest({
    hostUrl: `https://127.0.0.1:${host.address.port}`,
    guestId: 'duplicate-guest',
  });

  try {
    await first.connect();
    await assert.rejects(
      () => duplicate.connect(),
      (error) => {
        assert.equal(error.code, 'invalid-registration');
        assert.equal(error.context.guestId, 'duplicate-guest');
        return true;
      },
    );
  } finally {
    await duplicate.close('test-complete');
    await first.close('test-complete');
    await host.close('test-complete');
  }
});

test('Node Guest can attach an http.Server without listening', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(202, { 'x-server': 'attached' });
    response.end(request.url);
  });
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-3',
  });
  guest.attach(server);

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-2',
    sourceId: 'broker-1',
    targetId: 'guest-node-3',
    method: 'GET',
    path: '/server',
    headers: {},
    body: [],
  });

  assert.equal(server.listening, false);
  assert.equal(result.statusCode, 202);
  assert.equal(result.headers['x-server'], 'attached');
  assert.deepEqual(result.body, Buffer.from('/server'));
});

test('Node Guest maps invalid Host registration JSON to an actionable error', async () => {
  const server = http2.createSecureServer({ cert: trusted.certificate, key: trusted.key });
  server.on('stream', (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end('not-json');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const guest = createGuest({
    hostUrl: `https://127.0.0.1:${address.port}`,
    guestId: 'guest-bad-json',
  });

  try {
    await assert.rejects(
      () => guest.connect(),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(error.message, /invalid registration JSON/);
        assert.equal(error.context.guestId, 'guest-bad-json');
        return true;
      },
    );
  } finally {
    await guest.close('test-complete');
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Node Guest maps local handler failures to contextual errors and lifecycle events', async () => {
  const events = [];
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-4',
  });
  guest.onLifecycle((event) => events.push(event));
  guest.attach(() => {
    throw new Error('handler exploded');
  });

  await assert.rejects(
    () =>
      guest.dispatchRoutedRequest({
        requestId: 'req-node-3',
        sourceId: 'broker-1',
        targetId: 'guest-node-4',
        method: 'GET',
        path: '/boom',
        headers: {},
        body: [],
      }),
    (error) => {
      assert.equal(error.code, 'local-handler-failure');
      assert.match(error.message, /handler exploded/);
      assert.equal(error.context.requestId, 'req-node-3');
      return true;
    },
  );
  assert.deepEqual(
    events.map((event) => event.name),
    ['request-started', 'error'],
  );
});

test('Node Guest opens leases until minWaitingStreams is satisfied', async () => {
  const host = await createLeaseTrackingHost();
  const guest = createGuest({
    hostUrl: host.url,
    guestId: 'guest-lease-min',
    minWaitingStreams: 2,
    maxOpenStreams: 4,
  });

  try {
    await guest.connect();
    await waitForLeaseCount(host.leases, 2);

    assert.equal(host.leases.length, 2);
    assert.deepEqual(
      host.leases.map((lease) => lease.peerId),
      ['guest-lease-min', 'guest-lease-min'],
    );
    assert.equal(new Set(host.leases.map((lease) => lease.leaseId)).size, 2);
  } finally {
    await guest.close('test-complete');
    await host.close();
  }
});

test('Node Guest never exceeds maxOpenStreams while opening leases', async () => {
  const host = await createLeaseTrackingHost();
  const guest = createGuest({
    hostUrl: host.url,
    guestId: 'guest-lease-max',
    minWaitingStreams: 4,
    maxOpenStreams: 2,
  });

  try {
    await guest.connect();
    await waitForLeaseCount(host.leases, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(host.leases.length, 2);
  } finally {
    await guest.close('test-complete');
    await host.close();
  }
});

test('Node Guest replenishes leases after an idle lease closes', async () => {
  const host = await createLeaseTrackingHost();
  const guest = createGuest({
    hostUrl: host.url,
    guestId: 'guest-lease-replenish',
    minWaitingStreams: 2,
    maxOpenStreams: 2,
  });

  try {
    await guest.connect();
    await waitForLeaseCount(host.leases, 2);

    host.leases[0].stream.close();
    await waitForLeaseCount(host.leases, 3);

    assert.equal(host.leases.length, 3);
  } finally {
    await guest.close('test-complete');
    await host.close();
  }
});

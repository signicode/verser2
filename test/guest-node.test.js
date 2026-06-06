const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const { createVerserNodeGuest } = require('../packages/verser2-guest-node/dist/index.js');

test('Node Guest connects outbound to Host and registers routed domains', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const events = [];
  let guest;

  try {
    guest = createVerserNodeGuest({
      hostUrl: `https://localhost:${host.address.port}`,
      guestId: 'guest-node-1',
      routedDomains: ['node.local.test'],
    });
    guest.onLifecycle((event) => events.push(event));
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
  const guest = createVerserNodeGuest({
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
      response.end(`${request.method} ${request.url} ${request.headers['x-input']} ${body}`);
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
    body: 'POST POST /hello?name=verser abc payload',
  });
});

test('Node Guest rejects invalid setup and missing handlers with contextual errors', async () => {
  assert.throws(
    () => createVerserNodeGuest({ hostUrl: 'https://localhost:1', guestId: '' }),
    /guest id/i,
  );

  const guest = createVerserNodeGuest({
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
  const guest = createVerserNodeGuest({
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

  assert.equal(result.body, 'buffered');
});

test('Node Guest maps failed Host registration to an actionable error', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const first = createVerserNodeGuest({
    hostUrl: `https://localhost:${host.address.port}`,
    guestId: 'duplicate-guest',
  });
  const duplicate = createVerserNodeGuest({
    hostUrl: `https://localhost:${host.address.port}`,
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
  const guest = createVerserNodeGuest({
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
  assert.equal(result.body, '/server');
});

test('Node Guest maps local handler failures to contextual errors and lifecycle events', async () => {
  const events = [];
  const guest = createVerserNodeGuest({
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

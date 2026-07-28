const assert = require('node:assert/strict');
const http = require('node:http');
const http2 = require('node:http2');
const { PassThrough } = require('node:stream');
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
    headerPairs: [['x-guest', 'node']],
    body: Buffer.from('POST POST /hello?name=verser abc payload'),
  });
});

test('Node Guest preserves response status text and ordered repeated headers on direct dispatch', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-response-metadata',
  });
  guest.attach((_request, response) => {
    response.writeHead(218, 'Custom Status', {
      'set-cookie': ['first=1', 'second=2'],
      'x-repeat': ['one', 'two'],
      connection: 'x-removed',
      'x-removed': 'no',
      upgrade: 'websocket',
      'x-verser-response-metadata': 'spoofed',
    });
    assert.deepEqual(response.getHeader('set-cookie'), ['first=1', 'second=2']);
    response.appendHeader('x-repeat', 'three');
    response.end('ok');
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-response-metadata',
    sourceId: 'broker-1',
    targetId: 'guest-node-response-metadata',
    method: 'GET',
    path: '/metadata',
    headers: {},
    body: [],
  });

  assert.equal(result.statusText, 'Custom Status');
  assert.deepEqual(result.headerPairs, [
    ['set-cookie', 'first=1'],
    ['set-cookie', 'second=2'],
    ['x-repeat', 'one'],
    ['x-repeat', 'two'],
    ['x-repeat', 'three'],
  ]);
  assert.deepEqual(result.headers, { 'set-cookie': 'second=2', 'x-repeat': 'three' });
});

test('Node Guest preserves interleaved tuple response header order and replacement semantics', async () => {
  const guest = createGuest({ hostUrl: 'https://localhost:1', guestId: 'guest-node-tuple-order' });
  guest.attach((_request, response) => {
    response.setHeader('x-replaced', 'old');
    response.writeHead(200, [
      ['set-cookie', 'a=1'],
      ['x-between', 'value'],
      ['set-cookie', 'b=2'],
      ['x-replaced', 'new'],
    ]);
    response.appendHeader('set-cookie', 'c=3');
    assert.deepEqual(response.getHeader('set-cookie'), ['a=1', 'b=2', 'c=3']);
    assert.equal(response.getHeader('x-replaced'), 'new');
    response.end();
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-tuple-order',
    sourceId: 'broker-1',
    targetId: 'guest-node-tuple-order',
    method: 'GET',
    path: '/',
    headers: {},
    body: [],
  });

  assert.deepEqual(result.headerPairs, [
    ['set-cookie', 'a=1'],
    ['x-between', 'value'],
    ['set-cookie', 'b=2'],
    ['x-replaced', 'new'],
    ['set-cookie', 'c=3'],
  ]);
  assert.deepEqual(result.headers, {
    'set-cookie': 'c=3',
    'x-between': 'value',
    'x-replaced': 'new',
  });
});

test('Node Guest response shim validates mutations promptly and preserves state on rejected writeHead input', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-response-validation',
  });
  guest.attach((_request, response) => {
    response.setHeader('x-kept', 'before');
    assert.throws(() => response.setHeader('bad\nname', 'value'), {
      code: 'ERR_INVALID_HTTP_TOKEN',
    });
    assert.throws(() => response.appendHeader('x-invalid', 'bad\nvalue'), {
      code: 'ERR_INVALID_CHAR',
    });
    assert.throws(() => response.writeHead(199, 'Invalid', { 'x-new': 'value' }), {
      code: 'protocol-error',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.statusMessage, undefined);
    assert.equal(response.getHeader('x-kept'), 'before');
    assert.equal(response.getHeader('x-new'), undefined);
    response.end('ok');
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-node-response-validation',
    sourceId: 'broker-1',
    targetId: 'guest-node-response-validation',
    method: 'GET',
    path: '/',
    headers: {},
    body: [],
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.headers, { 'x-kept': 'before' });
  assert.deepEqual(result.body, Buffer.from('ok'));
});

test('Node Guest rejects direct invalid response metadata before sending a lease response envelope', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let localBroker;
  try {
    guest = createGuest({ hostUrl, guestId: 'guest-invalid-lease-response' });
    guest.attach((_request, response) => {
      response.statusCode = 199;
      response.end('must not be sent');
    }, 'invalid-lease-response.local.test');
    localBroker = await host.attachLocalBroker({ brokerId: 'invalid-lease-response-broker' });
    await guest.connect();
    await localBroker.waitForRoute('invalid-lease-response.local.test');

    await assert.rejects(
      () =>
        localBroker.request({
          targetId: 'guest-invalid-lease-response',
          method: 'GET',
          path: '/',
        }),
      (error) => error.code === 'protocol-error',
    );
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Node Guest keeps omitted and explicit empty response status text distinct', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-empty-status-text',
  });
  guest.attach((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const omitted = await guest.dispatchRoutedRequest({
    requestId: 'req-node-status-omitted',
    sourceId: 'broker-1',
    targetId: 'guest-node-empty-status-text',
    method: 'GET',
    path: '/',
    headers: {},
    body: [],
  });
  assert.equal(omitted.statusText, undefined);

  guest.attach((_request, response) => {
    response.writeHead(204, '');
    response.end();
  });
  const empty = await guest.dispatchRoutedRequest({
    requestId: 'req-node-status-empty',
    sourceId: 'broker-1',
    targetId: 'guest-node-empty-status-text',
    method: 'GET',
    path: '/',
    headers: {},
    body: [],
  });
  assert.equal(empty.statusText, '');
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
    await host.close();
  }
});

test('Node Guest direct dispatch succeeds when handler calls flushHeaders before end', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-flush-headers',
  });
  guest.attach((request, response) => {
    response.writeHead(202, { 'x-flush': 'called' });
    response.flushHeaders();
    response.end('body');
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-flush-headers',
    sourceId: 'broker-1',
    targetId: 'guest-node-flush-headers',
    method: 'GET',
    path: '/flush-headers',
    headers: {},
    body: [],
  });

  assert.equal(result.statusCode, 202);
  assert.equal(result.headers['x-flush'], 'called');
  assert.deepEqual(result.body, Buffer.from('body'));
});

test('Node Guest flushHeaders works through streaming lease path with early header delivery', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let localBroker;

  try {
    let headersResolve;
    const headersCommitted = new Promise((resolve) => {
      headersResolve = resolve;
    });

    guest = createGuest({ hostUrl, guestId: 'guest-stream-flush' });
    guest.attach((request, response) => {
      response.writeHead(208, 'Lease Status', { 'x-stream-flush': ['yes', 'again'] });
      response.flushHeaders();
      headersResolve();
      request.on('end', () => {
        response.end('streamed-body');
      });
      request.resume();
    }, 'stream-flush.local.test');

    localBroker = await host.attachLocalBroker({ brokerId: 'node-stream-flush-broker' });
    await guest.connect();
    await localBroker.waitForRoute('stream-flush.local.test');

    // Use a controlled PassThrough body that is NOT ended yet
    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'guest-stream-flush',
      method: 'POST',
      path: '/stream-flush',
      headers: { 'content-type': 'text/plain' },
      body,
    });

    // Wait until the handler has called writeHead + flushHeaders
    await headersCommitted;

    // Response promise should resolve with headers BEFORE the request body is ended
    const response = await responsePromise;
    assert.equal(response.statusCode, 208);
    assert.equal(response.headers['x-stream-flush'], 'again');
    assert.equal(response.statusText, 'Lease Status');
    assert.deepEqual(response.headerPairs, [
      ['x-stream-flush', 'yes'],
      ['x-stream-flush', 'again'],
    ]);

    // Now end the request body — the handler will receive 'end' and call response.end()
    body.end(Buffer.from('trigger'));
    assert.deepEqual(await readBody(response.body), Buffer.from('streamed-body'));
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function settlesWithoutProcessFault(operation) {
  const faults = [];
  const onUncaught = (error) => faults.push(error);
  const onUnhandled = (reason) => faults.push(reason);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Timed out waiting for routed request to settle')),
      1000,
    );
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timeoutId);
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(faults, []);
  }
}

test('Node Guest direct dispatch turns asynchronous commit validation failures into protocol errors', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-async-direct-error',
  });
  guest.attach((_request, response) => {
    setImmediate(() => {
      response.statusCode = 199;
      response.end('must not be sent');
    });
  });

  await assert.rejects(
    () =>
      settlesWithoutProcessFault(() =>
        guest.dispatchRoutedRequest({
          requestId: 'async-direct-error',
          sourceId: 'broker',
          targetId: 'guest-async-direct-error',
          method: 'GET',
          path: '/',
          headers: {},
          body: [],
        }),
      ),
    (error) => error.code === 'protocol-error',
  );
});

test('Node Guest writeHead retains headers when status text is explicitly undefined', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-write-head-undefined',
  });
  guest.attach((_request, response) =>
    response.writeHead(201, undefined, { 'x-test': 'yes' }).end(),
  );
  const response = await guest.dispatchRoutedRequest({
    requestId: 'write-head-undefined',
    sourceId: 'broker',
    targetId: 'guest-write-head-undefined',
    method: 'GET',
    path: '/',
    headers: {},
    body: [],
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.statusText, undefined);
  assert.equal(response.headers['x-test'], 'yes');
});

test('Node Guest lease routing returns asynchronous commit validation failures as protocol errors', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let guest;
  let broker;
  try {
    guest = createGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'guest-async-lease-error',
    });
    guest.attach(
      (_request, response) =>
        setImmediate(() => {
          response.statusMessage = 'not\nvalid';
          response.flushHeaders();
        }),
      'async-lease-error.test',
    );
    broker = await host.attachLocalBroker({ brokerId: 'async-lease-error-broker' });
    await guest.connect();
    await broker.waitForRoute('async-lease-error.test');
    await assert.rejects(
      () =>
        settlesWithoutProcessFault(() =>
          broker.request({ targetId: 'guest-async-lease-error', method: 'GET', path: '/' }),
        ),
      (error) => error.code === 'protocol-error',
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
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
    assert.equal(request.url, '/server');
    response.writeHead(202, { 'x-server': 'attached' });
    response.end('/server');
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

test('Node Guest strips hop-by-hop response headers from direct dispatch', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-strip-hop',
  });
  guest.attach((_request, response) => {
    response.setHeader('transfer-encoding', 'chunked');
    response.setHeader('connection', 'close');
    response.setHeader('x-custom', 'preserved');
    response.end('ok');
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-strip-hop',
    sourceId: 'broker-1',
    targetId: 'guest-node-strip-hop',
    method: 'GET',
    path: '/strip-hop',
    headers: {},
    body: [],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['x-custom'], 'preserved');
  assert.equal(result.headers['transfer-encoding'], undefined);
  assert.equal(result.headers.connection, undefined);
});

test('Node Guest strips connection-listed extension headers from direct dispatch', async () => {
  const guest = createGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'guest-node-strip-connection',
  });
  guest.attach((_request, response) => {
    response.setHeader('connection', 'x-keep');
    response.setHeader('x-keep', 'should-be-stripped');
    response.setHeader('x-normal', 'kept');
    response.end('ok');
  });

  const result = await guest.dispatchRoutedRequest({
    requestId: 'req-strip-connection',
    sourceId: 'broker-1',
    targetId: 'guest-node-strip-connection',
    method: 'GET',
    path: '/strip-connection',
    headers: {},
    body: [],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['x-normal'], 'kept');
  assert.equal(result.headers['x-keep'], undefined);
  assert.equal(result.headers.connection, undefined);
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

const assert = require('node:assert/strict');
const http = require('node:http');
const http2 = require('node:http2');
const { PassThrough } = require('node:stream');
const test = require('node:test');

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

function once(emitter, eventName) {
  return new Promise((resolve) => emitter.once(eventName, resolve));
}

async function connectClient(port) {
  const session = http2.connect(`https://127.0.0.1:${port}`, { ca: trusted.certificate });
  await once(session, 'connect');
  return session;
}

function requestJson(session, payload, path = '/verser/register') {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': path });
    let body = '';

    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      body += chunk;
    });
    stream.on('end', () => {
      resolve(body.length === 0 ? undefined : JSON.parse(body));
    });
    stream.on('error', reject);
    stream.end(JSON.stringify(payload));
  });
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function readNextChunk(stream) {
  const existing = stream.read();
  if (existing !== null) {
    return Buffer.from(existing);
  }

  return new Promise((resolve, reject) => {
    stream.once('data', (chunk) => resolve(Buffer.from(chunk)));
    stream.once('error', reject);
  });
}

async function waitForRoutes(peer, expectedRoutes) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (JSON.stringify(peer.getRoutes()) === JSON.stringify(expectedRoutes)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(peer.getRoutes(), expectedRoutes);
}

test('Host attaches local Guests and Brokers with route advertisement, degradation, and retraction', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 50 });
  const events = [];
  host.onLifecycle((event) => events.push(event));

  await host.start();
  let localBroker;
  let localGuest;

  try {
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-registration-1' });
    assert.deepEqual(localBroker.getRoutes(), []);

    localGuest = await host.attachLocalGuest({
      guestId: 'local-guest-registration-1',
      routedDomains: ['local-registration.local.test'],
      listener: (_request, response) => response.end('ok'),
    });

    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'local-guest-registration-1', domain: 'local-registration.local.test' },
    ]);
    await localBroker.waitForRoute('local-registration.local.test');

    // Close the guest — routes go degraded (still visible until timeout)
    await localGuest.close('test-detach');

    // Routes are still visible in degraded state
    assert.ok(
      host
        .getRoutedDomains()
        .some(
          (r) =>
            r.targetId === 'local-guest-registration-1' &&
            r.domain === 'local-registration.local.test',
        ),
    );

    // Wait for degraded route timeout
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(host.getRoutedDomains(), []);
    await waitForRoutes(localBroker, []);

    const eventNames = events.map((event) => event.name);
    assert.ok(eventNames.includes('connected'));
    assert.ok(eventNames.includes('registered'));
    assert.ok(eventNames.includes('route-advertised'));
    assert.ok(eventNames.includes('disconnected'));
  } finally {
    if (localGuest !== undefined) await localGuest.close('test-complete');
    if (localBroker !== undefined) await localBroker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host rejects duplicate peer ids across local and HTTP/2 peers', async () => {
  const host = createHost({ port: 0 });

  await host.start();
  const h2Guest = await connectClient(host.address.port);
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'duplicate-local-peer',
      routedDomains: ['duplicate-local.local.test'],
      listener: (_request, response) => response.end('ok'),
    });

    const duplicateH2Response = await requestJson(h2Guest, {
      peerId: 'duplicate-local-peer',
      role: 'guest',
      routedDomains: ['duplicate-h2.local.test'],
    });
    assert.equal(duplicateH2Response.error.code, 'invalid-registration');

    await assert.rejects(
      () => host.attachLocalBroker({ brokerId: 'duplicate-local-peer' }),
      (error) => {
        assert.equal(error.code, 'invalid-registration');
        assert.equal(error.context.peerId, 'duplicate-local-peer');
        return true;
      },
    );
  } finally {
    if (localGuest !== undefined) await localGuest.close('test-complete');
    h2Guest.close();
    await host.close('test-complete');
  }
});

test('Local Guest revokes a subset of its route domains', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'revoke-subset-guest',
      routedDomains: ['keep.test', 'remove.test', 'also-keep.test'],
      listener: (_request, response) => response.end('ok'),
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'revoke-subset-broker' });
    await localBroker.waitForRoute('remove.test');

    // Revoke one existing domain and one non-existent domain
    const result = localGuest.revokeRoutes(['remove.test', 'nonexistent.test']);
    assert.deepEqual(result.revoked, ['remove.test']);
    assert.deepEqual(result.notFound, ['nonexistent.test']);

    // Verify route table updated (order-independent)
    const remainingDomains = host
      .getRoutedDomains()
      .filter((r) => r.targetId === 'revoke-subset-guest')
      .map((r) => r.domain)
      .sort();
    assert.deepEqual(remainingDomains, ['also-keep.test', 'keep.test']);

    // Local broker routes should also be updated (order-independent)
    const brokerDomains = localBroker
      .getRoutes()
      .filter((r) => r.targetId === 'revoke-subset-guest')
      .map((r) => r.domain)
      .sort();
    assert.deepEqual(brokerDomains, ['also-keep.test', 'keep.test']);
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Guest revokeRoutes on a closed handle returns empty result', async () => {
  const host = createHost({ port: 0 });
  await host.start();

  try {
    const localGuest = await host.attachLocalGuest({
      guestId: 'revoke-closed-guest',
      routedDomains: ['closed.test'],
      listener: (_request, response) => response.end('ok'),
    });
    await localGuest.close('test-close');
    const result = localGuest.revokeRoutes(['closed.test']);
    assert.deepEqual(result, { revoked: [], notFound: ['closed.test'] });
  } finally {
    await host.close('test-complete');
  }
});

test('Local Broker receives route-change events for route addition and revocation', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    const changes = [];
    localBroker = await host.attachLocalBroker({ brokerId: 'lifecycle-broker-1' });
    localBroker.onRouteChange((event) => changes.push(event));

    localGuest = await host.attachLocalGuest({
      guestId: 'lifecycle-guest-1',
      routedDomains: ['lifecycle-1.test'],
      listener: (_request, response) => response.end('ok'),
    });
    await localBroker.waitForRoute('lifecycle-1.test');

    // Should have received 'added' event
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'added');
    assert.equal(changes[0].targetId, 'lifecycle-guest-1');
    assert.equal(changes[0].domain, 'lifecycle-1.test');
    assert.equal(changes[0].reason, 'registered');

    // Clear and revoke
    changes.length = 0;
    localGuest.revokeRoutes(['lifecycle-1.test']);

    // Should have received 'removed' event with revocation reason
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'removed');
    assert.equal(changes[0].targetId, 'lifecycle-guest-1');
    assert.equal(changes[0].domain, 'lifecycle-1.test');
    assert.equal(changes[0].reason, 'revoked');
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker route-change events include degraded state and timeout removal', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 50 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'degrade-lifecycle-guest',
      routedDomains: ['degrade-lifecycle.test'],
      listener: (_request, response) => response.end('ok'),
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'degrade-lifecycle-broker' });
    await localBroker.waitForRoute('degrade-lifecycle.test');

    const changes = [];
    localBroker.onRouteChange((event) => changes.push(event));

    // Close the guest — routes should degrade
    await localGuest.close('test-close');

    // Verify 'degraded' event was received
    const degradedEvents = changes.filter((e) => e.type === 'degraded');
    assert.equal(degradedEvents.length, 1);
    assert.equal(degradedEvents[0].domain, 'degrade-lifecycle.test');
    assert.equal(degradedEvents[0].targetId, 'degrade-lifecycle-guest');
    assert.equal(degradedEvents[0].reason, 'disconnected');

    // Routes should still be visible (degraded)
    assert.equal(host.getRoutedDomains().length >= 1, true);
    assert.ok(host.getRoutedDomains().some((r) => r.domain === 'degrade-lifecycle.test'));

    // Wait for timeout to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Routes should now be fully removed
    assert.equal(
      host.getRoutedDomains().filter((r) => r.targetId === 'degrade-lifecycle-guest').length,
      0,
    );

    // Should have received 'removed' event with 'timeout' reason
    const removedEvents = changes.filter((e) => e.type === 'removed');
    assert.equal(removedEvents.length, 1);
    assert.equal(removedEvents[0].domain, 'degrade-lifecycle.test');
    assert.equal(removedEvents[0].reason, 'timeout');
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker does not expose revokeRoutes', async () => {
  const host = createHost({ port: 0 });
  await host.start();

  try {
    const localBroker = await host.attachLocalBroker({ brokerId: 'no-revoke-broker' });
    assert.equal(typeof localBroker.revokeRoutes, 'undefined');
    await localBroker.close('test-complete');
  } finally {
    await host.close('test-complete');
  }
});

test('Local Broker onRouteChange unsubscription works', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    const changes = [];
    localBroker = await host.attachLocalBroker({ brokerId: 'unsub-broker' });
    const unsubscribe = localBroker.onRouteChange((event) => changes.push(event));

    localGuest = await host.attachLocalGuest({
      guestId: 'unsub-guest',
      routedDomains: ['unsub.test'],
      listener: (_request, response) => response.end('ok'),
    });
    await localBroker.waitForRoute('unsub.test');

    assert.equal(changes.length, 1);

    // Unsubscribe and revoke — the listener should not receive events
    unsubscribe();
    changes.length = 0;
    localGuest.revokeRoutes(['unsub.test']);
    assert.equal(changes.length, 0);
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Guest flushHeaders commits headers before body is written', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    let headersResolve;
    const headersCommitted = new Promise((resolve) => {
      headersResolve = resolve;
    });

    localGuest = await host.attachLocalGuest({
      guestId: 'local-guest-flush-1',
      routedDomains: ['local-flush.local.test'],
      listener: (request, response) => {
        response.writeHead(201, { 'x-flushed': 'yes' });
        response.flushHeaders();
        headersResolve();
        request.on('end', () => {
          response.end('body-after-flush');
        });
        request.resume();
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-flush-1' });
    await localBroker.waitForRoute('local-flush.local.test');

    // Use a controlled PassThrough body that is NOT ended yet
    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'local-guest-flush-1',
      method: 'POST',
      path: '/flush',
      headers: { 'content-type': 'text/plain' },
      body,
    });

    // Wait until the handler has called writeHead + flushHeaders
    await headersCommitted;

    // Response promise should resolve with headers BEFORE the request body is ended
    const response = await responsePromise;
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['x-flushed'], 'yes');

    // Now end the request body — the handler will receive 'end' and call response.end()
    body.end(Buffer.from('trigger'));
    assert.deepEqual(await readBody(response.body), Buffer.from('body-after-flush'));
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Guest flushHeaders without subsequent body end still completes', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-guest-flush-2',
      routedDomains: ['local-flush-no-body.local.test'],
      listener: (request, response) => {
        response.writeHead(204, { 'x-flush-only': 'true' });
        response.flushHeaders();
        response.end();
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-flush-2' });
    await localBroker.waitForRoute('local-flush-no-body.local.test');

    const response = await localBroker.request({
      targetId: 'local-guest-flush-2',
      method: 'GET',
      path: '/flush-no-body',
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['x-flush-only'], 'true');
    const body = await readBody(response.body);
    assert.equal(body.length, 0);
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host authorizes local peer registration with Host-owned local metadata', async () => {
  const contexts = [];
  const host = createHost({
    port: 0,
    tls: {
      clientAuth: {
        authorizeRegistration(context) {
          contexts.push(context);
          return { action: 'allow' };
        },
      },
    },
  });

  await host.start();
  let localGuest;
  let localBroker;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-authorized-guest',
      routedDomains: ['local-authorized.local.test'],
      certificate: { commonName: 'caller-supplied' },
      metadata: { authorized: false, local: false },
      listener: (_request, response) => response.end('ok'),
    });
    localBroker = await host.attachLocalBroker({
      brokerId: 'local-authorized-broker',
      certificate: { commonName: 'caller-supplied' },
      metadata: { authorized: false, local: false },
    });

    assert.equal(contexts.length, 2);
    assert.equal(contexts[0].certificate, undefined);
    assert.deepEqual(contexts[0].metadata, { local: true, authorized: true });
    assert.equal(contexts[1].certificate, undefined);
    assert.deepEqual(contexts[1].metadata, { local: true, authorized: true });
  } finally {
    if (localGuest !== undefined) await localGuest.close('test-complete');
    if (localBroker !== undefined) await localBroker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host attaches local Guests from an http.Server request listener without listening', async () => {
  const host = createHost({ port: 0 });
  const server = http.createServer((request, response) => {
    response.writeHead(204, { 'x-local-server': request.url });
    response.end();
  });

  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-http-server-guest',
      routedDomains: ['local-http-server.local.test'],
      listener: server,
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-http-server-broker' });
    await localBroker.waitForRoute('local-http-server.local.test');

    const response = await localBroker.request({
      targetId: 'local-http-server-guest',
      method: 'GET',
      path: '/server-listener',
    });

    assert.equal(server.listening, false);
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['x-local-server'], '/server-listener');
  } finally {
    if (localGuest !== undefined) await localGuest.close('test-complete');
    if (localBroker !== undefined) await localBroker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host rejects local registration when authorization closes the peer', async () => {
  const host = createHost({
    port: 0,
    tls: {
      clientAuth: {
        authorizeRegistration() {
          return { action: 'close', reason: 'local peers disabled' };
        },
      },
    },
  });

  await host.start();

  try {
    await assert.rejects(
      () =>
        host.attachLocalGuest({
          guestId: 'local-rejected-guest',
          routedDomains: ['local-rejected.local.test'],
          listener: (_request, response) => response.end('ok'),
        }),
      (error) => {
        assert.equal(error.code, 'invalid-registration');
        assert.match(error.message, /local peers disabled/);
        return true;
      },
    );
    assert.deepEqual(host.getRoutedDomains(), []);
  } finally {
    await host.close('test-complete');
  }
});

test('Local Broker routes to a local Guest through Host state with HTTP semantics preserved', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-guest-routing-1',
      routedDomains: ['local-routing.local.test'],
      listener: (request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          response.writeHead(207, {
            'x-local-method': request.method,
            'x-local-path': request.url,
            'x-local-input': request.headers['x-input'],
          });
          response.end(Buffer.concat(chunks));
        });
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-routing-1' });
    await localBroker.waitForRoute('local-routing.local.test');

    const response = await localBroker.request({
      targetId: 'local-guest-routing-1',
      method: 'POST',
      path: '/local/echo?ok=1',
      headers: { 'x-input': 'abc' },
      body: [Buffer.from('first'), Buffer.from('second')],
    });

    assert.equal(response.statusCode, 207);
    assert.equal(response.headers['x-local-method'], 'POST');
    assert.equal(response.headers['x-local-path'], '/local/echo?ok=1');
    assert.equal(response.headers['x-local-input'], 'abc');
    assert.deepEqual(await readBody(response.body), Buffer.from('firstsecond'));
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker routes to an HTTP/2 Guest through Host target checks', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let localBroker;

  try {
    guest = createGuest({ hostUrl, guestId: 'h2-guest-local-broker-1' });
    guest.attach((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(202, { 'x-interop': 'local-to-h2' });
        response.end(Buffer.concat(chunks));
      });
    }, 'local-to-h2.local.test');
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-to-h2-1' });

    await guest.connect();
    await localBroker.waitForRoute('local-to-h2.local.test');

    const response = await localBroker.request({
      targetId: 'h2-guest-local-broker-1',
      method: 'PUT',
      path: '/interop',
      body: [Buffer.from('h2-body')],
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.headers['x-interop'], 'local-to-h2');
    assert.deepEqual(await readBody(response.body), Buffer.from('h2-body'));
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker rejected onRouteChange listener does not break subsequent listeners or route snapshots', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    const goodEvents = [];
    localBroker = await host.attachLocalBroker({ brokerId: 'local-throwing-broker' });

    // Register a rejecting listener first, then a good listener. EventEmitter
    // captureRejections should route this to the internal error handler without
    // disrupting local route state updates or subsequent listeners.
    localBroker.onRouteChange(async () => {
      throw new Error('local listener rejection');
    });
    localBroker.onRouteChange((event) => goodEvents.push(event));

    localGuest = await host.attachLocalGuest({
      guestId: 'local-throwing-guest',
      routedDomains: ['throwing.local.test'],
      listener: (_request, response) => response.end('ok'),
    });
    await localBroker.waitForRoute('throwing.local.test');

    // Good listener must still receive the 'added' event
    assert.ok(
      goodEvents.some((e) => e.type === 'added' && e.domain === 'throwing.local.test'),
      `Expected added event despite rejecting listener, got: ${JSON.stringify(goodEvents)}`,
    );
    assert.deepEqual(localBroker.getRoutes(), [
      { targetId: 'local-throwing-guest', domain: 'throwing.local.test' },
    ]);

    // Revoke should also work
    goodEvents.length = 0;
    localGuest.revokeRoutes(['throwing.local.test']);

    assert.ok(
      goodEvents.some((e) => e.type === 'removed' && e.domain === 'throwing.local.test'),
      `Expected removed event despite rejecting listener, got: ${JSON.stringify(goodEvents)}`,
    );
    assert.deepEqual(localBroker.getRoutes(), []);
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker uses configurable lease acquire timeout for HTTP/2 Guests', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const h2Guest = await connectClient(host.address.port);
  let localBroker;

  try {
    await requestJson(h2Guest, {
      peerId: 'h2-guest-local-timeout-1',
      role: 'guest',
      routedDomains: ['local-timeout-to-h2.local.test'],
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-timeout-1' });
    await localBroker.waitForRoute('local-timeout-to-h2.local.test');

    await assert.rejects(
      () =>
        localBroker.request({
          targetId: 'h2-guest-local-timeout-1',
          method: 'GET',
          path: '/timeout',
          leaseAcquireTimeoutMs: 1,
        }),
      (error) => {
        assert.equal(error.code, 'timeout');
        assert.equal(error.context.targetId, 'h2-guest-local-timeout-1');
        return true;
      },
    );
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    h2Guest.close();
    await host.close('test-complete');
  }
});

test('Direct H2 cancel body error maps to disconnected-target (not stream-failure)', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-h2-cancel-mapping',
      routedDomains: ['h2-cancel-mapping.local.test'],
      listener: (request, response) => {
        request.resume();
        request.on('end', () => response.end('unexpected'));
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-h2-cancel-mapping-broker' });
    await localBroker.waitForRoute('h2-cancel-mapping.local.test');

    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'local-h2-cancel-mapping',
      method: 'POST',
      path: '/body-h2-cancel',
      body,
    });

    // Error with numeric NGHTTP2_CANCEL code
    const h2Error = new Error('stream closed with NGHTTP2_CANCEL');
    h2Error.code = http2.constants.NGHTTP2_CANCEL;
    body.destroy(h2Error);

    await assert.rejects(responsePromise, (error) => {
      assert.equal(error.code, 'disconnected-target');
      return true;
    });
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Direct H2 cancel body error with ERR_HTTP2_STREAM_ERROR maps to disconnected-target', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-h2-cancel-mapping-2',
      routedDomains: ['h2-cancel-mapping-2.local.test'],
      listener: (request, response) => {
        request.resume();
        request.on('end', () => response.end('unexpected'));
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-h2-cancel-mapping-broker-2' });
    await localBroker.waitForRoute('h2-cancel-mapping-2.local.test');

    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'local-h2-cancel-mapping-2',
      method: 'POST',
      path: '/body-h2-cancel-2',
      body,
    });

    // Error with string code from Node H2
    const h2Error = new Error('stream reset by remote');
    h2Error.code = 'ERR_HTTP2_STREAM_ERROR';
    body.destroy(h2Error);

    await assert.rejects(responsePromise, (error) => {
      assert.equal(error.code, 'disconnected-target');
      return true;
    });
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Ordinary local body stream error still maps to stream-failure (not disconnected-target)', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-body-stream-ordinary',
      routedDomains: ['local-body-stream-ordinary.local.test'],
      listener: (request, response) => {
        request.resume();
        request.on('end', () => response.end('unexpected'));
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-body-stream-ordinary-broker' });
    await localBroker.waitForRoute('local-body-stream-ordinary.local.test');

    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'local-body-stream-ordinary',
      method: 'POST',
      path: '/body-stream-ordinary',
      body,
    });

    // Plain Error with no H2 cancel characteristics
    body.destroy(new Error('ordinary stream failure'));

    await assert.rejects(responsePromise, (error) => {
      assert.equal(error.code, 'stream-failure');
      assert.match(error.message, /ordinary stream failure/);
      assert.equal(error.context.targetId, 'local-body-stream-ordinary');
      return true;
    });
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('HTTP/2 Broker abort cancels an in-flight local Guest dispatch', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const h2Broker = await connectClient(host.address.port);
  let localGuest;

  try {
    const localRequestError = new Promise((resolve) => {
      localGuest = host.attachLocalGuest({
        guestId: 'local-guest-h2-abort-1',
        routedDomains: ['h2-abort-local.local.test'],
        listener: (request, response) => {
          request.once('error', resolve);
          response.writeHead(200, { 'x-abort-test': 'started' });
          response.write('first');
        },
      });
    });
    localGuest = await localGuest;

    const stream = h2Broker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'local-guest-h2-abort-1',
      'x-verser-request-id': 'h2-abort-local-request-1',
      'x-verser-source-id': 'h2-broker-abort-local-1',
      'x-verser-method': 'POST',
      'x-verser-path': '/abort',
      'x-verser-headers': '{}',
    });
    await new Promise((resolve) => stream.once('response', resolve));
    stream.close();

    const error = await Promise.race([
      localRequestError,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('local dispatch was not cancelled')), 1000),
      ),
    ]);
    assert.equal(error.code, 'disconnected-target');
  } finally {
    if (localGuest !== undefined) await localGuest.close('test-complete');
    h2Broker.close();
    await host.close('test-complete');
  }
});

test('HTTP/2 Broker routes to a local Guest through Host target checks', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'h2-broker-local-guest-1' });
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-guest-h2-broker-1',
      routedDomains: ['h2-to-local.local.test'],
      listener: (request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          response.writeHead(203, { 'x-interop': 'h2-to-local' });
          response.end(Buffer.concat(chunks));
        });
      },
    });
    await broker.connect();
    await broker.waitForRoute('h2-to-local.local.test');

    const response = await broker.request({
      targetId: 'local-guest-h2-broker-1',
      method: 'PATCH',
      path: '/interop',
      body: [Buffer.from('local-body')],
    });

    assert.equal(response.statusCode, 203);
    assert.equal(response.headers['x-interop'], 'h2-to-local');
    assert.deepEqual(await readBody(response.body), Buffer.from('local-body'));
  } finally {
    await broker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local routing streams request and response bodies without mandatory buffering', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    let firstUploadChunk;
    localGuest = await host.attachLocalGuest({
      guestId: 'local-streaming-guest-1',
      routedDomains: ['local-streaming.local.test'],
      listener: (request, response) => {
        request.once('data', (chunk) => {
          firstUploadChunk = Buffer.from(chunk);
          response.writeHead(200, { 'x-local-streaming': 'yes' });
          response.write(Buffer.from('first-response'));
          setTimeout(() => response.end(Buffer.from('second-response')), 100);
        });
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-streaming-broker-1' });
    await localBroker.waitForRoute('local-streaming.local.test');

    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'local-streaming-guest-1',
      method: 'POST',
      path: '/streaming',
      body,
    });
    body.write(Buffer.from('first-upload'));

    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('local upload was buffered')), 50),
      ),
    ]);
    assert.deepEqual(firstUploadChunk, Buffer.from('first-upload'));
    assert.equal(response.headers['x-local-streaming'], 'yes');
    assert.deepEqual(
      await Promise.race([
        readNextChunk(response.body),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('local response was buffered')), 50),
        ),
      ]),
      Buffer.from('first-response'),
    );
    const cancelledRead = readNextChunk(response.body);
    await localBroker.close('stream-close-test');
    await assert.rejects(cancelledRead, (error) => {
      assert.equal(error.code, 'disconnected-target');
      return true;
    });
    body.end(Buffer.from('second-upload'));
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker maps missing targets, detached targets, and local handler failures', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-errors-1' });
    await assert.rejects(
      () =>
        localBroker.request({ targetId: 'missing-local-guest', method: 'GET', path: '/missing' }),
      (error) => {
        assert.equal(error.code, 'missing-guest');
        assert.equal(error.context.targetId, 'missing-local-guest');
        return true;
      },
    );

    localGuest = await host.attachLocalGuest({
      guestId: 'local-error-guest-1',
      routedDomains: ['local-error.local.test'],
      listener: () => {
        throw new Error('local handler exploded');
      },
    });
    await localBroker.waitForRoute('local-error.local.test');

    await assert.rejects(
      () => localBroker.request({ targetId: 'local-error-guest-1', method: 'GET', path: '/boom' }),
      (error) => {
        assert.equal(error.code, 'local-handler-failure');
        assert.match(error.message, /local handler exploded/);
        assert.equal(error.context.targetId, 'local-error-guest-1');
        return true;
      },
    );

    await localGuest.close('test-detach');
    await assert.rejects(
      () =>
        localBroker.request({
          targetId: 'local-error-guest-1',
          method: 'GET',
          path: '/after-close',
        }),
      (error) => {
        assert.equal(error.code, 'missing-guest');
        assert.equal(error.context.targetId, 'local-error-guest-1');
        return true;
      },
    );
  } finally {
    if (localGuest !== undefined) await localGuest.close('test-complete');
    if (localBroker !== undefined) await localBroker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker rejects route waiters and requests after close paths', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-close-1' });

  try {
    const closedBrokerWait = localBroker.waitForRoute('never-closes.local.test');
    await localBroker.close('broker-close-test');
    await assert.rejects(closedBrokerWait, (error) => {
      assert.equal(error.code, 'disconnected-target');
      return true;
    });
    await assert.rejects(
      () => localBroker.request({ targetId: 'missing-after-close', method: 'GET', path: '/' }),
      (error) => {
        assert.equal(error.code, 'disconnected-target');
        return true;
      },
    );

    localBroker = await host.attachLocalBroker({ brokerId: 'local-broker-host-close-1' });
    const hostCloseWait = localBroker.waitForRoute('never-host-closes.local.test');
    await host.close('host-close-test');
    await assert.rejects(hostCloseWait, (error) => {
      assert.equal(error.code, 'disconnected-target');
      return true;
    });
    await assert.rejects(
      () => localBroker.request({ targetId: 'missing-after-host-close', method: 'GET', path: '/' }),
      (error) => {
        assert.equal(error.code, 'disconnected-target');
        return true;
      },
    );
  } finally {
    await localBroker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Local Broker maps local request body stream errors to stream failures', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  let localBroker;
  let localGuest;

  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'local-body-error-guest-1',
      routedDomains: ['local-body-error.local.test'],
      listener: (request, response) => {
        request.resume();
        request.on('end', () => response.end('unexpected'));
      },
    });
    localBroker = await host.attachLocalBroker({ brokerId: 'local-body-error-broker-1' });
    await localBroker.waitForRoute('local-body-error.local.test');

    const body = new PassThrough();
    const responsePromise = localBroker.request({
      targetId: 'local-body-error-guest-1',
      method: 'POST',
      path: '/body-error',
      body,
    });
    body.destroy(new Error('upload failed'));

    await assert.rejects(responsePromise, (error) => {
      assert.equal(error.code, 'stream-failure');
      assert.match(error.message, /upload failed/);
      assert.equal(error.context.targetId, 'local-body-error-guest-1');
      return true;
    });
  } finally {
    if (localBroker !== undefined) await localBroker.close('test-complete');
    if (localGuest !== undefined) await localGuest.close('test-complete');
    await host.close('test-complete');
  }
});

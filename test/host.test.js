const assert = require('node:assert/strict');
const http2 = require('node:http2');
const test = require('node:test');

const common = require('../packages/verser-common/dist/index.js');
const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
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

function requestJsonWithHeaders(session, headers, payload = '') {
  return new Promise((resolve, reject) => {
    const stream = session.request(headers);
    let body = '';

    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      body += chunk;
    });
    stream.on('end', () => {
      resolve(body.length === 0 ? undefined : JSON.parse(body));
    });
    stream.on('error', reject);
    stream.end(payload);
  });
}

function openLeaseStream(session, peerId, leaseId) {
  return new Promise((resolve, reject) => {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': peerId,
      'x-verser-lease-id': leaseId,
    });
    const timeout = setTimeout(() => {
      stream.close();
      reject(new Error('lease stream response timed out'));
    }, 1000);

    stream.once('response', (headers) => {
      clearTimeout(timeout);
      resolve({ stream, headers });
    });
    stream.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stream.end();
  });
}

function openBrokerRegistration(session, payload) {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': '/verser/register' });
    const lines = [];
    let pending = '';

    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let lineBreak = pending.indexOf('\n');
      while (lineBreak !== -1) {
        lines.push(JSON.parse(pending.slice(0, lineBreak)));
        pending = pending.slice(lineBreak + 1);
        lineBreak = pending.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (pending.length > 0) {
        try {
          lines.push(JSON.parse(pending));
        } catch {
          // Preserve parse failures for the test reader rather than hiding them.
          lines.push({ parseError: pending });
        }
      }
    });
    stream.on('error', reject);
    stream.end(JSON.stringify(payload));

    const readNext = async () => {
      while (lines.length === 0) {
        await Promise.race([once(stream, 'data'), once(stream, 'end')]);
      }
      return lines.shift();
    };

    resolve({ stream, readNext });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout(promise, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('Host starts and stops a TLS HTTP/2 server', async () => {
  const host = createHost({ port: 0 });

  assert.throws(() => host.address, /not listening/);

  await host.start();
  await host.start();

  assert.equal(host.running, true);
  assert.equal(typeof host.address.port, 'number');
  assert.ok(host.address.port > 0);

  await host.close('test-complete');
  await host.close('already-closed');

  assert.equal(host.running, false);
});

test('Host refuses to reload TLS certificate when stopped', () => {
  const host = createHost({ port: 0 });

  assert.throws(() => host.reloadTlsCertificate(), /not running|not started/i);
});

test('Host accepts registrations and advertises routed domains to Brokers', async () => {
  const host = createHost({ port: 0 });
  const events = [];
  host.onLifecycle((event) => events.push(event));

  await host.start();
  const broker = await connectClient(host.address.port);
  const guest = await connectClient(host.address.port);

  try {
    const brokerControl = await openBrokerRegistration(broker, {
      peerId: 'broker-1',
      role: 'broker',
    });
    const brokerRegistration = await brokerControl.readNext();

    assert.equal(brokerRegistration.status, 'registered');
    assert.deepEqual(brokerRegistration.routes, []);

    const guestRegistration = await requestJson(guest, {
      peerId: 'guest-1',
      role: 'guest',
      routedDomains: ['guest.local.test'],
    });

    assert.equal(guestRegistration.status, 'registered');
    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'guest-1', domain: 'guest.local.test' },
    ]);

    assert.deepEqual(await brokerControl.readNext(), {
      type: 'routes',
      routes: [{ targetId: 'guest-1', domain: 'guest.local.test' }],
    });
    const eventNames = events.map((event) => event.name);
    assert.equal(eventNames.filter((name) => name === 'connected').length, 2);
    assert.equal(eventNames.filter((name) => name === 'registered').length, 2);
    assert.equal(eventNames.filter((name) => name === 'route-advertised').length, 1);
    assert.equal(eventNames.at(-1), 'route-advertised');
  } finally {
    broker.close();
    guest.close();
    await host.close('test-complete');
  }
});

test('Host supports lifecycle unsubscription and disconnect route cleanup', async () => {
  const host = createHost({ port: 0 });
  const events = [];
  const unsubscribe = host.onLifecycle((event) => events.push(event));

  await host.start();
  unsubscribe();
  const ignored = await connectClient(host.address.port);
  ignored.close();
  await once(ignored, 'close');

  const guest = await connectClient(host.address.port);
  host.onLifecycle((event) => events.push(event));

  try {
    assert.equal(
      (
        await requestJson(guest, {
          peerId: 'guest-cleanup',
          role: 'guest',
          routedDomains: ['cleanup.local.test'],
        })
      ).status,
      'registered',
    );
    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'guest-cleanup', domain: 'cleanup.local.test' },
    ]);

    guest.close();
    await once(guest, 'close');

    // Route remains visible as degraded after disconnect
    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'guest-cleanup', domain: 'cleanup.local.test' },
    ]);
    assert.deepEqual(
      events.map((event) => event.name),
      ['connected', 'registered', 'route-degraded', 'disconnected'],
    );
  } finally {
    await host.close('test-complete');
  }
});

test('Host rejects duplicate and malformed registrations with contextual errors', async () => {
  const host = createHost({ port: 0 });

  await host.start();
  const first = await connectClient(host.address.port);
  const duplicate = await connectClient(host.address.port);
  const malformed = await connectClient(host.address.port);

  try {
    assert.equal(
      (await requestJson(first, { peerId: 'guest-1', role: 'guest' })).status,
      'registered',
    );

    const duplicateResponse = await requestJson(duplicate, { peerId: 'guest-1', role: 'guest' });
    assert.equal(duplicateResponse.error.code, 'invalid-registration');
    assert.match(duplicateResponse.error.message, /guest-1/);

    const malformedResponse = await requestJson(malformed, { peerId: '', role: 'guest' });
    assert.equal(malformedResponse.error.code, 'invalid-registration');
    assert.match(malformedResponse.error.message, /peer id/i);

    const invalidRoleResponse = await requestJson(malformed, {
      peerId: 'bad-role',
      role: 'client',
    });
    assert.equal(invalidRoleResponse.error.code, 'invalid-registration');
    assert.match(invalidRoleResponse.error.message, /broker or guest/);

    const wrongPathResponse = await requestJson(
      malformed,
      { peerId: 'wrong-path', role: 'guest' },
      '/wrong',
    );
    assert.equal(wrongPathResponse.error.code, 'protocol-error');
    assert.match(wrongPathResponse.error.message, /Unsupported Host stream path/);
  } finally {
    first.close();
    duplicate.close();
    malformed.close();
    await host.close('test-complete');
  }
});

test('Host accepts Guest-opened lease streams for registered Guests', async () => {
  const host = createHost({ port: 0 });

  await host.start();
  const guest = await connectClient(host.address.port);

  try {
    assert.equal(
      (await requestJson(guest, { peerId: 'guest-lease-accept', role: 'guest' })).status,
      'registered',
    );

    const lease = await openLeaseStream(guest, 'guest-lease-accept', 'lease-1');

    assert.equal(lease.headers[':status'], 200);
    assert.equal(lease.stream.closed, false);
  } finally {
    guest.close();
    await host.close('test-complete');
  }
});

test('Host rejects lease streams for missing Guests', async () => {
  const host = createHost({ port: 0 });

  await host.start();
  const guest = await connectClient(host.address.port);

  try {
    const response = await requestJsonWithHeaders(guest, {
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': 'missing-lease-guest',
      'x-verser-lease-id': 'lease-missing',
    });

    assert.equal(response.error.code, 'disconnected-target');
    assert.match(response.error.message, /registered peer/i);
  } finally {
    guest.close();
    await host.close('test-complete');
  }
});

test('Host rejects lease streams without lease ids', async () => {
  const host = createHost({ port: 0 });

  await host.start();
  const guest = await connectClient(host.address.port);

  try {
    assert.equal(
      (await requestJson(guest, { peerId: 'guest-missing-lease-id', role: 'guest' })).status,
      'registered',
    );
    const response = await requestJsonWithHeaders(guest, {
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': 'guest-missing-lease-id',
      'x-verser-lease-id': '',
    });

    assert.equal(response.error.code, 'protocol-error');
    assert.match(response.error.message, /lease id/i);
  } finally {
    guest.close();
    await host.close('test-complete');
  }
});

test('Host rejects target-only requests when the Guest has no active route', async () => {
  const host = createHost({ port: 0 });

  await host.start();
  const guest = await connectClient(host.address.port);
  const broker = await connectClient(host.address.port);

  try {
    assert.equal(
      (await requestJson(guest, { peerId: 'guest-lease-timeout', role: 'guest' })).status,
      'registered',
    );
    const brokerControl = await openBrokerRegistration(broker, {
      peerId: 'broker-lease-timeout',
      role: 'broker',
    });
    assert.equal((await brokerControl.readNext()).status, 'registered');

    const response = await requestJsonWithHeaders(broker, {
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-source-id': 'broker-lease-timeout',
      'x-verser-target-id': 'guest-lease-timeout',
      'x-verser-request-id': 'req-lease-timeout',
      'x-verser-lease-acquire-timeout-ms': '10',
    });

    assert.equal(response.error.code, 'missing-guest');
    assert.equal(response.error.context.targetId, 'guest-lease-timeout');
  } finally {
    guest.close();
    broker.close();
    await host.close('test-complete');
  }
});

test('Host rejects remote Broker HTTP ingress from an unregistered session before local Guest dispatch', async () => {
  const host = createHost({ port: 0 });
  let calls = 0;
  let broker;
  let unregistered;
  let localGuest;

  await host.start();
  try {
    localGuest = await host.attachLocalGuest({
      guestId: 'request-session-guest',
      routedDomains: ['request-session.local.test'],
      listener: (_request, response) => {
        calls += 1;
        response.end('ok');
      },
    });
    broker = await connectClient(host.address.port);
    unregistered = await connectClient(host.address.port);
    const control = await openBrokerRegistration(broker, {
      peerId: 'request-session-broker',
      role: 'broker',
    });
    assert.equal(
      (await withTimeout(control.readNext(), 'Broker registration')).status,
      'registered',
    );

    const request = unregistered.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-source-id': 'request-session-broker',
      'x-verser-target-id': 'request-session-guest',
      'x-verser-request-id': 'request-session-spoof',
      'x-verser-method': 'GET',
      'x-verser-path': '/',
      'x-verser-headers': JSON.stringify({ host: 'request-session.local.test' }),
    });
    const requestResult = withTimeout(
      new Promise((resolve, reject) => {
        request.once('response', (headers) => {
          let body = '';
          request.setEncoding('utf8');
          request.on('data', (chunk) => {
            body += chunk;
          });
          request.once('end', () => resolve({ status: headers[':status'], body }));
        });
        request.once('error', reject);
        request.end();
      }),
      'Unregistered request',
    );
    const response = await requestResult;

    assert.equal(response.status, 502, `unexpected response body: ${response.body}`);
    assert.equal(JSON.parse(response.body).error.code, 'authorization-denied');
    assert.equal(calls, 0);
  } finally {
    unregistered?.destroy();
    broker?.destroy();
    await localGuest?.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host does not admit two concurrent remote registrations for the same peer ID', async () => {
  const gates = [];
  const entered = deferred();
  const host = createHost({
    port: 0,
    tls: {
      clientAuth: {
        authorizeRegistration() {
          const gate = deferred();
          gates.push(gate);
          if (gates.length === 2) entered.resolve();
          return gate.promise;
        },
      },
    },
  });
  let first;
  let second;

  await host.start();
  try {
    first = await connectClient(host.address.port);
    second = await connectClient(host.address.port);
    const firstRegistration = await openBrokerRegistration(first, {
      peerId: 'concurrent-registration-broker',
      role: 'broker',
    });
    const secondRegistration = await openBrokerRegistration(second, {
      peerId: 'concurrent-registration-broker',
      role: 'broker',
    });
    await withTimeout(entered.promise, 'Both authorization callbacks');
    for (const gate of gates) gate.resolve({ action: 'allow' });

    const outcomes = await withTimeout(
      Promise.all([firstRegistration.readNext(), secondRegistration.readNext()]),
      'Concurrent registration responses',
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === 'registered').length, 1);
    assert.equal(
      outcomes.filter((outcome) => outcome.error?.code === 'invalid-registration').length,
      1,
    );
  } finally {
    first?.destroy();
    second?.destroy();
    for (const gate of gates) gate.resolve({ action: 'allow' });
    await host.close('test-complete');
  }
});

test('Host does not publish a remote identity after its pending registration session closes', async () => {
  const authorization = deferred();
  const entered = deferred();
  const host = createHost({
    port: 0,
    tls: {
      clientAuth: {
        authorizeRegistration() {
          entered.resolve();
          return authorization.promise;
        },
      },
    },
  });
  let stale;
  let replacement;

  await host.start();
  try {
    stale = await connectClient(host.address.port);
    const staleRegistration = await openBrokerRegistration(stale, {
      peerId: 'closed-pending-broker',
      role: 'broker',
    });
    await withTimeout(entered.promise, 'Authorization callback');
    stale.destroy();
    await withTimeout(once(stale, 'close'), 'Pending session close');
    authorization.resolve({ action: 'allow' });
    // Drain the rejected/closed registration stream before reusing its ID.
    await Promise.race([
      staleRegistration.readNext().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);

    replacement = await connectClient(host.address.port);
    const replacementRegistration = await openBrokerRegistration(replacement, {
      peerId: 'closed-pending-broker',
      role: 'broker',
    });
    assert.equal(
      (await withTimeout(replacementRegistration.readNext(), 'Replacement registration')).status,
      'registered',
    );
  } finally {
    authorization.resolve({ action: 'allow' });
    stale?.destroy();
    replacement?.destroy();
    await host.close('test-complete');
  }
});

test('Host does not dispatch a queued Broker request after its request stream closes', async () => {
  const host = createHost({ port: 0 });
  let guest;
  let broker;
  let brokerControl;
  let request;
  let lease;
  let guestBytes = 0;

  await host.start();
  try {
    guest = await connectClient(host.address.port);
    broker = await connectClient(host.address.port);
    assert.equal(
      (
        await requestJson(guest, {
          peerId: 'closed-request-lease-guest',
          role: 'guest',
          routedDomains: ['closed-request-lease.local.test'],
        })
      ).status,
      'registered',
    );
    brokerControl = await openBrokerRegistration(broker, {
      peerId: 'closed-request-lease-broker',
      role: 'broker',
    });
    assert.equal(
      (await withTimeout(brokerControl.readNext(), 'Broker registration')).status,
      'registered',
    );

    request = broker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-source-id': 'closed-request-lease-broker',
      'x-verser-target-id': 'closed-request-lease-guest',
      'x-verser-request-id': 'closed-request-lease-request',
      'x-verser-method': 'GET',
      'x-verser-path': '/',
      'x-verser-headers': JSON.stringify({ host: 'closed-request-lease.local.test' }),
    });
    request.on('error', () => {});
    request.end();
    await new Promise((resolve) => setTimeout(resolve, 30));
    request.close(http2.constants.NGHTTP2_CANCEL);

    const leaseStream = guest.request({
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': 'closed-request-lease-guest',
      'x-verser-lease-id': 'closed-request-lease-id',
    });
    lease = { stream: leaseStream };
    leaseStream.on('error', () => {});
    leaseStream.on('data', (chunk) => {
      guestBytes += chunk.length;
    });
    const leaseClosed = withTimeout(once(leaseStream, 'close'), 'Unused acquired lease close');
    leaseStream.end();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(guestBytes, 0, 'closed Broker request was written to a later Guest lease');
    assert.equal(lease.stream.closed, true, 'unused acquired lease should be released');
    await leaseClosed;
  } finally {
    request?.close(http2.constants.NGHTTP2_CANCEL);
    lease?.stream.close();
    broker?.destroy();
    guest?.destroy();
    await host.close('test-complete');
  }
});

test('Host rejects local registrations authorized across shutdown and restart', async () => {
  const gates = new Map();
  const entered = deferred();
  const host = createHost({
    port: 0,
    tls: {
      clientAuth: {
        authorizeRegistration(context) {
          const gate = deferred();
          gates.set(context.peerId, gate);
          if (gates.size === 2) entered.resolve();
          return gate.promise;
        },
      },
    },
  });
  const lifecycle = [];
  host.onLifecycle((event) => lifecycle.push(event));

  await host.start();
  const guestRegistration = host.attachLocalGuest({
    guestId: 'shutdown-pending-local-guest',
    routedDomains: ['shutdown-pending.local.test'],
    listener: (_request, response) => response.end('unexpected'),
  });
  const brokerRegistration = host.attachLocalBroker({ brokerId: 'shutdown-pending-local-broker' });
  try {
    await withTimeout(entered.promise, 'Local authorization callbacks');
    await host.close('close-pending-registrations');
    await host.start();
    for (const gate of gates.values()) gate.resolve({ action: 'allow' });

    await assert.rejects(guestRegistration, /Host closed|admission.*invalidated|shutdown/i);
    await assert.rejects(brokerRegistration, /Host closed|admission.*invalidated|shutdown/i);
    assert.deepEqual(host.getRoutedDomains(), []);
    assert.equal(
      lifecycle.filter(
        (event) => event.name === 'registered' && event.peerId.startsWith('shutdown-pending-'),
      ).length,
      0,
    );
  } finally {
    for (const gate of gates.values()) gate.resolve({ action: 'allow' });
    await host.close('test-complete');
  }
});

test('Host does not publish a remote registration authorized across shutdown and restart', async () => {
  const authorization = deferred();
  const entered = deferred();
  let authorizationCalls = 0;
  const host = createHost({
    port: 0,
    tls: {
      clientAuth: {
        authorizeRegistration() {
          authorizationCalls += 1;
          if (authorizationCalls === 1) {
            entered.resolve();
            return authorization.promise;
          }
          return { action: 'allow' };
        },
      },
    },
  });
  const lifecycle = [];
  host.onLifecycle((event) => lifecycle.push(event));
  let stale;
  let replacement;

  await host.start();
  try {
    stale = await connectClient(host.address.port);
    const staleRegistration = await openBrokerRegistration(stale, {
      peerId: 'shutdown-pending-remote-broker',
      role: 'broker',
    });
    await withTimeout(entered.promise, 'Remote authorization callback');
    await host.close('close-pending-remote-registration');
    await host.start();
    authorization.resolve({ action: 'allow' });
    await Promise.race([
      staleRegistration.readNext().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);

    replacement = await connectClient(host.address.port);
    const replacementRegistration = await openBrokerRegistration(replacement, {
      peerId: 'shutdown-pending-remote-broker',
      role: 'broker',
    });
    assert.equal(
      (await withTimeout(replacementRegistration.readNext(), 'Replacement Broker registration'))
        .status,
      'registered',
    );
    assert.equal(
      lifecycle.filter(
        (event) => event.name === 'registered' && event.peerId === 'shutdown-pending-remote-broker',
      ).length,
      1,
    );
  } finally {
    authorization.resolve({ action: 'allow' });
    stale?.destroy();
    replacement?.destroy();
    await host.close('test-complete');
  }
});

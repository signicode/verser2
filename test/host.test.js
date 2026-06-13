const assert = require('node:assert/strict');
const http = require('node:http');
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
    stream.on('error', reject);
    stream.end(JSON.stringify(payload));

    const readNext = async () => {
      while (lines.length === 0) {
        await once(stream, 'data');
      }
      return lines.shift();
    };

    resolve({ stream, readNext });
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

test('Host attaches local Guests and Brokers with route advertisement and retraction', async () => {
  const host = createHost({ port: 0 });
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
    assert.deepEqual(localBroker.getRoutes(), [
      { targetId: 'local-guest-registration-1', domain: 'local-registration.local.test' },
    ]);

    await localGuest.close('test-detach');
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
    assert.match(duplicateH2Response.error.message, /duplicate-local-peer/);

    await assert.rejects(
      () =>
        host.attachLocalBroker({
          brokerId: 'duplicate-local-peer',
        }),
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
    assert.equal(contexts[0].peerId, 'local-authorized-guest');
    assert.equal(contexts[0].role, 'guest');
    assert.deepEqual(contexts[0].routedDomains, ['local-authorized.local.test']);
    assert.equal(contexts[0].certificate, undefined);
    assert.deepEqual(contexts[0].metadata, { local: true, authorized: true });
    assert.equal(contexts[1].peerId, 'local-authorized-broker');
    assert.equal(contexts[1].role, 'broker');
    assert.deepEqual(contexts[1].routedDomains, []);
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

    assert.deepEqual(host.getRoutedDomains(), []);
    assert.deepEqual(
      events.map((event) => event.name),
      ['connected', 'registered', 'disconnected'],
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

test('Host queues Broker routed requests and times out when no lease is available', async () => {
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
      'x-verser-target-id': 'guest-lease-timeout',
      'x-verser-request-id': 'req-lease-timeout',
      'x-verser-lease-acquire-timeout-ms': '10',
    });

    assert.equal(response.error.code, 'timeout');
    assert.equal(response.error.context.targetId, 'guest-lease-timeout');
    assert.equal(response.error.context.requestId, 'req-lease-timeout');
  } finally {
    guest.close();
    broker.close();
    await host.close('test-complete');
  }
});

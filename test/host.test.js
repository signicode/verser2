const assert = require('node:assert/strict');
const http2 = require('node:http2');
const test = require('node:test');

const common = require('../packages/verser-common/dist/index.js');
const { createVerserHost } = require('../packages/verser2-host/dist/index.js');

function once(emitter, eventName) {
  return new Promise((resolve) => emitter.once(eventName, resolve));
}

async function connectClient(port) {
  const tls = common.createDevelopmentTlsCertificate();
  const session = http2.connect(`https://localhost:${port}`, { ca: tls.cert });
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

test('Host starts and stops a TLS HTTP/2 server', async () => {
  const host = createVerserHost({ port: 0 });

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

test('Host accepts registrations and advertises routed domains to Brokers', async () => {
  const host = createVerserHost({ port: 0 });
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
    assert.deepEqual(
      events.map((event) => event.name),
      ['connected', 'connected', 'registered', 'registered', 'route-advertised'],
    );
  } finally {
    broker.close();
    guest.close();
    await host.close('test-complete');
  }
});

test('Host supports lifecycle unsubscription and disconnect route cleanup', async () => {
  const host = createVerserHost({ port: 0 });
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
  const host = createVerserHost({ port: 0 });

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

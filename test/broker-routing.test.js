const assert = require('node:assert/strict');
const http2 = require('node:http2');
const test = require('node:test');

const common = require('../packages/verser-common/dist/index.js');
const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

async function connectRawClient(port) {
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
    stream.on('end', () => resolve(body.length === 0 ? undefined : JSON.parse(body)));
    stream.on('error', reject);
    stream.end(JSON.stringify(payload));
  });
}

function openRawLease(session, peerId, leaseId, onRequest) {
  return new Promise((resolve, reject) => {
    const lease = session.request({
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': peerId,
      'x-verser-lease-id': leaseId,
    });
    const parser = common.createVerserEnvelopeParser();
    const bodyChunks = [];
    let metadata;

    lease.on('data', (chunk) => {
      if (metadata === undefined) {
        const parsed = parser.push(Buffer.from(chunk));
        if (parsed !== undefined) {
          metadata = parsed.metadata;
          bodyChunks.push(parsed.bodyRemainder);
        }
        return;
      }

      bodyChunks.push(Buffer.from(chunk));
    });
    lease.on('end', () => {
      onRequest(metadata, Buffer.concat(bodyChunks), lease);
    });
    lease.once('response', () => resolve(lease));
    lease.once('error', reject);
  });
}

test('Broker connects, receives route advertisements, and forwards requests to a Node Guest', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createVerserBroker({ hostUrl, brokerId: 'broker-routing-1' });
    guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-routing-1' });
    guest.attach((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(203, { 'x-routed': 'yes' });
        response.end(Buffer.concat(chunks));
      });
    }, 'guest.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('guest.local.test');

    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-routing-1', domain: 'guest.local.test' },
    ]);

    const response = await broker.request({
      targetId: 'guest-routing-1',
      method: 'POST',
      path: '/echo',
      headers: { 'x-input': 'abc' },
      body: [Buffer.from([0, 1, 2]), Buffer.from('tail')],
    });

    assert.equal(response.statusCode, 203);
    assert.equal(response.headers['x-routed'], 'yes');
    assert.deepEqual(response.body, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('tail')]));
    assert.equal(broker.routedRequestCount, 1);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker maps missing guests and Guest handler failures to actionable errors', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createVerserBroker({ hostUrl, brokerId: 'broker-errors-1' });
    guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-errors-1' });
    guest.attach(() => {
      throw new Error('guest handler failed');
    }, 'errors.local.test');

    await broker.connect();

    await assert.rejects(
      () => broker.request({ targetId: 'missing-guest', method: 'GET', path: '/missing' }),
      (error) => {
        assert.equal(error.code, 'missing-guest');
        assert.equal(error.context.targetId, 'missing-guest');
        return true;
      },
    );

    await guest.connect();
    await broker.waitForRoute('errors.local.test');

    await assert.rejects(
      () => broker.request({ targetId: 'guest-errors-1', method: 'GET', path: '/boom' }),
      (error) => {
        assert.equal(error.code, 'local-handler-failure');
        assert.match(error.message, /guest handler failed/);
        assert.equal(error.context.targetId, 'guest-errors-1');
        return true;
      },
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker uses one session with separate concurrent routed request streams', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createVerserBroker({ hostUrl, brokerId: 'broker-concurrency-1' });
    guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-concurrency-1' });
    guest.attach((request, response) => {
      response.end(`handled ${request.url}`);
    }, 'concurrency.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('concurrency.local.test');

    const responses = await Promise.all([
      broker.request({ targetId: 'guest-concurrency-1', method: 'GET', path: '/one' }),
      broker.request({ targetId: 'guest-concurrency-1', method: 'GET', path: '/two' }),
      broker.request({ targetId: 'guest-concurrency-1', method: 'GET', path: '/three' }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.body.toString('utf8')),
      ['handled /one', 'handled /two', 'handled /three'],
    );
    assert.equal(broker.sessionCount, 1);
    assert.equal(broker.routedRequestCount, 3);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker receives route retraction after Guest disconnect', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-retraction-1' });
  const guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-retraction-1' });
  guest.attach((_request, response) => response.end('ok'), 'retraction.local.test');

  try {
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('retraction.local.test');
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-retraction-1', domain: 'retraction.local.test' },
    ]);

    await guest.close('test-disconnect');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('route retraction timed out')), 5000);
      const check = setInterval(() => {
        if (broker.getRoutes().length === 0) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker request routes over a raw leased HTTP/2 stream without a Guest control stream', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-raw-lease-1' });
  const rawGuest = await connectRawClient(host.address.port);
  const requestBodies = [];

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-raw-lease-1',
          role: 'guest',
          routedDomains: ['raw-lease.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('raw-lease.local.test');

    await openRawLease(rawGuest, 'guest-raw-lease-1', 'raw-lease-1', (metadata, body, lease) => {
      requestBodies.push(body);
      lease.write(
        common.encodeVerserEnvelope({
          type: 'response',
          metadata: {
            requestId: metadata.requestId,
            statusCode: 206,
            headers: { 'x-lease': 'raw' },
          },
        }),
      );
      lease.end(Buffer.from([9, 8, 7, 0]));
    });

    const response = await broker.request({
      targetId: 'guest-raw-lease-1',
      method: 'POST',
      path: '/leased',
      headers: { 'x-mode': 'raw' },
      body: [Buffer.from([0, 255, 1])],
    });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['x-lease'], 'raw');
    assert.deepEqual(response.body, Buffer.from([9, 8, 7, 0]));
    assert.deepEqual(requestBodies, [Buffer.from([0, 255, 1])]);
  } finally {
    await broker.close('test-complete');
    rawGuest.close();
    await host.close('test-complete');
  }
});

test('Host pipes leased response body to Broker before the lease ends', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const rawGuest = await connectRawClient(host.address.port);
  const rawBroker = await connectRawClient(host.address.port);

  try {
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-lease-pipe-1',
          role: 'guest',
          routedDomains: ['lease-pipe.local.test'],
        })
      ).status,
      'registered',
    );
    await openRawLease(
      rawGuest,
      'guest-lease-pipe-1',
      'raw-lease-pipe-1',
      (metadata, _body, lease) => {
        lease.write(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: {
              requestId: metadata.requestId,
              statusCode: 200,
              headers: { 'x-lease': 'pipe' },
            },
          }),
        );
        lease.write(Buffer.from('first'));
        setTimeout(() => lease.end(Buffer.from('second')), 100);
      },
    );

    const brokerStream = rawBroker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'guest-lease-pipe-1',
      'x-verser-request-id': 'req-lease-pipe-1',
      'x-verser-method': 'GET',
      'x-verser-path': '/pipe',
    });
    const firstChunk = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('leased response was buffered')), 50);
      brokerStream.once('data', (chunk) => {
        clearTimeout(timeout);
        resolve(Buffer.from(chunk));
      });
      brokerStream.once('error', reject);
    });

    brokerStream.end();

    assert.deepEqual(await firstChunk, Buffer.from('first'));
  } finally {
    rawBroker.close();
    rawGuest.close();
    await host.close('test-complete');
  }
});

test('Host maps leased error envelopes to Broker request errors', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-lease-error-1' });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-lease-error-1',
          role: 'guest',
          routedDomains: ['lease-error.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('lease-error.local.test');
    await openRawLease(
      rawGuest,
      'guest-lease-error-1',
      'raw-lease-error-1',
      (metadata, _body, lease) => {
        lease.end(
          common.encodeVerserEnvelope({
            type: 'error',
            metadata: {
              requestId: metadata.requestId,
              code: 'local-handler-failure',
              message: 'leased handler failed',
              context: { custom: 'context' },
            },
          }),
        );
      },
    );

    await assert.rejects(
      () => broker.request({ targetId: 'guest-lease-error-1', method: 'GET', path: '/error' }),
      (error) => {
        assert.equal(error.code, 'local-handler-failure');
        assert.match(error.message, /leased handler failed/);
        assert.equal(error.context.custom, 'context');
        return true;
      },
    );
  } finally {
    await broker.close('test-complete');
    rawGuest.close();
    await host.close('test-complete');
  }
});

test('Host reads split leased response metadata before piping body', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-lease-split-1' });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-lease-split-1',
          role: 'guest',
          routedDomains: ['lease-split.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('lease-split.local.test');
    await openRawLease(
      rawGuest,
      'guest-lease-split-1',
      'raw-lease-split-1',
      (metadata, _body, lease) => {
        const envelope = common.encodeVerserEnvelope({
          type: 'response',
          metadata: {
            requestId: metadata.requestId,
            statusCode: 207,
            headers: { 'x-split': 'yes' },
          },
        });
        lease.write(envelope.subarray(0, 2));
        setTimeout(
          () => lease.end(Buffer.concat([envelope.subarray(2), Buffer.from('split-body')])),
          10,
        );
      },
    );

    const response = await broker.request({
      targetId: 'guest-lease-split-1',
      method: 'GET',
      path: '/split',
    });

    assert.equal(response.statusCode, 207);
    assert.equal(response.headers['x-split'], 'yes');
    assert.deepEqual(response.body, Buffer.from('split-body'));
  } finally {
    await broker.close('test-complete');
    rawGuest.close();
    await host.close('test-complete');
  }
});

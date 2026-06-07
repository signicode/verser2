const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { PassThrough } = require('node:stream');
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
    const bodyChunks = [];
    lease.once('response', () => {
      common
        .readLeaseRequestMetadataFromStream(lease, { guestId: peerId, leaseId })
        .then((metadata) => {
          lease.on('data', (chunk) => bodyChunks.push(Buffer.from(chunk)));
          lease.on('end', () => {
            onRequest(metadata, Buffer.concat(bodyChunks), lease);
          });
        })
        .catch(reject);
      resolve(lease);
    });
    lease.once('error', reject);
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

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
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
    assert.deepEqual(
      await readBody(response.body),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('tail')]),
    );
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

test('Broker validates routed request headers before forwarding metadata', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-header-validation-1' });

  try {
    await broker.connect();

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-header-validation-1',
          method: 'GET',
          path: '/invalid-header',
          headers: { connection: 'close' },
        }),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(error.message, /forbidden header/i);
        return true;
      },
    );
  } finally {
    await broker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker forwards configured lease acquire timeout to the Host', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({
    hostUrl,
    brokerId: 'broker-timeout-option-1',
    leaseAcquireTimeoutMs: 25,
  });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-timeout-option-1',
          role: 'guest',
          routedDomains: ['timeout-option.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('timeout-option.local.test');

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-timeout-option-1',
          method: 'GET',
          path: '/timeout-option',
        }),
      (error) => {
        assert.equal(error.code, 'timeout');
        assert.equal(error.context.timeoutMs, 25);
        return true;
      },
    );
  } finally {
    rawGuest.destroy();
    await broker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host does not serialize lease acquire timeout as request metadata timeout', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({
    hostUrl,
    brokerId: 'broker-timeout-metadata-1',
    leaseAcquireTimeoutMs: 25,
  });
  const rawGuest = await connectRawClient(host.address.port);
  let requestMetadata;

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-timeout-metadata-1',
          role: 'guest',
          routedDomains: ['timeout-metadata.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('timeout-metadata.local.test');

    await openRawLease(
      rawGuest,
      'guest-timeout-metadata-1',
      'raw-lease-timeout-metadata-1',
      (metadata, _body, lease) => {
        requestMetadata = metadata;
        lease.end(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: { requestId: metadata.requestId, statusCode: 204, headers: {} },
          }),
        );
      },
    );

    const response = await broker.request({
      targetId: 'guest-timeout-metadata-1',
      method: 'GET',
      path: '/timeout-metadata',
    });
    await readBody(response.body);

    assert.equal(Object.hasOwn(requestMetadata, 'timeoutMs'), false);
  } finally {
    rawGuest.destroy();
    await broker.close('test-complete');
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
      await Promise.all(
        responses.map((response) => readBody(response.body).then((body) => body.toString('utf8'))),
      ),
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
    assert.deepEqual(await readBody(response.body), Buffer.from([9, 8, 7, 0]));
    assert.deepEqual(requestBodies, [Buffer.from([0, 255, 1])]);
  } finally {
    await broker.close('test-complete');
    rawGuest.close();
    await host.close('test-complete');
  }
});

test('Host isolates active leases when different Guests reuse a lease id', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-duplicate-lease-id-1' });
  const firstGuest = await connectRawClient(host.address.port);
  const secondGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(firstGuest, {
          peerId: 'guest-duplicate-lease-id-1',
          role: 'guest',
          routedDomains: ['duplicate-one.local.test'],
        })
      ).status,
      'registered',
    );
    assert.equal(
      (
        await requestJson(secondGuest, {
          peerId: 'guest-duplicate-lease-id-2',
          role: 'guest',
          routedDomains: ['duplicate-two.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('duplicate-one.local.test');
    await broker.waitForRoute('duplicate-two.local.test');

    await openRawLease(
      firstGuest,
      'guest-duplicate-lease-id-1',
      'shared-lease-id',
      (metadata, _body, lease) => {
        setTimeout(() => {
          lease.end(
            common.encodeVerserEnvelope({
              type: 'response',
              metadata: { requestId: metadata.requestId, statusCode: 200, headers: {} },
            }),
          );
        }, 25);
      },
    );
    await openRawLease(
      secondGuest,
      'guest-duplicate-lease-id-2',
      'shared-lease-id',
      (metadata, _body, lease) => {
        lease.end(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: { requestId: metadata.requestId, statusCode: 200, headers: {} },
          }),
        );
      },
    );

    const firstResponsePromise = broker.request({
      targetId: 'guest-duplicate-lease-id-1',
      method: 'GET',
      path: '/one',
    });
    const secondResponse = await broker.request({
      targetId: 'guest-duplicate-lease-id-2',
      method: 'GET',
      path: '/two',
    });
    await readBody(secondResponse.body);
    secondGuest.close();
    await once(secondGuest, 'close');

    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.statusCode, 200);
    await readBody(firstResponse.body);
  } finally {
    firstGuest.destroy();
    secondGuest.destroy();
    await broker.close('test-complete');
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

test('Host validates leased response metadata headers before forwarding', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-response-header-validation-1' });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-response-header-validation-1',
          role: 'guest',
          routedDomains: ['response-header-validation.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('response-header-validation.local.test');
    await openRawLease(
      rawGuest,
      'guest-response-header-validation-1',
      'raw-lease-response-header-validation-1',
      (metadata, _body, lease) => {
        lease.end(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: {
              requestId: metadata.requestId,
              statusCode: 200,
              headers: { connection: 'close' },
            },
          }),
        );
      },
    );

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-response-header-validation-1',
          method: 'GET',
          path: '/invalid-response-header',
        }),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(error.message, /forbidden header/i);
        return true;
      },
    );
  } finally {
    await broker.close('test-complete');
    rawGuest.destroy();
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
    assert.deepEqual(await readBody(response.body), Buffer.from('split-body'));
  } finally {
    await broker.close('test-complete');
    rawGuest.close();
    await host.close('test-complete');
  }
});

test('leased Node Guest response body streams before the local response ends', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const rawBroker = await connectRawClient(host.address.port);
  let guest;

  try {
    guest = createVerserNodeGuest({
      hostUrl: `https://localhost:${host.address.port}`,
      guestId: 'guest-streaming-response-1',
    });
    guest.attach((_request, response) => {
      response.writeHead(200, { 'x-streaming': 'response' });
      response.write(Buffer.from('first'));
      setTimeout(() => response.end(Buffer.from('second')), 100);
    }, 'streaming-response.local.test');
    await guest.connect();

    const brokerStream = rawBroker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'guest-streaming-response-1',
      'x-verser-request-id': 'req-streaming-response-1',
      'x-verser-source-id': 'broker-streaming-response-1',
      'x-verser-method': 'GET',
      'x-verser-path': '/stream-response',
    });
    const firstChunk = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Node Guest response was buffered')), 50);
      brokerStream.once('data', (chunk) => {
        clearTimeout(timeout);
        resolve(Buffer.from(chunk));
      });
      brokerStream.once('error', reject);
    });

    brokerStream.end();

    assert.deepEqual(await firstChunk, Buffer.from('first'));
  } finally {
    rawBroker.destroy();
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('leased upload dispatch starts before Broker request body ends', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const rawGuest = await connectRawClient(host.address.port);
  const rawBroker = await connectRawClient(host.address.port);

  try {
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-streaming-upload-1',
          role: 'guest',
          routedDomains: ['streaming-upload.local.test'],
        })
      ).status,
      'registered',
    );

    const firstBodyChunk = new Promise((resolve, reject) => {
      const lease = rawGuest.request({
        ':method': 'POST',
        ':path': '/verser/guest/lease',
        'x-verser-peer-id': 'guest-streaming-upload-1',
        'x-verser-lease-id': 'raw-lease-streaming-upload-1',
      });
      lease.once('response', () => {
        common
          .readLeaseRequestMetadataFromStream(lease, {
            guestId: 'guest-streaming-upload-1',
            leaseId: 'raw-lease-streaming-upload-1',
          })
          .then(() => readNextChunk(lease))
          .then(resolve)
          .catch(reject);
      });
      lease.once('error', reject);
      lease.once('response', (headers) => {
        if (Number(headers[':status']) !== 200) {
          reject(new Error(`lease failed with ${headers[':status']}`));
        }
      });
    });

    const brokerStream = rawBroker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'guest-streaming-upload-1',
      'x-verser-request-id': 'req-streaming-upload-1',
      'x-verser-source-id': 'broker-streaming-upload-1',
      'x-verser-method': 'POST',
      'x-verser-path': '/stream-upload',
    });

    brokerStream.write(Buffer.from('first'));

    assert.deepEqual(
      await Promise.race([
        firstBodyChunk,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('leased upload was buffered')), 50),
        ),
      ]),
      Buffer.from('first'),
    );
    brokerStream.end(Buffer.from('second'));
  } finally {
    rawBroker.destroy();
    rawGuest.destroy();
    await host.close('test-complete');
  }
});

test('broker.request streams Readable upload bodies over leased routing', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-readable-upload-1' });
  let guest;

  try {
    guest = createVerserNodeGuest({
      hostUrl,
      guestId: 'guest-readable-upload-1',
    });
    guest.attach((request, response) => {
      request.once('data', (chunk) => {
        response.writeHead(200, { 'x-readable-upload': 'streamed' });
        response.end(Buffer.from(chunk));
      });
    }, 'readable-upload.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('readable-upload.local.test');

    const body = new PassThrough();
    const responsePromise = broker.request({
      targetId: 'guest-readable-upload-1',
      method: 'POST',
      path: '/readable-upload',
      body,
    });

    body.write(Buffer.from('first'));

    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Readable upload was not streamed')), 50),
      ),
    ]);

    assert.equal(response.headers['x-readable-upload'], 'streamed');
    assert.deepEqual(await readBody(response.body), Buffer.from('first'));
    body.end(Buffer.from('second'));
  } finally {
    await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker abort cancels the active leased stream', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const rawGuest = await connectRawClient(host.address.port);
  const rawBroker = await connectRawClient(host.address.port);

  try {
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-abort-lease-1',
          role: 'guest',
          routedDomains: ['abort-lease.local.test'],
        })
      ).status,
      'registered',
    );

    const leaseClosed = new Promise((resolve, reject) => {
      const lease = rawGuest.request({
        ':method': 'POST',
        ':path': '/verser/guest/lease',
        'x-verser-peer-id': 'guest-abort-lease-1',
        'x-verser-lease-id': 'raw-lease-abort-1',
      });
      lease.once('response', () => {
        common
          .readLeaseRequestMetadataFromStream(lease, {
            guestId: 'guest-abort-lease-1',
            leaseId: 'raw-lease-abort-1',
          })
          .then(() => readNextChunk(lease))
          .then(() => brokerStream.close(http2.constants.NGHTTP2_CANCEL))
          .catch(reject);
      });
      lease.once('close', resolve);
      lease.once('error', reject);
    });

    const brokerStream = rawBroker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'guest-abort-lease-1',
      'x-verser-request-id': 'req-abort-lease-1',
      'x-verser-source-id': 'broker-abort-lease-1',
      'x-verser-method': 'POST',
      'x-verser-path': '/abort',
    });
    brokerStream.write(Buffer.from('cancel-me'));

    await Promise.race([
      leaseClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('lease was not cancelled')), 500),
      ),
    ]);
  } finally {
    rawBroker.destroy();
    rawGuest.destroy();
    await host.close('test-complete');
  }
});

test('Guest disconnect fails an active leased Broker request', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const rawBroker = await connectRawClient(host.address.port);
  let guest;

  try {
    guest = createVerserNodeGuest({
      hostUrl: `https://localhost:${host.address.port}`,
      guestId: 'guest-active-disconnect-1',
    });
    guest.attach((request) => {
      request.resume();
    }, 'active-disconnect.local.test');
    await guest.connect();

    const brokerStream = rawBroker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'guest-active-disconnect-1',
      'x-verser-request-id': 'req-active-disconnect-1',
      'x-verser-source-id': 'broker-active-disconnect-1',
      'x-verser-method': 'POST',
      'x-verser-path': '/disconnect',
    });
    const failed = new Promise((resolve, reject) => {
      brokerStream.once('response', resolve);
      brokerStream.once('close', resolve);
      brokerStream.once('error', resolve);
      setTimeout(
        () => reject(new Error('active request did not fail after Guest disconnect')),
        500,
      );
    });
    brokerStream.write(Buffer.from('start'));

    await guest.close('active-disconnect-test');
    await failed;
  } finally {
    rawBroker.destroy();
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host maps lease reset before response metadata to a protocol error', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-lease-reset-1' });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-lease-reset-1',
          role: 'guest',
          routedDomains: ['lease-reset.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('lease-reset.local.test');
    await openRawLease(
      rawGuest,
      'guest-lease-reset-1',
      'raw-lease-reset-1',
      (_metadata, _body, lease) => {
        lease.close(http2.constants.NGHTTP2_CANCEL);
      },
    );

    await assert.rejects(
      () => broker.request({ targetId: 'guest-lease-reset-1', method: 'GET', path: '/reset' }),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(error.message, /response metadata|closed/i);
        assert.equal(error.context.targetId, 'guest-lease-reset-1');
        return true;
      },
    );
  } finally {
    await broker.close('test-complete');
    rawGuest.destroy();
    await host.close('test-complete');
  }
});

test('Guest handler failure after response start cancels the Broker response stream', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const rawBroker = await connectRawClient(host.address.port);
  let guest;

  try {
    guest = createVerserNodeGuest({
      hostUrl: `https://localhost:${host.address.port}`,
      guestId: 'guest-post-response-failure-1',
    });
    guest.attach((_request, response) => {
      response.writeHead(200, { 'x-partial': 'yes' });
      response.write(Buffer.from('partial'));
      throw new Error('failed after partial response');
    }, 'post-response-failure.local.test');
    await guest.connect();

    const brokerStream = rawBroker.request({
      ':method': 'POST',
      ':path': '/verser/request',
      'x-verser-target-id': 'guest-post-response-failure-1',
      'x-verser-request-id': 'req-post-response-failure-1',
      'x-verser-source-id': 'broker-post-response-failure-1',
      'x-verser-method': 'GET',
      'x-verser-path': '/post-response-failure',
    });
    const firstChunk = new Promise((resolve, reject) => {
      brokerStream.once('data', (chunk) => resolve(Buffer.from(chunk)));
      brokerStream.once('error', reject);
    });
    const closed = new Promise((resolve, reject) => {
      brokerStream.once('close', resolve);
      setTimeout(() => reject(new Error('Broker response stream was not cancelled')), 500);
    });
    brokerStream.end();

    assert.deepEqual(await firstChunk, Buffer.from('partial'));
    await closed;
  } finally {
    rawBroker.destroy();
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

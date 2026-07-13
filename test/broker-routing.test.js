const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http2 = require('node:http2');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { test: guardedTest } = require('./support/guarded-test.cjs');

const common = require('../packages/verser-common/dist/index.js');
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
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

async function connectRawClient(port) {
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
    stream.on('end', () => resolve(body.length === 0 ? undefined : JSON.parse(body)));
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-routing-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-routing-1' });
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

test('Broker request rejects when a Readable upload body errors', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-upload-error' });
    guest = createGuest({ hostUrl, guestId: 'guest-upload-error' });
    guest.attach((_request, response) => {
      setTimeout(() => response.end('too-late'), 250);
    }, 'upload-error.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('upload-error.local.test');

    const body = new PassThrough();
    const responsePromise = broker.request({
      targetId: 'guest-upload-error',
      method: 'POST',
      path: '/upload',
      body,
    });
    body.destroy(new Error('upload failed'));

    await assert.rejects(() => responsePromise, /upload failed/);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker follows 307 internal redirects to advertised routes and replays request bodies', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let redirectGuest;
  let targetGuest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-redirect-307' });
    redirectGuest = createGuest({ hostUrl, guestId: 'guest-redirect-307-a' });
    targetGuest = createGuest({ hostUrl, guestId: 'guest-redirect-307-b' });
    redirectGuest.attach((_request, response) => {
      response.writeHead(307, { location: 'http://target-307.local.test/final?via=redirect' });
      response.end('redirecting');
    }, 'redirect-307.local.test');
    targetGuest.attach((request, response) => {
      assert.equal(request.headers.host, 'target-307.local.test');
      assert.equal(request.headers['x-forwarded-host'], 'redirect-307.local.test:443');
      assert.equal(request.headers['x-forwarded-for'], '198.51.100.7');
      assert.equal(request.headers.forwarded, 'for=198.51.100.7');
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(209, { 'x-final-path': request.url, 'x-final-method': request.method });
        response.end(Buffer.concat(chunks));
      });
    }, 'target-307.local.test');

    await broker.connect();
    await redirectGuest.connect();
    await targetGuest.connect();
    await broker.waitForRoute('redirect-307.local.test');
    await broker.waitForRoute('target-307.local.test');

    const response = await broker.request({
      targetId: 'guest-redirect-307-a',
      method: 'PATCH',
      path: '/start',
      headers: {
        'x-input': 'redirect',
        host: 'redirect-307.local.test:443',
        'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-for': '198.51.100.7',
        forwarded: 'for=198.51.100.7',
      },
      body: [Buffer.from('first-'), Buffer.from('second')],
    });

    assert.equal(response.statusCode, 209);
    assert.equal(response.headers['x-final-path'], '/final?via=redirect');
    assert.equal(response.headers['x-final-method'], 'PATCH');
    assert.deepEqual(await readBody(response.body), Buffer.from('first-second'));
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (redirectGuest !== undefined) await redirectGuest.close('test-complete');
    if (targetGuest !== undefined) await targetGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker rejects a revoked domain even when the same Guest has another active route', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-domain-revoke' });
  const guest = createGuest({
    hostUrl,
    guestId: 'guest-domain-revoke',
    routedDomains: ['active-domain.local.test', 'revoked-domain.local.test'],
  });

  try {
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('active-domain.local.test');
    await broker.waitForRoute('revoked-domain.local.test');

    const routeRemoved = new Promise((resolve) => {
      const unsubscribe = broker.onRouteChange((event) => {
        if (event.type === 'removed' && event.domain === 'revoked-domain.local.test') {
          unsubscribe();
          resolve();
        }
      });
    });
    const revokeResult = await guest.revokeRoutes(['revoked-domain.local.test']);
    assert.equal(revokeResult.status, 'ack');
    await routeRemoved;
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-domain-revoke', domain: 'active-domain.local.test' },
    ]);
    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-domain-revoke',
          method: 'GET',
          path: '/revoked',
          headers: { host: 'revoked-domain.local.test:443' },
        }),
      /route is not available|missing|revoked/i,
    );
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Node Broker explicit routeDomain authorizes the route while preserving public Host authority', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-explicit-route-domain' });
  const guest = createGuest({ hostUrl, guestId: 'guest-explicit-route-domain' });
  try {
    guest.attach((request, response) => {
      assert.equal(request.headers.host, 'route-domain.local.test');
      assert.equal(request.headers['x-forwarded-host'], 'route-domain.local.test:80');
      assert.equal(request.headers['x-forwarded-for'], '203.0.113.8');
      response.end('ok');
    }, 'route-domain.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('route-domain.local.test');
    const response = await broker.request({
      targetId: 'guest-explicit-route-domain',
      routeDomain: 'route-domain.local.test',
      method: 'GET',
      path: '/explicit',
      headers: {
        host: 'route-domain.local.test:80',
        'x-forwarded-host': 'spoofed.invalid',
        'x-forwarded-for': '203.0.113.8',
      },
    });
    assert.equal(response.statusCode, 200);
    await readBody(response.body);
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker follows 308 internal redirects and enforces configured redirect limits', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let redirectGuest;
  let targetGuest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-redirect-308', maxInternalRedirects: 1 });
    redirectGuest = createGuest({ hostUrl, guestId: 'guest-redirect-308-a' });
    targetGuest = createGuest({ hostUrl, guestId: 'guest-redirect-308-b' });
    redirectGuest.attach((_request, response) => {
      response.writeHead(308, { location: 'http://target-308.local.test/final' });
      response.end();
    }, 'redirect-308.local.test');
    targetGuest.attach((_request, response) => {
      response.writeHead(308, { location: 'http://redirect-308.local.test/again' });
      response.end();
    }, 'target-308.local.test');

    await broker.connect();
    await redirectGuest.connect();
    await targetGuest.connect();
    await broker.waitForRoute('redirect-308.local.test');
    await broker.waitForRoute('target-308.local.test');

    await assert.rejects(
      () => broker.request({ targetId: 'guest-redirect-308-a', method: 'GET', path: '/start' }),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(error.message, /internal redirect limit/i);
        assert.equal(error.context.maxInternalRedirects, 1);
        return true;
      },
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (redirectGuest !== undefined) await redirectGuest.close('test-complete');
    if (targetGuest !== undefined) await targetGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker leaves oversized and unadvertised internal redirect responses client-visible', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createBroker({
      hostUrl,
      brokerId: 'broker-redirect-fallback',
      internalRedirectReplayBufferBytes: 4,
    });
    guest = createGuest({ hostUrl, guestId: 'guest-redirect-fallback' });
    guest.attach((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(307, { location: 'http://not-advertised.local.test/final' });
        response.end('visible redirect');
      });
    }, 'redirect-fallback.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('redirect-fallback.local.test');

    const response = await broker.request({
      targetId: 'guest-redirect-fallback',
      method: 'POST',
      path: '/start',
      body: [Buffer.from('larger-than-limit')],
    });

    assert.equal(response.statusCode, 307);
    assert.equal(response.headers.location, 'http://not-advertised.local.test/final');
    assert.deepEqual(await readBody(response.body), Buffer.from('visible redirect'));
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker returns advertised redirects unchanged when the body exceeds the replay limit', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let redirectGuest;
  let targetGuest;
  let targetHit = false;

  try {
    broker = createBroker({
      hostUrl,
      brokerId: 'broker-redirect-oversized-advertised',
      internalRedirectReplayBufferBytes: 4,
    });
    redirectGuest = createGuest({ hostUrl, guestId: 'guest-redirect-oversized-a' });
    targetGuest = createGuest({ hostUrl, guestId: 'guest-redirect-oversized-b' });
    redirectGuest.attach((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(307, { location: 'http://oversized-target.local.test/final' });
        response.end('too large to replay');
      });
    }, 'oversized-redirect.local.test');
    targetGuest.attach((_request, response) => {
      targetHit = true;
      response.end('should-not-hit-target');
    }, 'oversized-target.local.test');

    await broker.connect();
    await redirectGuest.connect();
    await targetGuest.connect();
    await broker.waitForRoute('oversized-redirect.local.test');
    await broker.waitForRoute('oversized-target.local.test');

    const response = await broker.request({
      targetId: 'guest-redirect-oversized-a',
      method: 'POST',
      path: '/start',
      body: [Buffer.from('larger-than-limit')],
    });

    assert.equal(response.statusCode, 307);
    assert.equal(response.headers.location, 'http://oversized-target.local.test/final');
    assert.deepEqual(await readBody(response.body), Buffer.from('too large to replay'));
    assert.equal(targetHit, false);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (redirectGuest !== undefined) await redirectGuest.close('test-complete');
    if (targetGuest !== undefined) await targetGuest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker maps missing guests and Guest handler failures to actionable errors', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-errors-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-errors-1' });
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-header-validation-1' });

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

test('Broker terminates the original replayable upload source when request setup aborts', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-replay-abort-1' });
  const source = new PassThrough();

  try {
    await broker.connect();
    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-replay-abort-1',
          method: 'POST',
          path: '/abort',
          headers: { connection: 'close' },
          body: source,
        }),
      /forbidden header/i,
    );
    assert.equal(source.destroyed, true);
  } finally {
    await broker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker forwards configured lease acquire timeout to the Host', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-concurrency-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-concurrency-1' });
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

test('Broker receives route degradation after Guest disconnect and route removal after timeout', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 500 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-degraded-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-degraded-1' });
  guest.attach((_request, response) => response.end('ok'), 'degraded.local.test');

  try {
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('degraded.local.test');
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-degraded-1', domain: 'degraded.local.test' },
    ]);

    await guest.close('test-disconnect');

    // Route should become degraded but still visible in broker routes
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('degraded route not visible')), 2000);
      const check = setInterval(() => {
        if (broker.getRoutes().length >= 1) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-degraded-1', domain: 'degraded.local.test' },
    ]);

    // After timeout, route should be removed
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('route removal timed out')), 3000);
      const check = setInterval(() => {
        if (broker.getRoutes().length === 0) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    assert.deepEqual(broker.getRoutes(), []);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker request routes over a raw leased HTTP/2 stream without a Guest control stream', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-raw-lease-1' });
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

test('Host does not hand a closed idle lease to a queued request', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const session = await connectRawClient(host.address.port);
  let broker;
  try {
    await requestJson(session, {
      peerId: 'guest-closed-idle',
      role: 'guest',
      routedDomains: ['closed-idle.local.test'],
    });

    const lease = session.request({
      ':method': 'POST',
      ':path': '/verser/guest/lease',
      'x-verser-peer-id': 'guest-closed-idle',
      'x-verser-lease-id': 'closed-idle-lease',
    });
    await once(lease, 'response');
    const leaseClosed = once(lease, 'close');
    lease.close(http2.constants.NGHTTP2_CANCEL);
    await leaseClosed;
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    broker = await host.attachLocalBroker({ brokerId: 'broker-closed-idle' });
    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-closed-idle',
          method: 'GET',
          path: '/closed-idle',
          headers: { host: 'closed-idle.local.test' },
          leaseAcquireTimeoutMs: 20,
        }),
      (error) => error.code === 'timeout',
    );
  } finally {
    await broker?.close();
    session.destroy();
    await host.close();
  }
});

test('Host isolates active leases when different Guests reuse a lease id', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-duplicate-lease-id-1' });
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
  const host = createHost({ port: 0 });
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-lease-error-1' });
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

test('Host silently strips hop-by-hop response headers from leased metadata', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-response-header-sanitize-1' });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-response-header-sanitize-1',
          role: 'guest',
          routedDomains: ['response-header-sanitize.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('response-header-sanitize.local.test');
    await openRawLease(
      rawGuest,
      'guest-response-header-sanitize-1',
      'raw-lease-response-header-sanitize-1',
      (metadata, _body, lease) => {
        lease.end(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: {
              requestId: metadata.requestId,
              statusCode: 200,
              headers: {
                connection: 'close',
                'x-guest': 'ok',
                'transfer-encoding': 'chunked',
              },
            },
          }),
        );
      },
    );

    const response = await broker.request({
      targetId: 'guest-response-header-sanitize-1',
      method: 'GET',
      path: '/sanitized-response-header',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-guest'], 'ok');
    assert.equal(response.headers.connection, undefined);
    assert.equal(response.headers['transfer-encoding'], undefined);
    await readBody(response.body);
  } finally {
    await broker.close('test-complete');
    rawGuest.destroy();
    await host.close('test-complete');
  }
});

test('Host strips transfer-encoding from streaming leased responses', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-streaming-sanitize-1' });
  const rawGuest = await connectRawClient(host.address.port);

  try {
    await broker.connect();
    assert.equal(
      (
        await requestJson(rawGuest, {
          peerId: 'guest-streaming-sanitize-1',
          role: 'guest',
          routedDomains: ['streaming-sanitize.local.test'],
        })
      ).status,
      'registered',
    );
    await broker.waitForRoute('streaming-sanitize.local.test');
    await openRawLease(
      rawGuest,
      'guest-streaming-sanitize-1',
      'raw-lease-streaming-sanitize-1',
      (metadata, _body, lease) => {
        lease.write(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: {
              requestId: metadata.requestId,
              statusCode: 200,
              headers: { 'transfer-encoding': 'chunked', 'x-streamed': 'yes' },
            },
          }),
        );
        lease.end(Buffer.from('streamed-body'));
      },
    );

    const response = await broker.request({
      targetId: 'guest-streaming-sanitize-1',
      method: 'GET',
      path: '/streaming-sanitize',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-streamed'], 'yes');
    assert.equal(response.headers['transfer-encoding'], undefined);
    assert.deepEqual(await readBody(response.body), Buffer.from('streamed-body'));
  } finally {
    await broker.close('test-complete');
    rawGuest.destroy();
    await host.close('test-complete');
  }
});

test('Host reads split leased response metadata before piping body', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-lease-split-1' });
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
  const host = createHost({ port: 0 });
  await host.start();
  const rawBroker = await connectRawClient(host.address.port);
  let guest;

  try {
    guest = createGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
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
  const host = createHost({ port: 0 });
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-readable-upload-1' });
  let guest;

  try {
    guest = createGuest({
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
  const host = createHost({ port: 0 });
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
  const host = createHost({ port: 0 });
  await host.start();
  const rawBroker = await connectRawClient(host.address.port);
  let guest;

  try {
    guest = createGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-lease-reset-1' });
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
  const host = createHost({ port: 0 });
  await host.start();
  const rawBroker = await connectRawClient(host.address.port);
  let guest;

  try {
    guest = createGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
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

// ================ Phase 3: Route Revocation & Lifecycle Events ================

test('Guest revokeRoutes sends revocation request and receives ACK from Host', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    guest = createGuest({ hostUrl, guestId: 'guest-revoke-ack-1' });
    guest.attach((_req, res) => res.end('ok'), 'revoke-ack-a.local.test');
    broker = createBroker({ hostUrl, brokerId: 'broker-revoke-ack-1' });

    await guest.connect();
    await broker.connect();
    await broker.waitForRoute('revoke-ack-a.local.test');
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-revoke-ack-1', domain: 'revoke-ack-a.local.test' },
    ]);

    // Revoke one route
    const response = await guest.revokeRoutes(['revoke-ack-a.local.test']);

    assert.equal(response.status, 'ack');
    assert.equal(response.message, undefined);

    // Route should be removed from broker snapshot
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('route removal not propagated')), 2000);
      const check = setInterval(() => {
        if (broker.getRoutes().length === 0) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    assert.deepEqual(broker.getRoutes(), []);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Guest revokeRoutes rejects for unregistered domains', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;

  try {
    guest = createGuest({ hostUrl, guestId: 'guest-revoke-error-1' });
    guest.attach((_req, res) => res.end('ok'), 'revoke-error-a.local.test');
    await guest.connect();

    // Revoke a domain that is not registered
    const response = await guest.revokeRoutes(['not-registered.local.test']);

    // Should return error status with failed domains
    assert.equal(response.status, 'error');
    assert.ok(response.failedDomains);
    assert.equal(response.failedDomains.length, 1);
    assert.equal(response.failedDomains[0].domain, 'not-registered.local.test');
  } finally {
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Guest revokeRoutes rejects for empty domain list', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;

  try {
    guest = createGuest({ hostUrl, guestId: 'guest-revoke-empty-1' });
    guest.attach((_req, res) => res.end('ok'), 'revoke-empty.local.test');
    await guest.connect();

    // Revoke with empty list should reject
    await assert.rejects(
      () => guest.revokeRoutes([]),
      (error) => {
        assert.equal(error.code, 'revocation-failed');
        return true;
      },
    );
  } finally {
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Guest revokeRoutes rejects when Guest is not connected', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const guest = createGuest({ hostUrl, guestId: 'guest-revoke-disconnected-1' });

  await assert.rejects(
    () => guest.revokeRoutes(['any.local.test']),
    (error) => {
      assert.equal(error.code, 'disconnected-target');
      return true;
    },
  );

  await host.close('test-complete');
});

test('Broker onRouteChange receives added and removed lifecycle events', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    const routeChanges = [];
    broker = createBroker({ hostUrl, brokerId: 'broker-lifecycle-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-lifecycle-1' });
    guest.attach((_req, res) => res.end('ok'), 'lifecycle-a.local.test');

    await broker.connect();

    broker.onRouteChange((event) => {
      routeChanges.push(event);
    });

    await guest.connect();

    // Wait for the 'added' event
    await broker.waitForRoute('lifecycle-a.local.test');

    // Check that we received an 'added' event
    assert.ok(routeChanges.length >= 1);
    const addedEvent = routeChanges.find((e) => e.type === 'added');
    assert.ok(addedEvent, 'Should have received an added event');
    assert.equal(addedEvent.domain, 'lifecycle-a.local.test');
    assert.equal(addedEvent.targetId, 'guest-lifecycle-1');

    // Revoke and check for 'removed' event
    await guest.revokeRoutes(['lifecycle-a.local.test']);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('removed event not received')), 2000);
      const check = setInterval(() => {
        if (routeChanges.some((e) => e.type === 'removed')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const removedEvent = routeChanges.find((e) => e.type === 'removed');
    assert.ok(removedEvent, 'Should have received a removed event');
    assert.equal(removedEvent.domain, 'lifecycle-a.local.test');
    assert.equal(removedEvent.reason, 'revoked');
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker onRouteChange receives degraded event on Guest disconnect', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 5000 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    const routeChanges = [];
    broker = createBroker({ hostUrl, brokerId: 'broker-lifecycle-degraded-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-lifecycle-degraded-1' });
    guest.attach((_req, res) => res.end('ok'), 'lifecycle-degraded.local.test');

    await broker.connect();
    broker.onRouteChange((event) => {
      routeChanges.push(event);
    });

    await guest.connect();
    await broker.waitForRoute('lifecycle-degraded.local.test');

    // Clear any initial 'added' events
    routeChanges.length = 0;

    // Disconnect the guest
    await guest.close('test-disconnect');

    // Wait for the 'degraded' event
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('degraded event not received')), 2000);
      const check = setInterval(() => {
        if (routeChanges.some((e) => e.type === 'degraded')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const degradedEvent = routeChanges.find((e) => e.type === 'degraded');
    assert.ok(degradedEvent, 'Should have received a degraded event');
    assert.equal(degradedEvent.domain, 'lifecycle-degraded.local.test');
    assert.equal(degradedEvent.reason, 'disconnected');
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker request fails fast for degraded route (Guest disconnected)', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 5000 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-degraded-request-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-degraded-request-1' });
    guest.attach((_req, res) => res.end('ok'), 'degraded-request.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('degraded-request.local.test');

    // Disconnect the guest
    await guest.close('test-disconnect');

    // Wait a brief moment for degradation to propagate
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Request to degraded guest should fail fast
    await assert.rejects(
      () => broker.request({ targetId: 'guest-degraded-request-1', method: 'GET', path: '/test' }),
      (error) => {
        assert.equal(error.code, 'missing-guest');
        return true;
      },
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Same Guest reconnection before timeout restores degraded routes', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 5000 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-restore-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-restore-1' });
    guest.attach((_req, res) => res.end('ok'), 'restore.local.test');

    await broker.connect();
    const routeChanges = [];
    broker.onRouteChange((event) => {
      routeChanges.push(event);
    });

    await guest.connect();
    await broker.waitForRoute('restore.local.test');
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-restore-1', domain: 'restore.local.test' },
    ]);

    // Should have received an 'added' event on initial connection
    assert.ok(
      routeChanges.some((e) => e.type === 'added' && e.domain === 'restore.local.test'),
      'Should have received an added event',
    );

    routeChanges.length = 0; // Clear for the next phase

    // Disconnect the guest
    await guest.close('test-disconnect');

    // Wait for degradation to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Route should still be visible as degraded (not removed yet)
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-restore-1', domain: 'restore.local.test' },
    ]);

    // Should have received a 'degraded' event
    assert.ok(
      routeChanges.some((e) => e.type === 'degraded' && e.domain === 'restore.local.test'),
      'Should have received a degraded event',
    );

    routeChanges.length = 0; // Clear for the next phase

    // Reconnect the same guest
    guest = createGuest({ hostUrl, guestId: 'guest-restore-1' });
    guest.attach((_req, res) => res.end('restored'), 'restore.local.test');

    await guest.connect();

    // Route should be back (restored)
    await broker.waitForRoute('restore.local.test');
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-restore-1', domain: 'restore.local.test' },
    ]);

    // Wait a bit more for any pending lifecycle events to arrive
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have received either a 'changed' or 'added' event for the restored route
    const relevantEvents = routeChanges.filter(
      (e) => (e.type === 'changed' || e.type === 'added') && e.domain === 'restore.local.test',
    );
    assert.ok(
      relevantEvents.length >= 1,
      'Should have at least one changed/added event for restoration',
    );

    // Request to the restored guest should succeed
    const response = await broker.request({
      targetId: 'guest-restore-1',
      method: 'GET',
      path: '/restored',
    });
    assert.equal(response.statusCode, 200);
    const body = await readBody(response.body);
    assert.equal(body.toString(), 'restored');
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Guest revocation enforces ownership - Guest can only revoke own routes', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest1;
  let guest2;
  let broker;

  try {
    guest1 = createGuest({ hostUrl, guestId: 'guest-own-1' });
    guest1.attach((_req, res) => res.end('ok'), 'one.local.test');
    guest2 = createGuest({ hostUrl, guestId: 'guest-own-2' });
    guest2.attach((_req, res) => res.end('ok'), 'two.local.test');
    broker = createBroker({ hostUrl, brokerId: 'broker-own-1' });

    await guest1.connect();
    await guest2.connect();
    await broker.connect();
    await broker.waitForRoute('one.local.test');
    await broker.waitForRoute('two.local.test');

    assert.equal(broker.getRoutes().length, 2);

    // Guest 1 tries to revoke Guest 2's route
    const response = await guest1.revokeRoutes(['two.local.test']);

    // Should return error since guest1 doesn't own two.local.test
    assert.equal(response.status, 'error');
    assert.ok(response.failedDomains);
    assert.equal(response.failedDomains[0].domain, 'two.local.test');

    // Guest 2's route should still be there
    assert.ok(broker.getRoutes().some((r) => r.domain === 'two.local.test'));

    // Guest 1 can revoke its own route
    const ownResponse = await guest1.revokeRoutes(['one.local.test']);
    assert.equal(ownResponse.status, 'ack');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('route removal not propagated')), 2000);
      const check = setInterval(() => {
        if (!broker.getRoutes().some((r) => r.domain === 'one.local.test')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest1 !== undefined) await guest1.close('test-complete');
    if (guest2 !== undefined) await guest2.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker onRouteChange receives lifecycle events for route added, removed, degraded, changed', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 5000 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    const routeChanges = [];
    broker = createBroker({ hostUrl, brokerId: 'broker-lifecycle-all-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-lifecycle-all-1' });
    guest.attach((_req, res) => res.end('ok'), 'lifecycle-all.local.test');

    await broker.connect();
    broker.onRouteChange((event) => {
      routeChanges.push(event);
    });

    // 1. Added event
    await guest.connect();
    await broker.waitForRoute('lifecycle-all.local.test');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('added event not received')), 2000);
      const check = setInterval(() => {
        if (routeChanges.some((e) => e.type === 'added')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // 2. Degraded event on disconnect
    await guest.close('test-disconnect');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('degraded event not received')), 2000);
      const check = setInterval(() => {
        if (routeChanges.some((e) => e.type === 'degraded')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // 3. Changed (restored) event on reconnect
    guest = createGuest({ hostUrl, guestId: 'guest-lifecycle-all-1' });
    guest.attach((_req, res) => res.end('ok'), 'lifecycle-all.local.test');
    await guest.connect();
    await broker.waitForRoute('lifecycle-all.local.test');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('changed event not received')), 2000);
      const check = setInterval(() => {
        if (routeChanges.some((e) => e.type === 'changed')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // 4. Removed event on revocation
    await guest.revokeRoutes(['lifecycle-all.local.test']);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('removed event not received')), 2000);
      const check = setInterval(() => {
        if (routeChanges.some((e) => e.type === 'removed')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // Verify we have all event types
    const types = routeChanges.map((e) => e.type);
    assert.ok(types.includes('added'), 'should have added event');
    assert.ok(types.includes('degraded'), 'should have degraded event');
    assert.ok(types.includes('changed'), 'should have changed event');
    assert.ok(types.includes('removed'), 'should have removed event');
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

// ================ P1 Regression: spoofed revocation rejection ================

test('P1: Broker cannot spoof x-verser-peer-id to revoke another Guest routes', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;
  let rawBrokerSession;

  try {
    guest = createGuest({ hostUrl, guestId: 'guest-spoof-target' });
    guest.attach((_req, res) => res.end('ok'), 'spoof-target.local.test');
    await guest.connect();

    broker = createBroker({ hostUrl, brokerId: 'broker-spoof-attacker' });
    await broker.connect();
    await broker.waitForRoute('spoof-target.local.test');
    assert.equal(broker.getRoutes().length, 1);

    // Attacker opens a raw H2 session (Broker/not-registered) and sends a
    // revocation request WITH the victim's Guest ID as x-verser-peer-id.
    // The Host finds the victim's peer entry but the stream session does
    // NOT match the victim's registered session — session-binding must reject.
    rawBrokerSession = await connectRawClient(host.address.port);
    const revokeResponse = await requestJsonWithHeaders(
      rawBrokerSession,
      {
        ':method': 'POST',
        ':path': '/verser/guest/revoke',
        'x-verser-peer-id': 'guest-spoof-target',
        'content-type': 'application/json',
      },
      JSON.stringify({ domains: ['spoof-target.local.test'] }),
    );

    // Host must reject with session mismatch (peer exists but wrong session)
    assert.equal(revokeResponse.status, 'error');
    assert.match(
      revokeResponse.message || '',
      /session mismatch/i,
      `Expected session-mismatch rejection, got: ${revokeResponse.message}`,
    );

    // Victim's route must survive
    assert.equal(broker.getRoutes().length, 1);
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-spoof-target', domain: 'spoof-target.local.test' },
    ]);
  } finally {
    if (rawBrokerSession) rawBrokerSession.destroy();
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('P1: Another H2 Guest session cannot spoof x-verser-peer-id to revoke different Guest routes', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let victimGuest;
  let attackerGuest;
  let broker;

  try {
    victimGuest = createGuest({ hostUrl, guestId: 'guest-spoof-victim' });
    victimGuest.attach((_req, res) => res.end('ok'), 'victim.local.test');
    attackerGuest = createGuest({ hostUrl, guestId: 'guest-spoof-attacker' });
    attackerGuest.attach((_req, res) => res.end('ok'), 'attacker.local.test');

    await victimGuest.connect();
    await attackerGuest.connect();

    broker = createBroker({ hostUrl, brokerId: 'broker-spoof-guest' });
    await broker.connect();
    await broker.waitForRoute('victim.local.test');
    await broker.waitForRoute('attacker.local.test');
    assert.equal(broker.getRoutes().length, 2);

    // Attacker opens a raw H2 session (on a different connection) and
    // registers as itself. Then, on that same session, sends a revocation
    // request WITH the victim's Guest ID as x-verser-peer-id.
    // The Host finds the victim's peer entry but the stream session (attacker's
    // session) does NOT match the victim's registered session — session-binding
    // must reject.
    const rawAttacker = await connectRawClient(host.address.port);
    await requestJson(rawAttacker, {
      peerId: 'guest-spoof-attacker',
      role: 'guest',
      routedDomains: ['attacker.local.test'],
    });

    const revokeResponse = await requestJsonWithHeaders(
      rawAttacker,
      {
        ':method': 'POST',
        ':path': '/verser/guest/revoke',
        'x-verser-peer-id': 'guest-spoof-victim',
        'content-type': 'application/json',
      },
      JSON.stringify({ domains: ['victim.local.test'] }),
    );

    // Must reject with session mismatch (peer found but wrong session)
    assert.equal(revokeResponse.status, 'error');
    assert.match(
      revokeResponse.message || '',
      /session mismatch/i,
      `Expected session-mismatch rejection, got: ${revokeResponse.message}`,
    );

    // Both routes must survive
    assert.ok(broker.getRoutes().some((r) => r.domain === 'victim.local.test'));
    assert.ok(broker.getRoutes().some((r) => r.domain === 'attacker.local.test'));
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (victimGuest !== undefined) await victimGuest.close('test-complete');
    if (attackerGuest !== undefined) await attackerGuest.close('test-complete');
    await host.close('test-complete');
  }
});

// ================ Duplicate domain revocation ================

test('Revocation with duplicate domain inputs returns deterministic response', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-dup-revoke-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-dup-revoke-1' });
    guest.attach((_req, res) => res.end('ok'), 'dup.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('dup.local.test');

    // Revoke with duplicate domain entries
    const response = await guest.revokeRoutes(['dup.local.test', 'dup.local.test']);

    // The duplicate is silently deduplicated by the host route registry:
    // only one revocation attempt is recorded. The comparison against
    // the original request length (2) triggers a 'partial' status with
    // no failedDomains because all unique domains succeeded.
    assert.equal(response.status, 'partial');
    assert.equal(
      response.failedDomains,
      undefined,
      'Deduplication should not produce failedDomains',
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

// ================ P1 Regression: reconnect restore domain changes ================

test('P1: Guest reconnects with empty routedDomains — no stale route restoration', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 5000 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-reconnect-empty-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-reconnect-empty' });
    guest.attach((_req, res) => res.end('ok'), 'stale.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('stale.local.test');
    assert.equal(broker.getRoutes().length, 1);

    // Disconnect
    await guest.close('test-disconnect');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Route should be degraded but still visible
    assert.equal(broker.getRoutes().length, 1);

    // Reconnect with NO routes (empty routedDomains, no attach)
    guest = createGuest({
      hostUrl,
      guestId: 'guest-reconnect-empty',
      routedDomains: [],
    });

    await guest.connect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Stale route must NOT be restored
    assert.equal(
      broker.getRoutes().length,
      0,
      'Stale degraded route must not be restored when Guest reconnects with empty routedDomains',
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('P1: Guest reconnects with different domains — emits correct lifecycle events', async () => {
  const host = createHost({ port: 0, degradedRouteTimeoutMs: 5000 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let guest;
  let broker;

  try {
    const routeChanges = [];
    broker = createBroker({ hostUrl, brokerId: 'broker-reconnect-diff-1' });
    guest = createGuest({ hostUrl, guestId: 'guest-reconnect-diff' });
    guest.attach((_req, res) => res.end('ok'), 'alpha.local.test');

    await broker.connect();
    broker.onRouteChange((event) => routeChanges.push(event));

    await guest.connect();
    await broker.waitForRoute('alpha.local.test');
    assert.equal(broker.getRoutes().length, 1);

    // Disconnect
    await guest.close('test-disconnect');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Route should be degraded
    assert.equal(broker.getRoutes().length, 1);
    routeChanges.length = 0;

    // Reconnect with a DIFFERENT domain
    guest = createGuest({ hostUrl, guestId: 'guest-reconnect-diff' });
    guest.attach((_req, res) => res.end('ok'), 'beta.local.test');

    await guest.connect();
    await broker.waitForRoute('beta.local.test');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Broker should see only beta.local.test
    const routes = broker.getRoutes();
    assert.equal(routes.length, 1);
    assert.equal(
      routes[0].domain,
      'beta.local.test',
      `Expected only beta.local.test, got: ${JSON.stringify(routes)}`,
    );

    // alpha.local.test must get a 'removed' event, beta.local.test an 'added' event,
    // and alpha must NOT get a 'changed' event
    const removedEvents = routeChanges.filter(
      (e) => e.type === 'removed' && e.domain === 'alpha.local.test',
    );
    const addedEvents = routeChanges.filter(
      (e) => e.type === 'added' && e.domain === 'beta.local.test',
    );
    const changedAlphaEvents = routeChanges.filter(
      (e) => e.type === 'changed' && e.domain === 'alpha.local.test',
    );

    assert.ok(
      removedEvents.length >= 1,
      `Should have removed event for stale alpha.local.test, got: ${JSON.stringify(routeChanges)}`,
    );
    assert.ok(
      addedEvents.length >= 1,
      `Should have added event for new beta.local.test, got: ${JSON.stringify(routeChanges)}`,
    );
    assert.equal(
      changedAlphaEvents.length,
      0,
      'Should NOT have changed event for stale alpha.local.test',
    );
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Rejected onRouteChange listener does not break subsequent lifecycle events or route snapshots', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createBroker({ hostUrl, brokerId: 'broker-throwing-listener' });
    guest = createGuest({ hostUrl, guestId: 'guest-throwing-listener' });
    guest.attach((_req, res) => res.end('ok'), 'throwing.local.test');

    await broker.connect();

    // Register a listener that rejects on every call. EventEmitter
    // captureRejections should route this to the internal error handler without
    // disrupting protocol processing or subsequent listeners.
    const goodEvents = [];
    broker.onRouteChange(async () => {
      throw new Error('listener rejection');
    });
    broker.onRouteChange((event) => goodEvents.push(event));

    await guest.connect();
    await broker.waitForRoute('throwing.local.test');

    // The good listener should have received the 'added' event despite the
    // rejecting listener
    assert.ok(
      goodEvents.some((e) => e.type === 'added' && e.domain === 'throwing.local.test'),
      `Expected added event despite rejecting listener, got: ${JSON.stringify(goodEvents)}`,
    );

    // Route snapshot must still be consistent
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-throwing-listener', domain: 'throwing.local.test' },
    ]);

    // Revoke should also work — the rejecting listener should not prevent the
    // route from being removed from the snapshot or the good listener from
    // receiving the removed event
    goodEvents.length = 0;
    await guest.revokeRoutes(['throwing.local.test']);

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(
      goodEvents.some((e) => e.type === 'removed' && e.domain === 'throwing.local.test'),
      `Expected removed event despite rejecting listener, got: ${JSON.stringify(goodEvents)}`,
    );
    assert.deepEqual(broker.getRoutes(), []);
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

// ================ Characterization: Large Streaming Bodies ================

guardedTest(
  'broker.request streams multi-megabyte request body without full buffering',
  async () => {
    const host = createHost({ port: 0 });
    await host.start();
    const hostUrl = `https://127.0.0.1:${host.address.port}`;
    const broker = createBroker({ hostUrl, brokerId: 'broker-large-upload-1' });
    let guest;

    try {
      guest = createGuest({ hostUrl, guestId: 'guest-large-upload-1' });
      let receivedBytes = 0;
      guest.attach((request, response) => {
        request.on('data', (chunk) => {
          receivedBytes += chunk.length;
        });
        request.on('end', () => {
          response.writeHead(200, { 'x-received-bytes': String(receivedBytes) });
          response.end('ok');
        });
      }, 'large-upload.local.test');
      await broker.connect();
      await guest.connect();
      await broker.waitForRoute('large-upload.local.test');

      const body = new PassThrough();
      const responsePromise = broker.request({
        targetId: 'guest-large-upload-1',
        method: 'POST',
        path: '/large-upload',
        body,
      });

      // Write 2MB in bounded chunks, respecting PassThrough backpressure.
      const chunkSize = 32 * 1024;
      const totalSize = 2 * 1024 * 1024;
      for (let offset = 0; offset < totalSize; offset += chunkSize) {
        if (!body.write(Buffer.alloc(chunkSize, 'a'))) {
          await new Promise((resolve) => body.once('drain', resolve));
        }
      }
      body.end();

      const response = await responsePromise;
      assert.equal(response.statusCode, 200);
      assert.equal(Number(response.headers['x-received-bytes']), totalSize);
      assert.deepEqual(await readBody(response.body), Buffer.from('ok'));
    } finally {
      await broker.close('test-complete');
      if (guest !== undefined) await guest.close('test-complete');
      await host.close('test-complete');
    }
  },
);

guardedTest(
  'broker.request streams multi-megabyte response body without full buffering',
  async () => {
    const host = createHost({ port: 0 });
    await host.start();
    const hostUrl = `https://127.0.0.1:${host.address.port}`;
    const broker = createBroker({ hostUrl, brokerId: 'broker-large-download-1' });
    let guest;

    try {
      const chunkSize = 64 * 1024;
      const totalSize = 2 * 1024 * 1024;
      const expectedHash = createHash('sha256');
      for (let offset = 0; offset < totalSize; offset += chunkSize) {
        expectedHash.update(Buffer.alloc(chunkSize, 'b'));
      }

      guest = createGuest({ hostUrl, guestId: 'guest-large-download-1' });
      guest.attach((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        let offset = 0;
        const writeNext = () => {
          if (offset >= totalSize) {
            response.end();
            return;
          }
          offset += chunkSize;
          if (!response.write(Buffer.alloc(chunkSize, 'b'))) {
            response.once('drain', writeNext);
          } else {
            setImmediate(writeNext);
          }
        };
        writeNext();
      }, 'large-download.local.test');
      await broker.connect();
      await guest.connect();
      await broker.waitForRoute('large-download.local.test');

      const response = await broker.request({
        targetId: 'guest-large-download-1',
        method: 'GET',
        path: '/large-download',
      });

      assert.equal(response.statusCode, 200);
      const receivedHash = createHash('sha256');
      let receivedBytes = 0;
      await new Promise((resolve, reject) => {
        response.body.on('data', (chunk) => {
          receivedBytes += chunk.length;
          receivedHash.update(chunk);
        });
        response.body.once('end', resolve);
        response.body.once('error', reject);
      });
      assert.equal(receivedBytes, totalSize);
      assert.equal(receivedHash.digest('hex'), expectedHash.digest('hex'));
    } finally {
      await broker.close('test-complete');
      if (guest !== undefined) await guest.close('test-complete');
      await host.close('test-complete');
    }
  },
);

// ================ Characterization: Half-Open / Early Response ================

test('broker.request delivers response headers and body before request body ends (half-open)', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-half-open-1' });
  let guest;

  try {
    guest = createGuest({ hostUrl, guestId: 'guest-half-open-1' });
    guest.attach((request, response) => {
      response.writeHead(200, { 'x-half-open': 'yes' });
      response.write(Buffer.from('early-response'));
      request.resume();
      request.on('end', () => {
        response.end();
      });
    }, 'half-open.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('half-open.local.test');

    const body = new PassThrough();
    const responsePromise = broker.request({
      targetId: 'guest-half-open-1',
      method: 'POST',
      path: '/half-open',
      body,
    });

    body.write(Buffer.from('trigger'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('half-open response was not delivered before request body end')),
          200,
        ),
      ),
    ]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-half-open'], 'yes');
    assert.deepEqual(await readNextChunk(response.body), Buffer.from('early-response'));
    body.end(Buffer.from('tail'));
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('broker.request cleans an upload source after early response and mid-upload H2 abort', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-early-abort-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-early-abort-1' });
  const body = new PassThrough();

  try {
    guest.attach((_request, response) => {
      response.writeHead(200);
      response.end('early');
    }, 'early-abort.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('early-abort.local.test');

    const responsePromise = broker.request({
      targetId: 'guest-early-abort-1',
      method: 'POST',
      path: '/early-abort',
      body,
    });
    body.write(Buffer.alloc(1024));
    const response = await responsePromise;
    assert.equal(response.statusCode, 200);
    response.body.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(body.destroyed, true);
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

// ================ Characterization: Route Revocation During Active Stream ================

test('Guest route revocation soft-removes the route without cancelling an active HTTP lease', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-revoke-active-1' });
  const guest = createGuest({
    hostUrl,
    guestId: 'guest-revoke-active-1',
    routedDomains: ['revoke-active.local.test', 'keep-active.local.test'],
  });

  try {
    let postRevokeDataResolve;
    const postRevokeData = new Promise((resolve) => {
      postRevokeDataResolve = resolve;
    });
    let preRevokeDataResolve;
    const preRevokeData = new Promise((resolve) => {
      preRevokeDataResolve = resolve;
    });
    let seenRevocation = false;

    guest.attach((request, response) => {
      request.on('data', (chunk) => {
        if (seenRevocation) {
          // Resolve when the specific post-revocation data chunk arrives
          if (chunk.toString('utf8').includes('more-data')) {
            postRevokeDataResolve();
          }
        } else {
          // Resolve on the first pre-revocation data chunk
          if (chunk.toString('utf8').includes('start')) {
            preRevokeDataResolve();
          }
        }
      });
    }, 'revoke-active.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('revoke-active.local.test');

    const body = new PassThrough();
    const requestPromise = broker.request({
      targetId: 'guest-revoke-active-1',
      method: 'POST',
      path: '/revoke-during-stream',
      headers: { host: 'revoke-active.local.test' },
      body,
    });

    // Set up the rejection handler eagerly to avoid unhandled rejection
    const requestErrorPromise = requestPromise.then(
      () => {
        throw new Error('request should have failed');
      },
      (error) => error,
    );

    // Write the first chunk before revocation
    body.write(Buffer.from('start'));

    // Wait for the first data chunk to arrive at the guest handler
    await Promise.race([
      preRevokeData,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('pre-revocation data did not arrive')), 200),
      ),
    ]);

    // Revoke the route
    const revokeResult = await guest.revokeRoutes(['revoke-active.local.test']);
    assert.equal(revokeResult.status, 'ack');

    // Signal the handler that revocation has occurred
    seenRevocation = true;

    // Revocation soft-removes the route but does not close an active lease.
    // The request should still be alive after revocation.
    // Write more data and prove it arrives at the guest handler specifically after revocation.
    body.write(Buffer.from('more-data'));

    // Wait for the post-revocation data to arrive with a short timeout
    await Promise.race([
      postRevokeData,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'post-revocation data was not received — revocation may have cancelled the stream',
              ),
            ),
          100,
        ),
      ),
    ]);

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-revoke-active-1',
          method: 'GET',
          path: '/after-revocation',
          headers: { host: 'revoke-active.local.test' },
        }),
      (error) => error.code === 'missing-guest',
    );

    // Only Guest disconnect closes the active lease stream
    await guest.close('test-disconnect');

    // Now the request should fail
    const error = await requestErrorPromise;
    assert.match(error.message, /closed|disconnect|metadata|lease/i);
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

// ================ Characterization: Broker Abort Propagation to Guest Handler ================

test('Broker request abort propagates as an error event to Guest handler request stream', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-abort-guest-2' });
  const guest = createGuest({ hostUrl, guestId: 'guest-abort-guest-2' });

  try {
    let requestError;
    let requestErrorResolve;
    const requestErrorEvent = new Promise((resolve) => {
      requestErrorResolve = resolve;
    });
    const requestClosed = new Promise((resolve) => {
      guest.attach((request, response) => {
        request.resume();
        request.once('error', (err) => {
          requestError = err;
          requestErrorResolve();
        });
        request.once('close', () => {
          resolve();
        });
      }, 'abort-guest.local.test');
    });

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('abort-guest.local.test');

    const rawBrokerSession = await connectRawClient(host.address.port);
    try {
      const brokerStream = rawBrokerSession.request({
        ':method': 'POST',
        ':path': '/verser/request',
        'x-verser-target-id': 'guest-abort-guest-2',
        'x-verser-request-id': 'req-abort-guest-2',
        'x-verser-source-id': 'broker-abort-guest-2',
        'x-verser-method': 'POST',
        'x-verser-path': '/abort-test',
      });
      brokerStream.write(Buffer.from('body'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      brokerStream.close(http2.constants.NGHTTP2_CANCEL);

      // The lease stream closes, detected via request.on('close')
      await Promise.race([
        requestClosed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Guest request stream was not closed after Broker abort')),
            1000,
          ),
        ),
      ]);

      // Wait for error event to fire (it fires after close due to H2 event ordering)
      await Promise.race([
        requestErrorEvent,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Error event did not fire after close')), 500),
        ),
      ]);

      // The request SHOULD receive an explicit error event with stream-failure code
      assert.notEqual(
        requestError,
        undefined,
        'Expected error event — Broker abort should propagate as Guest request error',
      );
      assert.equal(requestError.code, 'stream-failure');
      assert.match(requestError.message, /cancelled|cancel/i);
    } finally {
      rawBrokerSession.destroy();
    }
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

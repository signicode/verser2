const assert = require('node:assert/strict');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');

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

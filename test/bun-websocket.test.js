const assert = require('node:assert/strict');
const test = require('./support/guarded-test.cjs');
const {
  loadVerserGuestBun,
  loadVerserHost,
  loadVerserGuestNode,
} = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserBunGuest, createVerserBroker } = loadVerserGuestBun();
const { createVerserBroker: createNodeBroker } = loadVerserGuestNode();
const { createVerserHost } = loadVerserHost();

// Warm up TLS/HTTP2 session setup before any guarded test to avoid one-time
// memory costs polluting the first test's growth measurement.
test.before(async () => {
  const warmupHost = createVerserHost({
    port: 0,
    tls: { cert: trusted.certificate, key: trusted.key },
  });
  await warmupHost.start();
  const warmupUrl = `https://127.0.0.1:${warmupHost.address.port}`;
  const warmupBroker = createVerserBroker({
    hostUrl: warmupUrl,
    brokerId: 'bun-warmup-broker',
    tls: { ca: trusted.certificate },
  });
  const warmupGuest = createVerserBunGuest({
    hostUrl: warmupUrl,
    guestId: 'bun-warmup-guest',
    tls: { ca: trusted.certificate },
  });
  try {
    await warmupBroker.connect();
    await warmupGuest.connect();
  } finally {
    await warmupBroker.close('warmup');
    await warmupGuest.close('warmup');
    await warmupHost.close('warmup');
  }
});

function host(options = {}) {
  return createVerserHost({
    ...options,
    tls: { cert: trusted.certificate, key: trusted.key, ...options.tls },
  });
}

function broker(factory, hostUrl, brokerId) {
  return factory({ hostUrl, brokerId, tls: { ca: trusted.certificate } });
}

function guest(hostUrl, guestId, domain, wsOptions = {}, events = []) {
  const value = createVerserBunGuest({
    hostUrl,
    guestId,
    tls: { ca: trusted.certificate },
  });
  value.attach(
    {
      fetch(request, server) {
        if (new URL(request.url).pathname === '/socket') {
          server.upgrade(request, wsOptions);
          return undefined;
        }
        if (new URL(request.url).pathname === '/http') return new Response('http-ok');
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(socket) {
          events.push({ type: 'open', data: socket.data, protocol: socket.protocol });
        },
        message(socket, message) {
          events.push({ type: typeof message === 'string' ? 'text' : 'binary' });
          void socket.send(message);
        },
        drain() {
          events.push({ type: 'drain' });
        },
        close(_socket, code, reason) {
          events.push({ type: 'close', code, reason });
        },
        error(_socket, error) {
          events.push({ type: 'error', message: error.message });
        },
      },
    },
    domain,
  );
  return value;
}

async function roundTrip(brokerValue, targetId, domain) {
  const socket = await brokerValue.webSocket({ targetId, domain, path: '/socket' });
  try {
    const received = new Promise((resolve) => {
      if (typeof socket.once === 'function') socket.once('message', (data) => resolve(data));
      else socket.onmessage = (event) => resolve(event.data);
    });
    socket.send('bun-vws', { type: 'text' });
    assert.equal(await received, 'bun-vws');
  } finally {
    if (typeof socket.onmessage === 'function') socket.onmessage = null;
    if (typeof socket.onclose === 'function') socket.onclose = null;
    if (typeof socket.onerror === 'function') socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
  return socket;
}

test('Bun Guest accepts a local VWS/1 upgrade and Bun Broker can echo', async () => {
  const manager = host({ port: 0 });
  await manager.start();
  const hostUrl = `https://127.0.0.1:${manager.address.port}`;
  const brokerValue = broker(createVerserBroker, hostUrl, 'bun-local-broker');
  const events = [];
  const guestValue = guest(
    hostUrl,
    'bun-local-guest',
    'bun-local.test',
    { data: { source: 'test' }, protocol: 'bun.v1' },
    events,
  );
  /** @type {import('./support/verser-package-imports.cjs').VerserBunWebSocket | undefined} */
  let socket;
  /** @type {import('./support/verser-package-imports.cjs').NativeVerserWebSocket | undefined} */
  let nativeSocket;
  try {
    await brokerValue.connect();
    await guestValue.connect();
    await brokerValue.waitForRoute('bun-local.test');
    socket = await brokerValue.webSocket({
      targetId: 'bun-local-guest',
      domain: 'bun-local.test',
      path: '/socket?query=ignored',
      protocol: 'bun.v1',
    });
    assert.equal(socket.protocol, 'bun.v1');
    const text = new Promise((resolve) => socket.once('message', resolve));
    await socket.send('bun-text', { type: 'text' });
    assert.equal(await text, 'bun-text');
    const binary = new Promise((resolve) => socket.once('message', resolve));
    await socket.send(Buffer.from([0, 255, 7]), { type: 'binary' });
    assert.deepEqual(Buffer.from(await binary), Buffer.from([0, 255, 7]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events[0], { type: 'open', data: { source: 'test' }, protocol: 'bun.v1' });
    assert.ok(events.some((event) => event.type === 'text'));
    assert.ok(events.some((event) => event.type === 'binary'));
    assert.ok(events.some((event) => event.type === 'drain'));
    socket.close(1000, 'done');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.some((event) => event.type === 'close' && event.code === 1000));
    nativeSocket = await brokerValue.nativeWebSocket({
      targetId: 'bun-local-guest',
      domain: 'bun-local.test',
      path: '/socket',
      protocol: 'bun.v1',
    });
    const nativeMessage = new Promise((resolve) => {
      nativeSocket.addEventListener('message', (event) => resolve(event.data));
    });
    nativeSocket.send('native-bun');
    assert.equal(await nativeMessage, 'native-bun');
    nativeSocket.close();
    const httpResponse = await brokerValue.createFetch()('http://bun-local.test/http');
    assert.equal(await httpResponse.text(), 'http-ok');
  } finally {
    if (socket !== undefined) {
      try {
        socket.close(1000, 'cleanup');
      } catch {
        /* already closed */
      }
    }
    if (nativeSocket !== undefined) {
      nativeSocket.onmessage = null;
      nativeSocket.onclose = null;
      nativeSocket.onerror = null;
      try {
        nativeSocket.close(1000, 'cleanup');
      } catch {
        /* already closed */
      }
    }
    await brokerValue.close('test');
    await guestValue.close('test');
    await manager.close('test');
  }
});

test('Bun Guest WebSocket upgrades work through direct and federated routes', async () => {
  const root = host({ port: 0, hostId: 'bun-root' });
  const middle = host({ port: 0, hostId: 'bun-middle' });
  const leaf = host({ port: 0, hostId: 'bun-leaf' });
  await root.start();
  await middle.start();
  await leaf.start();
  const rootUrl = `https://127.0.0.1:${root.address.port}`;
  const middleUrl = `https://127.0.0.1:${middle.address.port}`;
  const leafUrl = `https://127.0.0.1:${leaf.address.port}`;
  const directBroker = broker(createNodeBroker, rootUrl, 'bun-direct-broker');
  const federatedBroker = broker(createVerserBroker, rootUrl, 'bun-federated-broker');
  const directGuest = guest(middleUrl, 'bun-direct-guest', 'bun-direct.test');
  const federatedGuest = guest(leafUrl, 'bun-federated-guest', 'bun-federated.test');
  try {
    await directBroker.connect();
    await federatedBroker.connect();
    await middle.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    await leaf.connectUpstream({
      upstreamId: 'middle',
      url: middleUrl,
      tls: { ca: trusted.certificate },
    });
    await directGuest.connect();
    await federatedGuest.connect();
    await directBroker.waitForRoute('bun-direct.test');
    await federatedBroker.waitForRoute('bun-federated.test');
    await roundTrip(directBroker, 'bun-direct-guest', 'bun-direct.test');
    await roundTrip(federatedBroker, 'bun-federated-guest', 'bun-federated.test');
  } finally {
    await directBroker.close('test');
    await federatedBroker.close('test');
    await directGuest.close('test');
    await federatedGuest.close('test');
    await leaf.close('test');
    await middle.close('test');
    await root.close('test');
  }
});

test('Bun upgrade explicitly rejects unavailable and no-response endpoints', async () => {
  const manager = host({ port: 0 });
  await manager.start();
  const hostUrl = `https://127.0.0.1:${manager.address.port}`;
  const brokerValue = broker(createVerserBroker, hostUrl, 'bun-reject-broker');
  const rejectedEvents = [];
  const guestValue = createVerserBunGuest({
    hostUrl,
    guestId: 'bun-reject-guest',
    tls: { ca: trusted.certificate },
  });
  guestValue.attach(
    {
      fetch: (request) =>
        new URL(request.url).pathname === '/reject'
          ? new Response('unavailable', { status: 404 })
          : undefined,
      websocket: {
        open: () => rejectedEvents.push('open'),
        close: () => rejectedEvents.push('close'),
        error: () => rejectedEvents.push('error'),
      },
    },
    'bun-reject.test',
  );
  try {
    await brokerValue.connect();
    await guestValue.connect();
    await brokerValue.waitForRoute('bun-reject.test');
    await assert.rejects(
      brokerValue.webSocket({
        targetId: 'bun-reject-guest',
        domain: 'bun-reject.test',
        path: '/reject',
      }),
      (error) => {
        assert.equal(error.code, 'missing-guest');
        assert.equal(error.context.targetId, 'bun-reject-guest');
        assert.equal(error.context.domain, 'bun-reject.test');
        assert.equal(error.context.status, 404);
        return true;
      },
    );
    await assert.rejects(
      brokerValue.webSocket({ targetId: 'bun-reject-guest', domain: 'bun-reject.test' }),
      (error) => {
        assert.equal(error.code, 'websocket-negotiation-failed');
        assert.equal(error.context.targetId, 'bun-reject-guest');
        assert.equal(error.context.domain, 'bun-reject.test');
        return true;
      },
    );
    assert.deepEqual(rejectedEvents, []);
  } finally {
    await brokerValue.close('test');
    await guestValue.close('test');
    await manager.close('test');
  }
});

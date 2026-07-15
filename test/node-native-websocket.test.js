const assert = require('node:assert/strict');
const test = require('./support/guarded-test.cjs');
const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker, createVerserNodeGuest } = loadVerserGuestNode();

function createHost(options = {}) {
  return createVerserHost({
    ...options,
    port: 0,
    tls: { cert: trusted.certificate, key: trusted.key },
  });
}

function createBroker(hostUrl, brokerId) {
  return createVerserBroker({ hostUrl, brokerId, tls: { ca: trusted.certificate } });
}

function createGuest(hostUrl, guestId) {
  return createVerserNodeGuest({ hostUrl, guestId, tls: { ca: trusted.certificate } });
}

test.before(async () => {
  const host = createHost();
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker(hostUrl, 'native-warmup-broker');
  const guest = createGuest(hostUrl, 'native-warmup-guest');
  await broker.connect();
  await guest.connect();
  await broker.close('warmup');
  await guest.close('warmup');
  await host.close('warmup');
});

test('Node native WebSocket adapter supports EventTarget events and binaryType conversion', async () => {
  const host = createHost();
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker(hostUrl, 'native-broker');
  const guest = createGuest(hostUrl, 'native-guest');
  try {
    guest.attachNativeWebSocket((_open, ws) => {
      ws.addEventListener('message', (event) => ws.send(event.data));
    }, 'native.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('native.local.test');

    const ws = await broker.nativeWebSocket({
      targetId: 'native-guest',
      domain: 'native.local.test',
    });
    assert.equal(ws.readyState, ws.OPEN);
    ws.binaryType = 'arraybuffer';
    const received = new Promise((resolve) => {
      ws.addEventListener('message', (event) => resolve(event.data));
    });
    ws.send(Buffer.from([0, 255, 127]));
    const value = await received;
    assert.ok(value instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(value)], [0, 255, 127]);
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
    ws.close();
    assert.equal(ws.readyState, ws.CLOSING);
    await closed;
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Node native Guest callback failure rejects the open and closes cleanly', async () => {
  const host = createHost();
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker(hostUrl, 'native-error-broker');
  const guest = createGuest(hostUrl, 'native-error-guest');
  try {
    guest.attachNativeWebSocket(() => {
      throw new Error('native callback failed');
    }, 'native-error.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('native-error.local.test');
    await assert.rejects(
      broker.nativeWebSocket({
        targetId: 'native-error-guest',
        domain: 'native-error.local.test',
      }),
      /closed|handshake|error/i,
    );
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

async function assertNativeRoundTrip(broker, targetId, domain) {
  const ws = await broker.nativeWebSocket({ targetId, domain, protocol: 'native.v1' });
  assert.equal(ws.protocol, 'native.v1');
  const text = new Promise((resolve) =>
    ws.addEventListener('message', (event) => resolve(event.data)),
  );
  ws.send('remote-text');
  assert.equal(await text, 'remote-text');
  ws.binaryType = 'arraybuffer';
  const binary = new Promise((resolve) =>
    ws.addEventListener('message', (event) => resolve(event.data)),
  );
  ws.send(Uint8Array.from([1, 2, 255]));
  assert.deepEqual([...new Uint8Array(await binary)], [1, 2, 255]);
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
  ws.close(1000, 'native-topology');
  const closeEvent = await closed;
  assert.equal(closeEvent.code, 1000);
}

test('Node native WebSocket works through a directly connected remote Host', async () => {
  const root = createHost({ hostId: 'native-direct-root' });
  const remote = createHost({ hostId: 'native-direct-remote' });
  await root.start();
  await remote.start();
  const rootUrl = `https://127.0.0.1:${root.address.port}`;
  const remoteUrl = `https://127.0.0.1:${remote.address.port}`;
  const broker = createBroker(rootUrl, 'native-direct-broker');
  const guest = createGuest(remoteUrl, 'native-direct-guest');
  try {
    guest.attachNativeWebSocket((_open, ws) => {
      ws.addEventListener('message', (event) => void ws.send(event.data));
      return { protocol: 'native.v1' };
    }, 'native-direct.test');
    await broker.connect();
    await remote.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    await guest.connect();
    await broker.waitForRoute('native-direct.test');
    await assertNativeRoundTrip(broker, 'native-direct-guest', 'native-direct.test');
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await remote.close('test-complete');
    await root.close('test-complete');
  }
});

test('Node native WebSocket works through a multi-hop federated Host route', async () => {
  const root = createHost({ hostId: 'native-multi-root' });
  const middle = createHost({ hostId: 'native-multi-middle' });
  const leaf = createHost({ hostId: 'native-multi-leaf' });
  await root.start();
  await middle.start();
  await leaf.start();
  const rootUrl = `https://127.0.0.1:${root.address.port}`;
  const middleUrl = `https://127.0.0.1:${middle.address.port}`;
  const leafUrl = `https://127.0.0.1:${leaf.address.port}`;
  const broker = createBroker(rootUrl, 'native-multi-broker');
  const guest = createGuest(leafUrl, 'native-multi-guest');
  try {
    guest.attachNativeWebSocket((_open, ws) => {
      ws.addEventListener('message', (event) => void ws.send(event.data));
      return { protocol: 'native.v1' };
    }, 'native-multi.test');
    await broker.connect();
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
    await guest.connect();
    await broker.waitForRoute('native-multi.test');
    await assertNativeRoundTrip(broker, 'native-multi-guest', 'native-multi.test');
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await leaf.close('test-complete');
    await middle.close('test-complete');
    await root.close('test-complete');
  }
});

// Deterministic VWS integration coverage; every test owns its transports.
const assert = require('node:assert/strict');
const test = require('./support/guarded-test.cjs');
const {
  createBroker,
  createGuest,
  createHost,
  observeTerminal,
  waitForEvent,
} = require('./support/websocket-fixtures.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

test(
  'Broker opens a WebSocket through an imported-only one-hop route',
  { memoryLeakBytes: 2 * 1024 * 1024 },
  async () => {
    const host = createHost({ port: 0, hostId: 'ws-federation-manager' });
    const remoteHost = createHost({ port: 0, hostId: 'ws-federation-remote' });
    await host.start();
    await remoteHost.start();
    const hostUrl = `https://127.0.0.1:${host.address.port}`;
    const remoteUrl = `https://127.0.0.1:${remoteHost.address.port}`;
    const broker = createBroker({ hostUrl, brokerId: 'ws-federation-broker' });
    const guest = createGuest({
      hostUrl: remoteUrl,
      guestId: 'ws-federated-target',
    });
    let link;
    try {
      guest.attachWebSocket((_open, ws) => {
        ws.on('message', (data, options) => void ws.send(data, options));
      }, 'ws-federated.local.test');
      await broker.connect();
      link = await remoteHost.connectUpstream({
        upstreamId: 'manager',
        url: hostUrl,
        tls: { ca: trusted.certificate },
      });
      await guest.connect();
      await broker.waitForRoute('ws-federated.local.test');
      const ws = await broker.webSocket({
        targetId: 'ws-federated-target',
        domain: 'ws-federated.local.test',
        protocol: 'vws.base64',
      });
      const message = waitForEvent(ws, 'message');
      await ws.send('through-one-hop', { type: 'text' });
      assert.equal((await message.promise)[0], 'through-one-hop');
      const terminal = observeTerminal(ws);
      ws.close();
      await terminal.promise;
      const second = await broker.webSocket({
        targetId: 'ws-federated-target',
        domain: 'ws-federated.local.test',
      });
      const secondTerminal = observeTerminal(second);
      second.close();
      await secondTerminal.promise;
    } finally {
      await broker.close('test-complete');
      await guest.close('test-complete');
      await link?.close('test-complete');
      await remoteHost.close('test-complete');
      await host.close('test-complete');
    }
  },
);

test('Broker opens a WebSocket through an imported-only multi-hop route', async () => {
  const host = createHost({ port: 0, hostId: 'ws-federation-root' });
  const middleHost = createHost({ port: 0, hostId: 'ws-federation-middle' });
  const remoteHost = createHost({ port: 0, hostId: 'ws-federation-leaf' });
  await host.start();
  await middleHost.start();
  await remoteHost.start();
  const rootUrl = `https://127.0.0.1:${host.address.port}`;
  const middleUrl = `https://127.0.0.1:${middleHost.address.port}`;
  const leafUrl = `https://127.0.0.1:${remoteHost.address.port}`;
  const broker = createBroker({ hostUrl: rootUrl, brokerId: 'ws-federation-multi-broker' });
  const guest = createGuest({ hostUrl: leafUrl, guestId: 'ws-federated-multi-target' });
  let rootLink;
  let middleLink;
  try {
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', (data, options) => void ws.send(data, options));
    }, 'ws-federated-multi.local.test');
    await broker.connect();
    rootLink = await middleHost.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    middleLink = await remoteHost.connectUpstream({
      upstreamId: 'middle',
      url: middleUrl,
      tls: { ca: trusted.certificate },
    });
    await guest.connect();
    await broker.waitForRoute('ws-federated-multi.local.test');
    const ws = await broker.webSocket({
      targetId: 'ws-federated-multi-target',
      domain: 'ws-federated-multi.local.test',
    });
    const message = waitForEvent(ws, 'message');
    await ws.send('through-two-hops', { type: 'text' });
    assert.equal((await message.promise)[0], 'through-two-hops');
    const terminal = observeTerminal(ws);
    ws.close();
    await terminal.promise;
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await middleLink?.close('test-complete');
    await rootLink?.close('test-complete');
    await remoteHost.close('test-complete');
    await middleHost.close('test-complete');
    await host.close('test-complete');
  }
});

test('Federated WebSocket opens both directions concurrently and can reopen', async () => {
  const root = createHost({ port: 0, hostId: 'ws-bidir-root' });
  const leaf = createHost({ port: 0, hostId: 'ws-bidir-leaf' });
  await root.start();
  await leaf.start();
  const rootUrl = `https://127.0.0.1:${root.address.port}`;
  const leafUrl = `https://127.0.0.1:${leaf.address.port}`;
  const rootBroker = createBroker({ hostUrl: rootUrl, brokerId: 'ws-bidir-root-broker' });
  const leafBroker = createBroker({ hostUrl: leafUrl, brokerId: 'ws-bidir-leaf-broker' });
  const rootGuest = createGuest({ hostUrl: rootUrl, guestId: 'ws-bidir-root-guest' });
  const leafGuest = createGuest({ hostUrl: leafUrl, guestId: 'ws-bidir-leaf-guest' });
  let link;

  const echo = (_open, ws) => {
    ws.on('message', (data, options) => void ws.send(data, options));
  };
  try {
    rootGuest.attachWebSocket(echo, 'ws-bidir-root.local.test');
    leafGuest.attachWebSocket(echo, 'ws-bidir-leaf.local.test');
    await rootBroker.connect();
    await leafBroker.connect();
    link = await leaf.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    await rootGuest.connect();
    await leafGuest.connect();
    await rootBroker.waitForRoute('ws-bidir-leaf.local.test');
    await leafBroker.waitForRoute('ws-bidir-root.local.test');

    const opens = await Promise.all([
      rootBroker.webSocket({
        targetId: 'ws-bidir-leaf-guest',
        domain: 'ws-bidir-leaf.local.test',
        protocol: 'vws.base64',
      }),
      leafBroker.webSocket({
        targetId: 'ws-bidir-root-guest',
        domain: 'ws-bidir-root.local.test',
        protocol: 'vws.base64',
      }),
    ]);
    assert.deepEqual(
      opens.map((ws) => ws.protocol),
      ['vws.base64', 'vws.base64'],
    );
    for (const [index, ws] of opens.entries()) {
      const text = waitForEvent(ws, 'message');
      await ws.send(`bidir-text-${index}`, { type: 'text' });
      assert.equal((await text.promise)[0], `bidir-text-${index}`);
      const binary = waitForEvent(ws, 'message');
      await ws.send(Buffer.from([0, 255, index]), { type: 'binary' });
      assert.deepEqual((await binary.promise)[0], Buffer.from([0, 255, index]));
      const terminal = observeTerminal(ws);
      ws.close(1000, 'bidir-done');
      await terminal.promise;
    }

    const reopened = await Promise.all([
      rootBroker.webSocket({
        targetId: 'ws-bidir-leaf-guest',
        domain: 'ws-bidir-leaf.local.test',
      }),
      leafBroker.webSocket({
        targetId: 'ws-bidir-root-guest',
        domain: 'ws-bidir-root.local.test',
      }),
    ]);
    await Promise.all(
      reopened.map(async (ws) => {
        const terminal = observeTerminal(ws);
        ws.close();
        await terminal.promise;
      }),
    );
  } finally {
    await rootBroker.close('test-complete');
    await leafBroker.close('test-complete');
    await rootGuest.close('test-complete');
    await leafGuest.close('test-complete');
    await link?.close('test-complete');
    await leaf.close('test-complete');
    await root.close('test-complete');
  }
});

test('Established federated WebSocket closes abnormally when the selected Host is lost', async () => {
  const host = createHost({ port: 0, hostId: 'ws-loss-root' });
  const remoteHost = createHost({ port: 0, hostId: 'ws-loss-leaf' });
  await host.start();
  await remoteHost.start();
  const rootUrl = `https://127.0.0.1:${host.address.port}`;
  const leafUrl = `https://127.0.0.1:${remoteHost.address.port}`;
  const broker = createBroker({ hostUrl: rootUrl, brokerId: 'ws-loss-broker' });
  const guest = createGuest({ hostUrl: leafUrl, guestId: 'ws-loss-target' });
  let link;
  try {
    guest.attachWebSocket(() => {}, 'ws-loss.local.test');
    await broker.connect();
    link = await remoteHost.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    await guest.connect();
    await broker.waitForRoute('ws-loss.local.test');
    const ws = await broker.webSocket({ targetId: 'ws-loss-target', domain: 'ws-loss.local.test' });
    const closed = observeTerminal(ws);
    await remoteHost.close('selected-host-loss');
    assert.equal((await closed.promise).code, 1006);
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await link?.close('test-complete');
    await host.close('test-complete');
  }
});

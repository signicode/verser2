// Deterministic VWS integration coverage; every test owns its transports.
const assert = require('node:assert/strict');
const test = require('./support/guarded-test.cjs');
const {
  createBroker,
  createDeferred,
  createGuest,
  createHost,
  observeTerminal,
  waitForEvent,
} = require('./support/websocket-fixtures.cjs');

test('Broker webSocket rejects when Guest closes stream before handshake', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-closeguard' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-closeguard' });
  let release;

  try {
    // Guest handler that never sends accept/reject — the ws lease stream
    // will close when the Guest closes, which triggers the Host's
    // wsStream close handler and rejects the Broker's webSocket.
    const entered = createDeferred('closeguard handler entry');
    const gate = createDeferred('closeguard handler release');
    release = gate.resolve;
    guest.attachWebSocket(() => {
      entered.resolve();
      return gate.promise;
    }, 'ws-closeguard.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-closeguard.local.test');

    // Initiate a webSocket open — the Host sends 'open' frame, Guest
    // handler never responds. Close the Guest to trigger rejection.
    const wsPromise = broker.webSocket({
      targetId: 'ws-guest-closeguard',
      domain: 'ws-closeguard.local.test',
    });

    // Attach a no-op catch to prevent unhandled rejection if the
    // promise settles before assert.rejects attaches its handler.
    wsPromise.catch(() => {});

    // Close the Guest connection — this destroys the ws lease stream,
    // causing the Host handshake to fail.
    await entered.promise;
    await guest.close('test-close');

    // The Broker webSocket should reject (any error is acceptable;
    // the key behavior is it does NOT hang).
    await assert.rejects(wsPromise, /error|protocol|missing|closed|handshake/i);
  } finally {
    release?.();
    await broker.close('test-complete');
    // guest already closed above
    await host.close('test-complete');
  }
});

test('Broker webSocket rejects when Broker closes before Guest accepts', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-close-self' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-close-self' });
  let release;

  try {
    // Guest handler that never sends accept/reject — hangs the handshake
    const entered = createDeferred('close-self handler entry');
    const gate = createDeferred('close-self handler release');
    release = gate.resolve;
    guest.attachWebSocket(() => {
      entered.resolve();
      return gate.promise;
    }, 'ws-close-self.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-close-self.local.test');

    // Initiate a webSocket open while Guest handler hangs
    const wsPromise = broker.webSocket({
      targetId: 'ws-guest-close-self',
      domain: 'ws-close-self.local.test',
    });

    // Attach a no-op catch to prevent unhandled rejection
    wsPromise.catch(() => {});

    // Close the Broker — this destroys the broker's session, which
    // closes the broker request stream. The Host detects this via
    // the brokerStream 'close' listener in raceVwsAccept and rejects.
    await entered.promise;
    await broker.close('test-close');

    // The Broker webSocket should reject (any error is acceptable;
    // the key behavior is it does NOT hang).
    await assert.rejects(wsPromise, /error|protocol|missing|closed|handshake/i);
  } finally {
    release?.();
    // broker already closed above
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});
test('Established Broker termination gives Guest local close 1006', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-abort' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-abort' });
  try {
    let closed;
    guest.attachWebSocket((_open, ws) => {
      closed = observeTerminal(ws);
    }, 'ws-abort.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-abort.local.test');
    await broker.webSocket({ targetId: 'ws-guest-abort', domain: 'ws-abort.local.test' });
    await broker.close('abort-established');
    assert.equal((await closed.promise).code, 1006);
  } finally {
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Established Guest disconnect gives Broker abnormal close or structured failure', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-guest-drop' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-drop' });
  try {
    guest.attachWebSocket(() => {}, 'ws-guest-drop.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-guest-drop.local.test');
    const ws = await broker.webSocket({
      targetId: 'ws-guest-drop',
      domain: 'ws-guest-drop.local.test',
    });
    const outcome = observeTerminal(ws);
    await guest.close('guest-disconnect');
    assert.equal((await outcome.promise).code, 1006);
  } finally {
    await broker.close('test-complete');
    await host.close('test-complete');
  }
});

test('Host close cleans active VWS peers deterministically', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-host-drop' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-host-drop' });
  try {
    let guestClosed;
    guest.attachWebSocket((_open, ws) => {
      guestClosed = observeTerminal(ws);
    }, 'ws-host-drop.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-host-drop.local.test');
    const ws = await broker.webSocket({
      targetId: 'ws-guest-host-drop',
      domain: 'ws-host-drop.local.test',
    });
    const brokerClosed = observeTerminal(ws);
    await host.close('host-shutdown');
    await brokerClosed.promise;
    await guestClosed.promise;
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
  }
});

test('Route revocation blocks new opens but preserves an active WebSocket', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-revoke' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-revoke' });

  let unsubscribeRoute;
  try {
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', (data, options) => {
        void ws.send(data, options);
      });
    }, 'ws-revoke.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-revoke.local.test');

    // First open should succeed
    const ws1 = await broker.webSocket({
      targetId: 'ws-guest-revoke',
      domain: 'ws-revoke.local.test',
    });
    const routeRemoved = createDeferred('route removal');
    unsubscribeRoute = broker.onRouteChange((event) => {
      if (event.type === 'removed' && event.domain === 'ws-revoke.local.test') {
        routeRemoved.resolve();
      }
    });
    // Revoke the route
    const revokeResult = await guest.revokeRoutes(['ws-revoke.local.test']);
    assert.equal(revokeResult.status, 'ack');
    await routeRemoved.promise;

    const activeEcho = waitForEvent(ws1, 'message');
    await ws1.send('active-after-revoke', { type: 'text' });
    assert.equal((await activeEcho.promise)[0], 'active-after-revoke');

    // Second open should fail
    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'ws-guest-revoke',
          domain: 'ws-revoke.local.test',
        }),
      /not available|revoked|missing/i,
    );
    const terminal = observeTerminal(ws1);
    ws1.close();
    await terminal.promise;
  } finally {
    unsubscribeRoute?.();
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

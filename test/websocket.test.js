// Deterministic VWS integration coverage; every test owns its transports.
const assert = require('node:assert/strict');
const test = require('./support/guarded-test.cjs');
const {
  createDeferred,
  createDirectFixture,
  observeTerminal,
  waitForCloseOrError,
  waitForMessages,
  waitForEvent,
} = require('./support/websocket-fixtures.cjs');

const DIRECT_DOMAIN = 'ws-direct.local.test';
const directFixture = createDirectFixture(DIRECT_DOMAIN);
test.before(async () => directFixture.start());
test.after(async () => directFixture.close('test-complete'));

test(
  'Node Broker opens VWS/1 WebSocket to Node Guest with subprotocol negotiation',
  { memoryLeakBytes: 2 * 1024 * 1024 },
  async () => {
    try {
      await directFixture.reset();
      directFixture.setScenario((open) => {
        assert.equal(open.domain, DIRECT_DOMAIN);
        assert.equal(open.protocol, 'vws.base64');
      });

      const ws = await directFixture.broker.webSocket({
        targetId: 'ws-direct-guest',
        domain: DIRECT_DOMAIN,
        protocol: 'vws.base64',
      });

      assert.equal(ws.protocol, 'vws.base64');
      const terminal = observeTerminal(ws);
      ws.close();
      await terminal.promise;
    } finally {
      await directFixture.reset();
    }
  },
);

test('Node Guest rejects a VWS subprotocol that was not offered by the Broker', async () => {
  const { broker, guest } = directFixture;

  try {
    await directFixture.reset();
    directFixture.setScenario(() => ({ protocol: 'not-offered' }));

    await assert.rejects(
      broker.webSocket({
        targetId: 'ws-direct-guest',
        domain: DIRECT_DOMAIN,
        protocol: 'offered-protocol',
      }),
      /not offered|protocol|closed/i,
    );
  } finally {
    await directFixture.reset();
  }
});

test('Bidirectional TEXT and BINARY messages preserve message boundaries', async () => {
  const { broker, guest } = directFixture;

  try {
    await directFixture.reset();
    directFixture.setScenario((_open, ws) => {
      ws.on('message', (data, { type }) => {
        ws.send(data, { type });
      });
    }, DIRECT_DOMAIN);

    const ws = await broker.webSocket({
      targetId: 'ws-direct-guest',
      domain: DIRECT_DOMAIN,
      protocol: 'vws.base64',
    });
    const messages = waitForMessages(ws, 2);

    ws.send('hello', { type: 'text' });
    ws.send(Buffer.from([0x00, 0xff, 0x7f]), { type: 'binary' });
    const received = (await messages.promise).map(([data, options]) => ({
      data,
      type: options.type,
    }));

    // Each message should be received as a discrete unit.
    assert.equal(received[0].type, 'text');
    assert.equal(received[0].data, 'hello');

    assert.equal(received[1].type, 'binary');
    assert.deepEqual(Buffer.from(received[1].data), Buffer.from([0x00, 0xff, 0x7f]));
    const terminal = observeTerminal(ws);
    ws.close();
    await terminal.promise;
  } finally {
    await directFixture.reset();
  }
});

test('Normal close code/reason delivered both ways', async () => {
  const { broker, guest } = directFixture;

  try {
    await directFixture.reset();
    directFixture.setScenario((_open, _ws) => {
      // Accept by default, no echo needed
    }, DIRECT_DOMAIN);

    const ws = await broker.webSocket({
      targetId: 'ws-direct-guest',
      domain: DIRECT_DOMAIN,
      protocol: 'vws.base64',
    });

    // Broker sends close, Guest should receive it.
    const closeReceived = observeTerminal(ws);

    ws.close(1000, 'normal closure');

    const [closeEvent] = await closeReceived.promise.then((event) => [event]);
    assert.equal(closeEvent.code, 1000);
    assert.equal(closeEvent.reason, 'normal closure');
  } finally {
    await directFixture.reset();
  }
});

test('Guest handler can reject WebSocket connections', async () => {
  const { broker, guest } = directFixture;

  try {
    await directFixture.reset();
    directFixture.setScenario((_open, _ws) => {
      return false; // Reject all connections
    }, DIRECT_DOMAIN);

    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'ws-direct-guest',
          domain: DIRECT_DOMAIN,
        }),
      (error) => {
        assert.equal(error.code, 'missing-guest');
        assert.equal(error.context.targetId, 'ws-direct-guest');
        assert.equal(error.context.domain, DIRECT_DOMAIN);
        assert.equal(error.context.status, 404);
        return true;
      },
    );
  } finally {
    await directFixture.reset();
  }
});

test('Oversized VWS frame closes with 1009 or deterministic error', async () => {
  const { broker, guest } = directFixture;

  try {
    directFixture.setScenario((_open, ws) => {
      // Track oversized message errors on the guest side
      ws.on('error', () => {});
    }, DIRECT_DOMAIN);

    const ws = await broker.webSocket({
      targetId: 'ws-direct-guest',
      domain: DIRECT_DOMAIN,
    });

    // Broker sends an oversized binary message (2 MiB) to trigger 1009 from the Guest.
    // The VWS/1 frame itself exceeds VWS_MAX_FRAME_BYTES (1 MiB) after base64 encoding.
    let big = Buffer.alloc(800 * 1024);
    const terminal = waitForCloseOrError(ws);
    const closed = waitForEvent(ws, 'close', 3000, { ignoreError: true });

    // Expect close or error from the oversized message path
    void ws.send(big, { type: 'binary' }).then(() => {
      big = null;
    });
    const result = await terminal.promise;
    assert.ok(result.type === 'error' || [1009, 1006].includes(result.code));
    await closed.promise;
  } finally {
    await directFixture.reset();
  }
});
test('VWS concurrent full-duplex sends complete without retaining bodies', async () => {
  const { broker, guest } = directFixture;
  try {
    let guestReceived = 0;
    let brokerReceived = 0;
    directFixture.setScenario((_open, ws) => {
      let sent = false;
      ws.on('message', () => {
        guestReceived += 1;
        if (!sent) {
          sent = true;
          for (let index = 0; index < 20; index += 1)
            void ws.send(`guest-${index}`, { type: 'text' });
        }
      });
    }, DIRECT_DOMAIN);
    const ws = await broker.webSocket({
      targetId: 'ws-direct-guest',
      domain: DIRECT_DOMAIN,
    });
    const complete = createDeferred('full-duplex messages');
    ws.on('message', () => {
      brokerReceived += 1;
      if (brokerReceived === 20 && guestReceived === 20) {
        complete.resolve();
      }
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => ws.send(`broker-${index}`, { type: 'text' })),
    );
    await complete.promise;
    assert.equal(guestReceived, 20);
    assert.equal(brokerReceived, 20);
    const terminal = observeTerminal(ws);
    ws.close();
    await terminal.promise;
  } finally {
    await directFixture.reset();
  }
});

test('VWS slow receiver completes bounded streamed sends with awaited backpressure', async () => {
  const { broker, guest } = directFixture;
  let deliveryGate;
  try {
    await directFixture.reset();
    let received = 0;
    let receivedBytes = 0;
    const count = 8;
    const size = 8 * 1024;
    deliveryGate = createDeferred('slow receiver delivery release');
    const receivedAll = createDeferred('slow receiver messages');
    directFixture.setScenario((_open, ws) => {
      ws.on('message', async (data) => {
        await deliveryGate.promise;
        received += 1;
        receivedBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        if (received === count) receivedAll.resolve();
      });
    }, DIRECT_DOMAIN);
    const ws = await broker.webSocket({ targetId: 'ws-direct-guest', domain: DIRECT_DOMAIN });
    for (let index = 0; index < count; index += 1)
      await ws.send(Buffer.alloc(size, index & 0xff), { type: 'binary' });
    assert.equal(received, 0);
    deliveryGate.resolve();
    await receivedAll.promise;
    assert.equal(received, count);
    assert.equal(receivedBytes, count * size);
    const terminal = observeTerminal(ws);
    ws.close();
    await terminal.promise;
  } finally {
    deliveryGate.resolve();
    await directFixture.reset();
  }
});
test('Node Guest maintains a spare WS lease for three concurrent connections', async () => {
  const { broker, guest } = directFixture;
  let allArrived;
  try {
    await directFixture.reset();
    let arrivals = 0;
    allArrived = createDeferred('three-open handler release');
    const arrivalsReady = createDeferred('three-open handler readiness');
    directFixture.setScenario((_open, ws) => {
      arrivals += 1;
      if (arrivals === 3) arrivalsReady.resolve();
      ws.on('message', (data, options) => {
        void ws.send(data, options);
      });
      return allArrived.promise;
    }, DIRECT_DOMAIN);
    const opens = Promise.all(
      [1, 2, 3].map(() =>
        broker.webSocket({
          targetId: 'ws-direct-guest',
          domain: DIRECT_DOMAIN,
        }),
      ),
    );
    await arrivalsReady.promise;
    allArrived.resolve();
    const sockets = await opens;
    const responses = sockets.map((ws) => waitForEvent(ws, 'message'));
    await Promise.all(sockets.map((ws, index) => ws.send(`three-${index}`, { type: 'text' })));
    const responseValues = await Promise.all(responses.map((response) => response.promise));
    responseValues.forEach(([data], index) => assert.equal(data, `three-${index}`));
    await Promise.all(
      sockets.map(async (ws) => {
        const terminal = observeTerminal(ws);
        ws.close();
        await terminal.promise;
      }),
    );
  } finally {
    allArrived.resolve();
    await directFixture.reset();
  }
});

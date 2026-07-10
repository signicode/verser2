// Acceptance tests for VWS/1 WebSocket support.
//
// These tests describe the expected API shape (guest.attachWebSocket,
// broker.webSocket) and currently fail because the implementation does
// not exist yet. They will pass once Phase 4 WebSocket support is
// implemented.
//
// Out of scope in this test file:
//   - Agent / Dispatcher generic upgrade handling
//   - CONNECT / RFC 8441 tunneling
//   - Bun server.upgrade()
//   - L4 forwarding

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker, createVerserNodeGuest } = loadVerserGuestNode();

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

test('Node Broker opens VWS/1 WebSocket to Node Guest with subprotocol negotiation', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-subproto' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-subproto' });

  try {
    // Expected API shape — guest.attachWebSocket does not exist yet.
    // Will register a WebSocket handler for the given domain.
    guest.attachWebSocket((_ws) => {}, 'ws-subproto.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-subproto.local.test');

    // Expected API shape — broker.webSocket does not exist yet.
    // Returns a WebSocket-like object after the VWS/1 handshake.
    const ws = await broker.webSocket({
      targetId: 'ws-guest-subproto',
      domain: 'ws-subproto.local.test',
      protocol: 'vws.base64',
    });

    // After implementation: negotiate VWS/1 subprotocol
    assert.equal(ws.protocol, 'vws.base64');
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Bidirectional TEXT and BINARY messages preserve message boundaries', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-msgbound' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-msgbound' });

  try {
    guest.attachWebSocket((ws) => {
      ws.on('message', (data, { type }) => {
        ws.send(data, { type });
      });
    }, 'ws-msgbound.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-msgbound.local.test');

    const ws = await broker.webSocket({
      targetId: 'ws-guest-msgbound',
      domain: 'ws-msgbound.local.test',
      protocol: 'vws.base64',
    });

    // Send a TEXT message from the Broker side.
    // The Guest handler echoes messages back.
    ws.send('hello', { type: 'text' });

    // Send a BINARY message after the text.
    ws.send(Buffer.from([0x00, 0xff, 0x7f]), { type: 'binary' });

    // Collect received messages on the Broker side.
    const received = [];
    ws.on('message', (data, { type }) => {
      received.push({ type, data });
    });

    // Wait for both echoes.
    await new Promise((resolve, reject) => {
      const check = () => {
        if (received.length >= 2) resolve();
      };
      ws.on('message', check);
      setTimeout(() => reject(new Error('Timed out waiting for echo messages')), 2000);
    });

    // Each message should be received as a discrete unit.
    assert.equal(received[0].type, 'text');
    assert.equal(received[0].data, 'hello');

    assert.equal(received[1].type, 'binary');
    assert.deepEqual(Buffer.from(received[1].data), Buffer.from([0x00, 0xff, 0x7f]));
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Normal close code/reason delivered both ways', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-close' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-close' });

  try {
    guest.attachWebSocket((_ws) => {}, 'ws-close.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-close.local.test');

    const ws = await broker.webSocket({
      targetId: 'ws-guest-close',
      domain: 'ws-close.local.test',
      protocol: 'vws.base64',
    });

    // Broker sends close, Guest should receive it.
    const closeReceived = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason }));
    });

    ws.close(1000, 'normal closure');

    const closeEvent = await closeReceived;
    assert.equal(closeEvent.code, 1000);
    assert.equal(closeEvent.reason, 'normal closure');
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

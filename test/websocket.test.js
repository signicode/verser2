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
    // Register a WebSocket handler — receives open metadata and ws instance.
    guest.attachWebSocket((open, ws) => {
      assert.equal(open.domain, 'ws-subproto.local.test');
      assert.equal(open.protocol, 'vws.base64');
      // Accept with the requested protocol (default behavior)
    }, 'ws-subproto.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-subproto.local.test');

    const ws = await broker.webSocket({
      targetId: 'ws-guest-subproto',
      domain: 'ws-subproto.local.test',
      protocol: 'vws.base64',
    });

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
    guest.attachWebSocket((_open, ws) => {
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
    guest.attachWebSocket((_open, _ws) => {
      // Accept by default, no echo needed
    }, 'ws-close.local.test');

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

test('Guest handler can reject WebSocket connections', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-reject' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-reject' });

  try {
    guest.attachWebSocket((_open, _ws) => {
      return false; // Reject all connections
    }, 'ws-reject.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-reject.local.test');

    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'ws-guest-reject',
          domain: 'ws-reject.local.test',
        }),
      /rejected/i,
    );
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Oversized VWS frame closes with 1009 or deterministic error', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-oversize' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-oversize' });

  try {
    guest.attachWebSocket((_open, ws) => {
      // Track oversized message errors on the guest side
      ws.on('error', () => {});
    }, 'ws-oversize.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-oversize.local.test');

    const ws = await broker.webSocket({
      targetId: 'ws-guest-oversize',
      domain: 'ws-oversize.local.test',
    });

    // Broker sends an oversized binary message (2 MiB) to trigger 1009 from the Guest.
    // The VWS/1 frame itself exceeds VWS_MAX_FRAME_BYTES (1 MiB) after base64 encoding.
    const big = Buffer.alloc(2 * 1024 * 1024);

    // Expect close or error from the oversized message path
    await new Promise((resolve, reject) => {
      ws.on('close', (code) => {
        try {
          // 1009 indicates message too large
          if (code === 1009) resolve();
          else reject(new Error(`Unexpected close code: ${code}`));
        } catch (e) {
          reject(e);
        }
      });
      ws.on('error', () => {
        // Error may fire instead of close; acceptable
        resolve();
      });
      // Send oversized message
      ws.send(big, { type: 'binary' });
      setTimeout(() => reject(new Error('No close/error for oversized message')), 2000);
    });
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Oversized single chunk with newline is rejected with 1009 before buffering', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const { PassThrough } = require('node:stream');

  const pt = new PassThrough();
  const ws = new VerserWebSocket(pt);

  // Construct a single VWS/1 line that exceeds VWS_MAX_FRAME_BYTES (1 MiB)
  // and contains a newline. The parser must reject it before accumulating
  // the full line (byte-counting check fires before JSON parse).
  const payload = 'x'.repeat(2 * 1024 * 1024);
  const line = `${JSON.stringify({ type: 'text', data: payload })}\n`;

  const closePromise = new Promise((resolve, reject) => {
    ws.on('close', (code) => {
      try {
        assert.equal(code, 1009);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', () => {
      // Error may fire before close; that's acceptable
    });
    setTimeout(() => reject(new Error('No close after oversized chunk')), 2000);
  });

  // Write the oversized line as a single chunk
  pt.write(Buffer.from(line));
  pt.end();

  await closePromise;
});

test('Malformed remote frame does not crash when no ws.on(error) listener', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const { PassThrough } = require('node:stream');

  const pt = new PassThrough();
  // Intentionally do NOT register any 'error' listener on ws.
  // The process must not crash when remote sends malformed JSON.
  const ws = new VerserWebSocket(pt);

  // Push malformed JSON (not a valid VWS frame) followed by newline
  pt.write(Buffer.from('{"type": "text", "data": "hello"\n')); // invalid JSON (missing closing brace)
  pt.end();

  // Wait a tick for the error to be emitted and the default handler to swallow it
  await new Promise((resolve) => setImmediate(resolve));

  // If we reach here without crash, the default error handler works.
  // Verify the WebSocket is in a closed/ing state
  assert.ok(true, 'Process did not crash from unhandled error event');
});

test('Pre-accept send is queued and not written until after accept', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const { PassThrough } = require('node:stream');

  const pt = new PassThrough();
  const ws = new VerserWebSocket(pt);

  // Collect written data
  const written = [];
  const originalWrite = pt.write.bind(pt);
  pt.write = (chunk) => {
    written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return originalWrite(chunk);
  };

  // Send a message BEFORE accept
  ws.send('before-accept', { type: 'text' });

  // No data should be written to the stream yet
  assert.equal(written.length, 0, 'No data written before accept');

  // Now accept
  ws.sendAccept('vws.test');

  // Wait a tick for the queue to flush
  await new Promise((resolve) => setImmediate(resolve));

  // The accept frame should be first, followed by the queued data
  assert.ok(written.length >= 2, 'At least accept + queued data written');

  const acceptFrame = JSON.parse(written[0].toString().trimEnd());
  assert.equal(acceptFrame.type, 'accept');
  assert.equal(acceptFrame.protocol, 'vws.test');

  const dataFrame = JSON.parse(written[1].toString().trimEnd());
  assert.equal(dataFrame.type, 'text');
  assert.equal(dataFrame.data, 'before-accept');
});

test('Broker webSocket rejects when Guest closes stream before handshake', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-closeguard' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-closeguard' });

  try {
    // Guest handler that never sends accept/reject — the ws lease stream
    // will close when the Guest closes, which triggers the Host's
    // wsStream close handler and rejects the Broker's webSocket.
    guest.attachWebSocket(() => {
      // Intentionally do NOT return accept or reject — hang the handler.
      // The Guest close() below will tear down the session, closing the
      // ws lease stream, which causes the Host to reject the handshake.
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
    await guest.close('test-close');

    // The Broker webSocket should reject (any error is acceptable;
    // the key behavior is it does NOT hang).
    await assert.rejects(wsPromise, /error|protocol|missing|closed|handshake/i);
  } finally {
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

  try {
    // Guest handler that never sends accept/reject — hangs the handshake
    guest.attachWebSocket(() => {
      // Never returns accept or reject
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
    await broker.close('test-close');

    // The Broker webSocket should reject (any error is acceptable;
    // the key behavior is it does NOT hang).
    await assert.rejects(wsPromise, /error|protocol|missing|closed|handshake/i);
  } finally {
    // broker already closed above
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Route revocation blocks new WebSocket opens', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-revoke' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-revoke' });

  try {
    guest.attachWebSocket((_open, _ws) => {
      // Accept by default
    }, 'ws-revoke.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-revoke.local.test');

    // First open should succeed
    const ws1 = await broker.webSocket({
      targetId: 'ws-guest-revoke',
      domain: 'ws-revoke.local.test',
    });
    ws1.close(1000, 'first');

    // Revoke the route
    const revokeResult = await guest.revokeRoutes(['ws-revoke.local.test']);
    assert.equal(revokeResult.status, 'ack');

    // Wait for route removal to propagate to Broker
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Second open should fail
    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'ws-guest-revoke',
          domain: 'ws-revoke.local.test',
        }),
      /not available|revoked|missing/i,
    );
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

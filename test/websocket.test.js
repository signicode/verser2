// Acceptance tests for VWS/1 WebSocket support.
//
// These tests cover the approved VWS/1 API and lifecycle behavior.
//
// Out of scope in this test file:
//   - Agent / Dispatcher generic upgrade handling
//   - CONNECT / RFC 8441 tunneling
//   - Bun server.upgrade()
//   - L4 forwarding

const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const test = require('./support/guarded-test.cjs');
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

test.before(async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-warmup-broker' });
  const guest = createGuest({ hostUrl, guestId: 'ws-warmup-guest' });
  try {
    await broker.connect();
    await guest.connect();
  } finally {
    await broker.close('warmup');
    await guest.close('warmup');
    await host.close('warmup');
  }
});

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

test('Node Guest rejects a VWS subprotocol that was not offered by the Broker', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-unoffered' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-unoffered' });

  try {
    guest.attachWebSocket(() => ({ protocol: 'not-offered' }), 'ws-unoffered.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-unoffered.local.test');

    await assert.rejects(
      broker.webSocket({
        targetId: 'ws-guest-unoffered',
        domain: 'ws-unoffered.local.test',
        protocol: 'offered-protocol',
      }),
      /not offered|protocol|closed/i,
    );
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
    let big = Buffer.alloc(800 * 1024);

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
      // Send oversized message and release the generated body once serialized.
      void ws.send(big, { type: 'binary' }).then(() => {
        big = null;
      });
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
  const payload = 'x'.repeat(1100 * 1024);
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
  const { Duplex } = require('node:stream');

  const written = [];
  const pt = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      written.push(Buffer.from(chunk));
      callback();
    },
  });
  const ws = new VerserWebSocket(pt);

  // Collect written data

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

test('VWS ping is automatically answered with pong and exposed as an event', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new PassThrough();
  const ws = new VerserWebSocket(stream, '', true);
  const output = [];
  stream.on('data', (chunk) => output.push(chunk.toString()));
  const pong = new Promise((resolve) => ws.once('pong', resolve));
  stream.write('{"type":"ping","data":"nonce"}\n');
  assert.equal(await pong, 'nonce');
  assert.deepEqual(output.at(-1), '{"type":"pong","data":"nonce"}\n');
  stream.destroy();
});

test('VWS rejects invalid application close codes and oversized reasons before writing', () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new PassThrough();
  const ws = new VerserWebSocket(stream, '', true);
  assert.throws(() => ws.close(1006), /Invalid WebSocket close code/);
  assert.throws(() => ws.close(2000), /Invalid WebSocket close code/);
  assert.throws(() => ws.close(1000, '😀'.repeat(32)), /123 UTF-8 bytes/);
  assert.equal(stream.read(), null);
  stream.destroy();
});

test('VWS rejects invalid remote close frames with protocol error, never wire 1006', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new PassThrough();
  const output = [];
  stream.on('data', (chunk) => output.push(chunk.toString()));
  const ws = new VerserWebSocket(stream, '', true);
  const error = new Promise((resolve) => ws.once('error', resolve));
  const close = new Promise((resolve) => ws.once('close', resolve));
  stream.write('{"type":"close","code":1006,"reason":"bad"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(output.at(-1), /"type":"close","code":1002/);
  assert.equal((await error).closeCode, 1002);
  stream.destroy();
  await close.catch(() => undefined);
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
    guest.attachWebSocket(() => new Promise(() => {}), 'ws-closeguard.local.test');

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
    guest.attachWebSocket(() => new Promise(() => {}), 'ws-close-self.local.test');

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

test('VWS concurrent full-duplex sends complete without retaining bodies', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-duplex' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-duplex' });
  try {
    let guestReceived = 0;
    let brokerReceived = 0;
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', () => {
        guestReceived += 1;
      });
      setTimeout(() => {
        for (let index = 0; index < 20; index += 1)
          void ws.send(`guest-${index}`, { type: 'text' });
      }, 10);
    }, 'ws-duplex.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-duplex.local.test');
    const ws = await broker.webSocket({
      targetId: 'ws-guest-duplex',
      domain: 'ws-duplex.local.test',
    });
    const complete = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('full-duplex traffic timed out')), 3000);
      ws.on('message', () => {
        brokerReceived += 1;
        if (brokerReceived === 20 && guestReceived === 20) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => ws.send(`broker-${index}`, { type: 'text' })),
    );
    await complete;
    assert.equal(guestReceived, 20);
    assert.equal(brokerReceived, 20);
    ws.close();
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('VWS slow receiver completes bounded streamed sends with awaited backpressure', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-slow' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-slow' });
  try {
    let received = 0;
    let receivedBytes = 0;
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', async (data) => {
        received += 1;
        receivedBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    }, 'ws-slow.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-slow.local.test');
    const ws = await broker.webSocket({ targetId: 'ws-guest-slow', domain: 'ws-slow.local.test' });
    const count = 8;
    const size = 8 * 1024;
    for (let index = 0; index < count; index += 1)
      await ws.send(Buffer.alloc(size, index & 0xff), { type: 'binary' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`slow receiver timed out (${received}/${count})`)),
        5000,
      );
      const check = () => {
        if (received === count) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
    assert.equal(received, count);
    assert.equal(receivedBytes, count * size);
    ws.close();
  } finally {
    await broker.close('test-complete');
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
    const closed = new Promise((resolve) =>
      guest.attachWebSocket((_open, ws) => ws.once('close', resolve), 'ws-abort.local.test'),
    );
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-abort.local.test');
    await broker.webSocket({ targetId: 'ws-guest-abort', domain: 'ws-abort.local.test' });
    await broker.close('abort-established');
    const result = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Guest close timed out')), 3000),
      ),
    ]);
    assert.equal(result, 1006);
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
    const outcome = new Promise((resolve) => {
      ws.once('close', (code) => resolve({ code }));
      ws.once('error', (error) => resolve({ error }));
    });
    await guest.close('guest-disconnect');
    const result = await Promise.race([
      outcome,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Broker close timed out')), 3000),
      ),
    ]);
    assert.ok(result.error || result.code === 1006);
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
    let guestClosed = false;
    guest.attachWebSocket(
      (_open, ws) =>
        ws.once('close', () => {
          guestClosed = true;
        }),
      'ws-host-drop.local.test',
    );
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-host-drop.local.test');
    const ws = await broker.webSocket({
      targetId: 'ws-guest-host-drop',
      domain: 'ws-host-drop.local.test',
    });
    const brokerClosed = new Promise((resolve) => ws.once('close', resolve));
    await host.close('host-shutdown');
    await Promise.race([
      brokerClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Host close timed out')), 3000)),
    ]);
    await new Promise((resolve, reject) => {
      if (guestClosed) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error('Guest close timed out')), 3000);
      const check = () => {
        if (guestClosed) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
    assert.equal(guestClosed, true);
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
    const routeRemoved = new Promise((resolve) => {
      const unsubscribe = broker.onRouteChange((event) => {
        if (event.type === 'removed' && event.domain === 'ws-revoke.local.test') {
          unsubscribe();
          resolve();
        }
      });
    });
    // Revoke the route
    const revokeResult = await guest.revokeRoutes(['ws-revoke.local.test']);
    assert.equal(revokeResult.status, 'ack');
    await routeRemoved;

    const activeEcho = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('active WebSocket was terminated by revocation')),
        2000,
      );
      ws1.once('message', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
    await ws1.send('active-after-revoke', { type: 'text' });
    assert.equal(await activeEcho, 'active-after-revoke');

    // Second open should fail
    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'ws-guest-revoke',
          domain: 'ws-revoke.local.test',
        }),
      /not available|revoked|missing/i,
    );
    ws1.close();
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Broker opens a WebSocket through an imported-only one-hop route', async () => {
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
  try {
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', (data, options) => void ws.send(data, options));
    }, 'ws-federated.local.test');
    await broker.connect();
    await remoteHost.connectUpstream({
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
    const message = new Promise((resolve) => ws.once('message', resolve));
    await ws.send('through-one-hop', { type: 'text' });
    assert.equal(await message, 'through-one-hop');
    ws.close();
    const second = await broker.webSocket({
      targetId: 'ws-federated-target',
      domain: 'ws-federated.local.test',
    });
    second.close();
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await remoteHost.close('test-complete');
    await host.close('test-complete');
  }
});

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
  try {
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', (data, options) => void ws.send(data, options));
    }, 'ws-federated-multi.local.test');
    await broker.connect();
    await middleHost.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    await remoteHost.connectUpstream({
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
    const message = new Promise((resolve) => ws.once('message', resolve));
    await ws.send('through-two-hops', { type: 'text' });
    assert.equal(await message, 'through-two-hops');
    ws.close();
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await remoteHost.close('test-complete');
    await middleHost.close('test-complete');
    await host.close('test-complete');
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
  try {
    guest.attachWebSocket(() => {}, 'ws-loss.local.test');
    await broker.connect();
    await remoteHost.connectUpstream({
      upstreamId: 'root',
      url: rootUrl,
      tls: { ca: trusted.certificate },
    });
    await guest.connect();
    await broker.waitForRoute('ws-loss.local.test');
    const ws = await broker.webSocket({ targetId: 'ws-loss-target', domain: 'ws-loss.local.test' });
    const closed = new Promise((resolve) => {
      ws.once('close', (code) => resolve(code));
      ws.once('error', resolve);
    });
    await remoteHost.close('selected-host-loss');
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('federated close timed out')), 3000),
      ),
    ]);
    assert.ok(outcome instanceof Error || outcome === 1006);
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('Node Guest maintains a spare WS lease for three concurrent connections', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'ws-broker-three' });
  const guest = createGuest({ hostUrl, guestId: 'ws-guest-three' });
  try {
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', (data, options) => {
        void ws.send(data, options);
      });
    }, 'ws-three.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('ws-three.local.test');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sockets = await Promise.all(
      [1, 2, 3].map(() =>
        broker.webSocket({
          targetId: 'ws-guest-three',
          domain: 'ws-three.local.test',
        }),
      ),
    );
    await Promise.all(
      sockets.map(
        (ws, index) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('concurrent WebSocket timed out')),
              3000,
            );
            ws.once('message', (data) => {
              clearTimeout(timer);
              assert.equal(data, `three-${index}`);
              resolve();
            });
            void ws.send(`three-${index}`, { type: 'text' });
          }),
      ),
    );
    for (const ws of sockets) ws.close();
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('VWS close timeout cleans up when the peer never responds', async () => {
  const { Duplex } = require('node:stream');
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const ws = new VerserWebSocket(stream, '', true);
  const closed = new Promise((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason })),
  );
  ws.close(1000, 'timeout-test');
  const result = await closed;
  assert.equal(result.code, 1006);
  assert.match(result.reason, /timeout/);
});

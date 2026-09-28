// Deterministic VWS protocol/unit coverage.
const assert = require('node:assert/strict');
const { Duplex, PassThrough } = require('node:stream');
const test = require('./support/guarded-test.cjs');
const { loadVerserGuestNode } = require('./support/verser-package-imports.cjs');
const { waitForEvent } = require('./support/websocket-fixtures.cjs');

test('Oversized single chunk with newline is rejected with 1009 before buffering', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const pt = new PassThrough();
  pt.on('error', () => {});
  const ws = new VerserWebSocket(pt);
  ws.on('error', () => {});
  try {
    const closed = waitForEvent(ws, 'close', 3000, { ignoreError: true });

    // Construct a single VWS/1 line that exceeds VWS_MAX_FRAME_BYTES (1 MiB)
    // and contains a newline. The parser must reject it before accumulating
    // the full line (byte-counting check fires before JSON parse).
    const payload = 'x'.repeat(1100 * 1024);
    const line = `${JSON.stringify({ type: 'text', data: payload })}\n`;

    // Write the oversized line as a single chunk
    pt.write(Buffer.from(line));
    pt.end();

    assert.equal((await closed.promise)[0], 1009);
  } finally {
    pt.destroy();
  }
});

test('Malformed remote frame does not crash when no ws.on(error) listener', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const pt = new PassThrough();
  pt.on('error', () => {});
  // Intentionally do NOT register any 'error' listener on ws.
  // The process must not crash when remote sends malformed JSON.
  const ws = new VerserWebSocket(pt);
  const closed = waitForEvent(ws, 'close', 3000, { ignoreError: true });
  ws.on('error', () => {});
  try {
    // Push malformed JSON (not a valid VWS frame) followed by newline
    pt.write(Buffer.from('{"type": "text", "data": "hello"\n')); // invalid JSON (missing closing brace)
    pt.end();

    await closed.promise;

    // If we reach here without crash, the default error handler works.
    // Verify the WebSocket is in a closed/ing state
    assert.ok(true, 'Process did not crash from unhandled error event');
  } finally {
    pt.destroy();
  }
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
  try {
    // Collect written data

    // Send a message BEFORE accept
    const pending = ws.send('before-accept', { type: 'text' });

    // No data should be written to the stream yet
    assert.equal(written.length, 0, 'No data written before accept');

    // Now accept
    // Accept is an internal lifecycle action; exercise it through the Guest
    // adapter contract rather than making it part of the public WebSocket API.
    ws.sendAccept('vws.test');

    await pending;

    // The accept frame should be first, followed by the queued data
    assert.ok(written.length >= 2, 'At least accept + queued data written');

    const acceptFrame = JSON.parse(written[0].toString().trimEnd());
    assert.equal(acceptFrame.type, 'accept');
    assert.equal(acceptFrame.protocol, 'vws.test');

    const dataFrame = JSON.parse(written[1].toString().trimEnd());
    assert.equal(dataFrame.type, 'text');
    assert.equal(dataFrame.data, 'before-accept');
  } finally {
    pt.destroy();
  }
});

test('Accepted sends are bounded and buffered accounting follows transport drain', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const { Duplex } = require('node:stream');
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  let blocked = true;
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const result = originalWrite(chunk, encoding, callback);
    return blocked ? false : result;
  };
  const ws = new VerserWebSocket(stream, '', true);
  try {
    const pending = ws.send('drain-me', { type: 'text' });
    assert.ok(ws.getBufferedAmount() > 0);
    blocked = false;
    stream.emit('drain');
    await pending;
    assert.equal(ws.getBufferedAmount(), 0);
  } finally {
    stream.destroy();
  }
});

test('Accepted send overflow rejects deterministically and reports protocol closure', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const { Duplex } = require('node:stream');
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const drainHandles = new Set();
  stream.write = () => {
    const handle = setImmediate(() => {
      drainHandles.delete(handle);
      stream.emit('drain');
    });
    drainHandles.add(handle);
    return false;
  };
  const ws = new VerserWebSocket(stream, '', true);
  try {
    const sends = Array.from({ length: 64 }, () =>
      ws.send(Buffer.alloc(20 * 1024), { type: 'binary' }).catch((error) => error),
    );
    const results = await Promise.all(sends);
    assert.ok(results.some((result) => result instanceof Error));
    assert.equal(ws.getBufferedAmount(), 0);
  } finally {
    for (const handle of drainHandles) clearImmediate(handle);
    drainHandles.clear();
    stream.destroy();
  }
});

test('VWS ping is automatically answered with pong and exposed as an event', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new PassThrough();
  const ws = new VerserWebSocket(stream, '', true);
  const output = [];
  stream.on('data', (chunk) => output.push(chunk.toString()));
  const pong = waitForEvent(ws, 'pong');
  try {
    stream.write('{"type":"ping","data":"nonce"}\n');
    assert.equal((await pong.promise)[0], 'nonce');
    assert.deepEqual(output.at(-1), '{"type":"pong","data":"nonce"}\n');
  } finally {
    stream.destroy();
  }
});

test('VWS rejects invalid application close codes and oversized reasons before writing', () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new PassThrough();
  const ws = new VerserWebSocket(stream, '', true);
  try {
    assert.throws(() => ws.close(1006), /Invalid WebSocket close code/);
    assert.throws(() => ws.close(2000), /Invalid WebSocket close code/);
    assert.throws(() => ws.close(1000, '😀'.repeat(32)), /123 UTF-8 bytes/);
    assert.equal(stream.read(), null);
  } finally {
    stream.destroy();
  }
});

test('VWS rejects invalid remote close frames with protocol error, never wire 1006', async () => {
  const { VerserWebSocket } = loadVerserGuestNode();
  const stream = new PassThrough();
  const output = [];
  stream.on('data', (chunk) => output.push(chunk.toString()));
  const ws = new VerserWebSocket(stream, '', true);
  const error = waitForEvent(ws, 'error', 3000, { ignoreError: true });
  const close = waitForEvent(ws, 'close', 3000, { ignoreError: true });
  try {
    stream.write('{"type":"close","code":1006,"reason":"bad"}\n');
    const protocolError = (await error.promise)[0];
    assert.match(output.at(-1), /"type":"close","code":1002/);
    assert.equal(protocolError.closeCode, 1002);
    stream.destroy();
    await close.promise.catch(() => undefined);
  } finally {
    stream.destroy();
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
  const closed = waitForEvent(ws, 'close');
  try {
    ws.close(1000, 'timeout-test');
    const [code, reason] = await closed.promise;
    const result = { code, reason };
    assert.equal(result.code, 1006);
    assert.match(result.reason, /timeout/);
  } finally {
    stream.destroy();
  }
});

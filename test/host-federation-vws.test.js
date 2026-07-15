const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('./support/guarded-test.cjs');
const { loadVerserHost } = require('./support/verser-package-imports.cjs');

const { openUpstreamFederationVwsStream, readFederationVwsNegotiation } = loadVerserHost();

function negotiationStream(line, end = false) {
  const stream = new PassThrough();
  if (line !== undefined || end) {
    process.nextTick(() => {
      stream.end(line === undefined ? undefined : `${line}\n`);
    });
  }
  return stream;
}

test('Host federation VWS opener requests the dedicated versioned endpoint', async () => {
  const requests = [];
  const session = {
    request(headers) {
      requests.push(headers);
      const stream = negotiationStream();
      process.nextTick(() => stream.emit('response', { ':status': 200 }));
      return stream;
    },
  };

  const stream = await openUpstreamFederationVwsStream(session, 'upstream-a', 'host-a');
  assert.ok(stream);
  assert.deepEqual(requests[0], {
    ':method': 'POST',
    ':path': '/verser/host/federation/websocket',
    'content-type': 'application/x-ndjson',
    'x-verser-host-id': 'host-a',
    'x-verser-federation-vws-version': '1',
  });
  stream.destroy();
});

test('Host federation VWS negotiation accepts valid VWS/1 responses', async () => {
  const result = await readFederationVwsNegotiation(
    negotiationStream('{"type":"accept","version":1,"protocol":"chat.v1"}'),
  );
  assert.equal(result, 'chat.v1');
});

test('Host federation VWS negotiation preserves peer errors', async () => {
  await assert.rejects(
    readFederationVwsNegotiation(
      negotiationStream('{"type":"error","version":1,"message":"endpoint unavailable"}'),
    ),
    (error) => {
      assert.equal(error.code, 'protocol-error');
      assert.match(error.message, /endpoint unavailable/);
      return true;
    },
  );
});

test('Federation VWS preserves structured error codes and maps endpoint rejection', async () => {
  await assert.rejects(
    readFederationVwsNegotiation(
      negotiationStream(
        '{"type":"error","version":1,"code":"missing-guest","message":"unavailable"}',
      ),
    ),
    (error) => error.code === 'missing-guest',
  );
  for (const [statusCode, expected] of [
    [403, 'authorization-denied'],
    [404, 'websocket-negotiation-failed'],
  ]) {
    const session = {
      request() {
        const stream = negotiationStream();
        stream.close = () => stream.destroy();
        process.nextTick(() => stream.emit('response', { ':status': statusCode }));
        return stream;
      },
    };
    await assert.rejects(
      openUpstreamFederationVwsStream(session, 'upstream-reject', 'host-a'),
      (error) => error.code === expected,
    );
  }
});

test('Host federation VWS negotiation distinguishes version, malformed, oversized, and EOF', async () => {
  await assert.rejects(
    readFederationVwsNegotiation(negotiationStream('{"type":"accept","version":2}')),
    /version mismatch/,
  );
  await assert.rejects(readFederationVwsNegotiation(negotiationStream('{bad')), /protocol-error/);
  await assert.rejects(
    readFederationVwsNegotiation(
      negotiationStream(`{"type":"text","version":1,"data":"${'x'.repeat(1024 * 1024)}"}`),
    ),
    /exceeds maximum|protocol-error/,
  );
  await assert.rejects(
    readFederationVwsNegotiation(negotiationStream(undefined, true)),
    (error) => error.code === 'websocket-negotiation-failed',
  );
});

test('Host federation VWS negotiation times out and cancels a silent stream', async () => {
  const stream = negotiationStream();
  await assert.rejects(
    readFederationVwsNegotiation(stream, {}, { timeoutMs: 10 }),
    (error) => error.code === 'websocket-negotiation-failed',
  );
  assert.equal(stream.destroyed, true);
});

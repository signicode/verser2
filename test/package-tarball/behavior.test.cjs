const assert = require('node:assert/strict');
const { test } = require('node:test');

const packageNames = [
  '@signicode/verser-common',
  '@signicode/verser2-guest-js-common',
  '@signicode/verser2-host',
  '@signicode/verser2-guest-node',
];

test('consumer-imports: tarball packages resolve by package name', () => {
  for (const packageName of packageNames) {
    const resolved = require.resolve(packageName);
    assert.match(resolved, /node_modules/);
    const packageExports = require(packageName);
    assert.notEqual(packageExports, undefined);
    assert.notEqual(packageExports, null);
  }
});

test('common-protocol-envelope: installed common package preserves protocol behavior', () => {
  const common = require('@signicode/verser-common');
  const request = common.createCommonBrokerRequest({
    targetId: 'guest-tarball-common',
    method: ' post ',
    path: 'tarball/path?ok=1',
    headers: { 'X-Tarball': 'yes' },
    body: 'payload',
  });
  const envelope = common.encodeVerserEnvelope({
    type: 'request',
    metadata: {
      requestId: 'req-tarball-common',
      sourceId: 'broker-tarball-common',
      targetId: request.targetId,
      method: request.method,
      path: request.path,
      headers: request.headers,
    },
  });
  const parsed = common.createVerserEnvelopeParser().push(envelope);

  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/tarball/path?ok=1');
  assert.deepEqual(request.body, [Buffer.from('payload')]);
  assert.equal(parsed.type, 'request');
  assert.equal(parsed.metadata.requestId, 'req-tarball-common');
});

test('host-guest-broker-smoke: installed packages route a lightweight request', async () => {
  const { createVerserHost } = require('@signicode/verser2-host');
  const {
    createVerserBroker,
    createVerserNodeGuest,
  } = require('@signicode/verser2-guest-node');

  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  let broker;
  let guest;

  try {
    broker = createVerserBroker({ hostUrl, brokerId: 'broker-tarball-smoke' });
    guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-tarball-smoke' });
    guest.attach((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(202, { 'x-tarball': 'yes' });
        response.end(Buffer.concat(chunks));
      });
    }, 'tarball.local.test');

    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('tarball.local.test');

    const response = await broker.request({
      targetId: 'guest-tarball-smoke',
      method: 'POST',
      path: '/smoke',
      headers: { 'x-input': 'tarball' },
      body: [Buffer.from('tarball-body')],
    });
    const bodyChunks = [];

    for await (const chunk of response.body) {
      bodyChunks.push(Buffer.from(chunk));
    }

    assert.equal(response.statusCode, 202);
    assert.equal(response.headers['x-tarball'], 'yes');
    assert.deepEqual(Buffer.concat(bodyChunks), Buffer.from('tarball-body'));
  } finally {
    if (broker !== undefined) await broker.close('test-complete');
    if (guest !== undefined) await guest.close('test-complete');
    await host.close('test-complete');
  }
});

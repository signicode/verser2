const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { test } = require('node:test');

const { loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();

function tlsOptions(clientAuth) {
  return {
    cert: trusted.certificate,
    key: trusted.key,
    clientAuth,
  };
}

function hostUrl(host) {
  return `https://localhost:${host.address.port}`;
}

test('Host connects outbound to an upstream Host and closes the link', async () => {
  const upstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  const handle = await downstream.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(upstream),
    tls: { ca: trusted.certificate },
  });

  assert.equal(handle.upstreamId, 'manager');
  assert.deepEqual(downstream.getUpstreams(), [{ upstreamId: 'manager', connected: true }]);

  await handle.close('test-close');
  assert.deepEqual(downstream.getUpstreams(), []);
  await downstream.close();
  await upstream.close();
});

test('Host close cleans up upstream links even when the downstream Host was never started', async () => {
  const upstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  await downstream.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(upstream),
    tls: { ca: trusted.certificate },
  });
  assert.equal(downstream.getUpstreams().length, 1);

  await downstream.close('close-without-listener');
  assert.deepEqual(downstream.getUpstreams(), []);
  await upstream.close();
});

test('Receiving Host observes inbound federation link disconnects', async () => {
  const upstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  const upstreamEvents = [];
  upstream.onLifecycle((event) => upstreamEvents.push(event));
  await upstream.start();

  await downstream.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(upstream),
    tls: { ca: trusted.certificate },
  });
  assert(
    upstreamEvents.some((event) => event.name === 'registered' && event.peerId === 'host-runner'),
  );

  await downstream.close('downstream-close');
  await assertEventually(() =>
    assert(
      upstreamEvents.some(
        (event) => event.name === 'disconnected' && event.peerId === 'host-runner',
      ),
    ),
  );

  await upstream.close();
});

test('Unexpected upstream disconnect removes imported routes and emits lifecycle', async () => {
  const upstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  const events = [];
  downstream.onLifecycle((event) => events.push(event));
  await upstream.start();

  await downstream.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(upstream),
    tls: { ca: trusted.certificate },
  });
  downstream.setImportedFederatedRoutes('manager', [
    {
      targetId: 'guest-alpha',
      domain: 'alpha.verser.test',
      originHostId: 'host-leaf',
      nextHopHostId: 'host-manager',
      hopCount: 1,
      viaHostIds: ['host-leaf'],
      source: 'upstream',
    },
  ]);
  assert.equal(
    downstream.getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test').length,
    1,
  );

  await upstream.close('upstream-crash');
  await assertEventually(() => assert.deepEqual(downstream.getUpstreams(), []));
  assert.deepEqual(downstream.getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test'), []);
  assert(events.some((event) => event.name === 'disconnected' && event.peerId === 'manager'));

  await downstream.close();
});

test('Host rejects duplicate upstream connection IDs', async () => {
  const upstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  await downstream.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(upstream),
    tls: { ca: trusted.certificate },
  });
  await assert.rejects(
    () =>
      downstream.connectUpstream({
        upstreamId: 'manager',
        url: hostUrl(upstream),
        tls: { ca: trusted.certificate },
      }),
    /already connected/,
  );

  await downstream.close();
  await upstream.close();
});

test('Host rejects concurrent duplicate upstream connection IDs', async () => {
  const upstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  const attempts = await Promise.allSettled([
    downstream.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(upstream),
      tls: { ca: trusted.certificate },
    }),
    downstream.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(upstream),
      tls: { ca: trusted.certificate },
    }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);

  await downstream.close();
  await upstream.close();
});

test('Host upstream handshake rejects when the stream closes without a response', async () => {
  const badUpstream = http2.createSecureServer({ cert: trusted.certificate, key: trusted.key });
  badUpstream.on('stream', (stream) => stream.close());
  await new Promise((resolve) => badUpstream.listen(0, '127.0.0.1', resolve));
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });

  await assert.rejects(
    () =>
      downstream.connectUpstream({
        upstreamId: 'bad-manager',
        url: `https://localhost:${badUpstream.address().port}`,
        tls: { ca: trusted.certificate },
      }),
    /handshake/i,
  );

  await downstream.close();
  await new Promise((resolve) => badUpstream.close(resolve));
});

test('Host upstream handshake rejects when response body never ends', async () => {
  const badUpstream = http2.createSecureServer({ cert: trusted.certificate, key: trusted.key });
  badUpstream.on('stream', (stream) => stream.respond({ ':status': 200 }));
  await new Promise((resolve) => badUpstream.listen(0, '127.0.0.1', resolve));
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });

  await assert.rejects(
    () =>
      downstream.connectUpstream({
        upstreamId: 'bad-manager',
        url: `https://localhost:${badUpstream.address().port}`,
        tls: { ca: trusted.certificate },
      }),
    /handshake/i,
  );

  await downstream.close();
  await new Promise((resolve) => badUpstream.close(resolve));
});

test('Upstream authorization callback accepts Host links with mTLS identity', async () => {
  const contexts = [];
  const upstream = createVerserHost({
    hostId: 'host-manager',
    tls: tlsOptions({
      ca: clientCa.certificate,
      authorizeFederation: (context) => {
        contexts.push(context);
        return { action: 'allow' };
      },
    }),
  });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  await downstream.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(upstream),
    tls: {
      ca: trusted.certificate,
      cert: trustedClient.certificate,
      key: trustedClient.key,
    },
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].hostId, 'host-runner');
  assert.equal(contexts[0].handshake.hostId, 'host-runner');
  assert.equal(contexts[0].metadata.authorized, true);
  assert.match(contexts[0].certificate.commonName, /trusted-client/);

  await downstream.close();
  await upstream.close();
});

test('Upstream authorization callback rejects Host links predictably', async () => {
  const upstream = createVerserHost({
    hostId: 'host-manager',
    tls: tlsOptions({
      authorizeFederation: () => ({ action: 'close', reason: 'not allowed' }),
    }),
  });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  await assert.rejects(
    () =>
      downstream.connectUpstream({
        upstreamId: 'manager',
        url: hostUrl(upstream),
        tls: { ca: trusted.certificate },
      }),
    /not allowed/,
  );
  assert.deepEqual(downstream.getUpstreams(), []);

  await downstream.close();
  await upstream.close();
});

async function assertEventually(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

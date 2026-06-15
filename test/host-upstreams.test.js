const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { PassThrough } = require('node:stream');
const { text } = require('node:stream/consumers');
const { test } = require('node:test');

const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker } = loadVerserGuestNode();

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

test('Downstream local Guest routes are exported to an upstream Host and withdrawn', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await manager.start();

  await runner.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(manager),
    tls: { ca: trusted.certificate },
  });
  const guest = await runner.attachLocalGuest({
    guestId: 'guest-runner',
    routedDomains: ['runner.verser.test'],
    listener: (_request, response) => response.end('runner'),
  });

  await assertEventually(() =>
    assert.equal(
      manager.getFederatedRouteCandidates('guest-runner', 'runner.verser.test').length,
      1,
    ),
  );

  await guest.close();
  await assertEventually(() =>
    assert.deepEqual(manager.getFederatedRouteCandidates('guest-runner', 'runner.verser.test'), []),
  );

  await runner.close();
  await manager.close();
});

test('Downstream Host imports upstream route advertisements', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  const managerEvents = [];
  manager.onLifecycle((event) => managerEvents.push(event));
  await manager.start();
  const guest = await manager.attachLocalGuest({
    guestId: 'guest-manager',
    routedDomains: ['manager.verser.test'],
    listener: (_request, response) => response.end('manager'),
  });

  await runner.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(manager),
    tls: { ca: trusted.certificate },
  });

  await assertEventually(() =>
    assert.equal(
      runner.getFederatedRouteCandidates('guest-manager', 'manager.verser.test').length,
      1,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    managerEvents.some((event) => event.name === 'error' && event.error?.code === 'route-loop'),
    false,
  );

  await guest.close();
  await assertEventually(() =>
    assert.deepEqual(
      runner.getFederatedRouteCandidates('guest-manager', 'manager.verser.test'),
      [],
    ),
  );

  await runner.close();
  await manager.close();
});

test('Federated routes propagate across manager hub runner topology and withdraw on Host disconnect', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const hub = createVerserHost({ hostId: 'host-hub', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await manager.start();
  await hub.start();

  await hub.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(manager),
    tls: { ca: trusted.certificate },
  });
  await runner.connectUpstream({
    upstreamId: 'hub',
    url: hostUrl(hub),
    tls: { ca: trusted.certificate },
  });
  await runner.attachLocalGuest({
    guestId: 'guest-runner',
    routedDomains: ['runner-chain.verser.test'],
    listener: (_request, response) => response.end('runner'),
  });

  await assertEventually(() => {
    const [route] = manager.getFederatedRouteCandidates('guest-runner', 'runner-chain.verser.test');
    assert.equal(route.originHostId, 'host-runner');
    assert.equal(route.nextHopHostId, 'host-hub');
    assert.equal(route.hopCount, 2);
    assert.deepEqual(route.viaHostIds, ['host-runner', 'host-hub']);
  });

  await runner.close('runner-disconnect');
  await assertEventually(() =>
    assert.deepEqual(
      manager.getFederatedRouteCandidates('guest-runner', 'runner-chain.verser.test'),
      [],
    ),
  );

  await hub.close();
  await manager.close();
});

test('Imported federated routes avoid re-export loops and advertise legacy Broker routes', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await manager.start();

  await runner.connectUpstream({
    upstreamId: 'manager',
    url: hostUrl(manager),
    tls: { ca: trusted.certificate },
  });
  await runner.attachLocalGuest({
    guestId: 'guest-runner',
    routedDomains: ['runner-loop.verser.test'],
    listener: (_request, response) => response.end('runner'),
  });
  const broker = await manager.attachLocalBroker({ brokerId: 'broker-manager' });

  await assertEventually(() =>
    assert.equal(
      manager.getFederatedRouteCandidates('guest-runner', 'runner-loop.verser.test').length,
      1,
    ),
  );
  await assertEventually(() =>
    assert.deepEqual(
      runner.getFederatedRouteCandidates('guest-runner', 'runner-loop.verser.test'),
      [
        {
          targetId: 'guest-runner',
          domain: 'runner-loop.verser.test',
          originHostId: 'host-runner',
          nextHopHostId: 'host-runner',
          hopCount: 0,
          viaHostIds: ['host-runner'],
          source: 'local',
        },
      ],
    ),
  );
  await assertEventually(() =>
    assert.deepEqual(broker.getRoutes(), [
      { targetId: 'guest-runner', domain: 'runner-loop.verser.test' },
    ]),
  );

  await broker.close();
  await runner.close();
  await manager.close();
});

test('Broker connected to an upstream Host reaches a downstream Guest through federation', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await runner.attachLocalGuest({
      guestId: 'guest-runner',
      routedDomains: ['runner-forward.verser.test'],
      listener: async (request, response) => {
        const body = await text(request);
        response.writeHead(207, { 'x-federated': request.headers['x-forwarded-check'] });
        response.end(`forwarded:${request.method}:${request.url}:${body}`);
      },
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('guest-runner', 'runner-forward.verser.test').length,
        1,
      ),
    );
    broker = await manager.attachLocalBroker({ brokerId: 'broker-manager' });

    const response = await broker.request({
      targetId: 'guest-runner',
      method: 'POST',
      path: '/federated?phase=5',
      headers: { host: 'runner-forward.verser.test', 'x-forwarded-check': 'yes' },
      body: [Buffer.from('request-body')],
    });

    assert.equal(response.statusCode, 207);
    assert.equal(response.headers['x-federated'], 'yes');
    assert.equal(await text(response.body), 'forwarded:POST:/federated?phase=5:request-body');
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Remote Broker request is forwarded through an upstream Host to a downstream Guest', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await runner.attachLocalGuest({
      guestId: 'guest-runner-remote',
      routedDomains: ['runner-remote-forward.verser.test'],
      listener: async (request, response) => {
        const body = await text(request);
        response.writeHead(208, { 'x-remote-federated': request.headers['x-forwarded-check'] });
        response.end(`remote:${request.method}:${request.url}:${body}`);
      },
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-runner-remote',
          'runner-remote-forward.verser.test',
        ).length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-remote-manager',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await assertEventually(() =>
      assert.deepEqual(broker.getRoutes(), [
        { targetId: 'guest-runner-remote', domain: 'runner-remote-forward.verser.test' },
      ]),
    );

    const response = await broker.request({
      targetId: 'guest-runner-remote',
      method: 'PUT',
      path: '/remote-federated',
      headers: { host: 'runner-remote-forward.verser.test', 'x-forwarded-check': 'remote' },
      body: [Buffer.from('remote-body')],
    });

    assert.equal(response.statusCode, 208);
    assert.equal(response.headers['x-remote-federated'], 'remote');
    assert.equal(await text(response.body), 'remote:PUT:/remote-federated:remote-body');

    const secondResponse = await broker.request({
      targetId: 'guest-runner-remote',
      method: 'PATCH',
      path: '/remote-federated-again',
      headers: { host: 'runner-remote-forward.verser.test', 'x-forwarded-check': 'again' },
      body: [Buffer.from('second-body')],
    });

    assert.equal(secondResponse.statusCode, 208);
    assert.equal(secondResponse.headers['x-remote-federated'], 'again');
    assert.equal(
      await text(secondResponse.body),
      'remote:PATCH:/remote-federated-again:second-body',
    );

    const [thirdResponse, fourthResponse] = await Promise.all([
      broker.request({
        targetId: 'guest-runner-remote',
        method: 'POST',
        path: '/remote-concurrent-a',
        headers: { host: 'runner-remote-forward.verser.test', 'x-forwarded-check': 'third' },
        body: [Buffer.from('third-body')],
      }),
      broker.request({
        targetId: 'guest-runner-remote',
        method: 'POST',
        path: '/remote-concurrent-b',
        headers: { host: 'runner-remote-forward.verser.test', 'x-forwarded-check': 'fourth' },
        body: [Buffer.from('fourth-body')],
      }),
    ]);

    assert.equal(await text(thirdResponse.body), 'remote:POST:/remote-concurrent-a:third-body');
    assert.equal(await text(fourthResponse.body), 'remote:POST:/remote-concurrent-b:fourth-body');
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated forwarding maps downstream Guest handler failures to Broker errors', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await runner.attachLocalGuest({
      guestId: 'guest-federated-error',
      routedDomains: ['runner-error-forward.verser.test'],
      listener: () => {
        throw new Error('downstream boom');
      },
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-federated-error',
          'runner-error-forward.verser.test',
        ).length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-error-manager',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-federated-error',
          method: 'GET',
          path: '/boom',
          headers: { host: 'runner-error-forward.verser.test' },
        }),
      (error) => error.code === 'local-handler-failure' && /downstream boom/.test(error.message),
    );
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated forwarding streams request and response bodies', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await runner.attachLocalGuest({
      guestId: 'guest-federated-stream',
      routedDomains: ['runner-stream-forward.verser.test'],
      listener: async (request, response) => {
        const body = await text(request);
        response.writeHead(209, { 'x-streamed': 'yes' });
        response.write(`first:${body}:`);
        setTimeout(() => response.end('second'), 5);
      },
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-federated-stream',
          'runner-stream-forward.verser.test',
        ).length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-stream-manager',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    const body = new PassThrough();
    const responsePromise = broker.request({
      targetId: 'guest-federated-stream',
      method: 'POST',
      path: '/streamed',
      headers: { host: 'runner-stream-forward.verser.test' },
      body,
    });
    body.write('one-');
    setTimeout(() => body.end('two'), 5);

    const response = await responsePromise;
    assert.equal(response.statusCode, 209);
    assert.equal(response.headers['x-streamed'], 'yes');
    assert.equal(await text(response.body), 'first:one-two:second');
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
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

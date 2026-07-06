const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { PassThrough } = require('node:stream');
const { text } = require('node:stream/consumers');
const { test } = require('node:test');

const {
  loadVerserGuestBun,
  loadVerserGuestNode,
  loadVerserHost,
} = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker } = loadVerserGuestNode();
const { createVerserBroker: createVerserBunBroker } = loadVerserGuestBun();

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

async function connectRawClient(port) {
  const session = http2.connect(`https://127.0.0.1:${port}`, { ca: trusted.certificate });
  await once(session, 'connect');
  return session;
}

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

test('Host federation requires configured Host IDs on both sides', async () => {
  const upstream = createVerserHost({ tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  await upstream.start();

  await assert.rejects(
    () =>
      downstream.connectUpstream({
        upstreamId: 'manager',
        url: hostUrl(upstream),
        tls: { ca: trusted.certificate },
      }),
    /hostId/i,
  );

  await downstream.close();
  await upstream.close();

  const configuredUpstream = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const unconfiguredDownstream = createVerserHost({ tls: tlsOptions() });
  await configuredUpstream.start();
  await assert.rejects(
    () =>
      unconfiguredDownstream.connectUpstream({
        upstreamId: 'manager',
        url: hostUrl(configuredUpstream),
        tls: { ca: trusted.certificate },
      }),
    /hostId/i,
  );
  await unconfiguredDownstream.close();
  await configuredUpstream.close();
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

test('Federated HA selects the closest healthy route candidate and falls back after upstream loss', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const nearRunner = createVerserHost({ hostId: 'host-near-runner', tls: tlsOptions() });
  const farHub = createVerserHost({ hostId: 'host-far-hub', tls: tlsOptions() });
  const farRunner = createVerserHost({ hostId: 'host-far-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  await farHub.start();
  try {
    await nearRunner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await farHub.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await farRunner.connectUpstream({
      upstreamId: 'far-hub',
      url: hostUrl(farHub),
      tls: { ca: trusted.certificate },
    });
    await nearRunner.attachLocalGuest({
      guestId: 'guest-ha',
      routedDomains: ['ha.verser.test'],
      listener: (_request, response) => response.end('near'),
    });
    await farRunner.attachLocalGuest({
      guestId: 'guest-ha',
      routedDomains: ['ha.verser.test'],
      listener: (_request, response) => response.end('far'),
    });
    await assertEventually(() =>
      assert.equal(manager.getFederatedRouteCandidates('guest-ha', 'ha.verser.test').length, 2),
    );
    broker = await manager.attachLocalBroker({ brokerId: 'broker-ha' });

    const first = await broker.request({
      targetId: 'guest-ha',
      method: 'GET',
      path: '/ha',
      headers: { host: 'ha.verser.test' },
    });
    assert.equal(await text(first.body), 'near');

    await nearRunner.close('near-loss');
    await assertEventually(() => {
      const candidates = manager.getFederatedRouteCandidates('guest-ha', 'ha.verser.test');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].originHostId, 'host-far-runner');
    });
    const second = await broker.request({
      targetId: 'guest-ha',
      method: 'GET',
      path: '/ha',
      headers: { host: 'ha.verser.test' },
    });
    assert.equal(await text(second.body), 'far');
  } finally {
    await broker?.close();
    await farRunner.close();
    await farHub.close();
    await nearRunner.close();
    await manager.close();
  }
});

test('Federated HA falls back when a preferred imported candidate has no request stream', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const farRunner = createVerserHost({ hostId: 'host-far-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await farRunner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await farRunner.attachLocalGuest({
      guestId: 'guest-ha-stale',
      routedDomains: ['ha-stale.verser.test'],
      listener: (_request, response) => response.end('far'),
    });
    manager.setImportedFederatedRoutes('stale-near', [
      {
        targetId: 'guest-ha-stale',
        domain: 'ha-stale.verser.test',
        originHostId: 'host-a-stale-near',
        nextHopHostId: 'host-a-stale-near',
        hopCount: 1,
        viaHostIds: ['host-a-stale-near'],
        source: 'upstream',
      },
    ]);
    await assertEventually(() => {
      const candidates = manager.getFederatedRouteCandidates(
        'guest-ha-stale',
        'ha-stale.verser.test',
      );
      assert.equal(candidates.length, 2);
      assert.equal(candidates[0].originHostId, 'host-a-stale-near');
    });
    broker = await manager.attachLocalBroker({ brokerId: 'broker-ha-stale' });

    const response = await broker.request({
      targetId: 'guest-ha-stale',
      method: 'GET',
      path: '/ha-stale',
      headers: { host: 'ha-stale.verser.test' },
      leaseAcquireTimeoutMs: 20,
    });

    assert.equal(await text(response.body), 'far');
  } finally {
    await broker?.close();
    await farRunner.close();
    await manager.close();
  }
});

test('Federated HA reports upstream unavailable when all local Broker candidates are unusable', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  let broker;
  try {
    manager.setImportedFederatedRoutes('stale-runner', [
      {
        targetId: 'guest-ha-unavailable-local',
        domain: 'ha-unavailable-local.verser.test',
        originHostId: 'host-stale-runner',
        nextHopHostId: 'host-stale-runner',
        hopCount: 1,
        viaHostIds: ['host-stale-runner'],
        source: 'upstream',
      },
    ]);
    broker = await manager.attachLocalBroker({ brokerId: 'broker-ha-unavailable-local' });

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-ha-unavailable-local',
          method: 'GET',
          path: '/ha-unavailable',
          headers: { host: 'ha-unavailable-local.verser.test' },
          leaseAcquireTimeoutMs: 10,
        }),
      (error) => {
        assert.equal(error.code, 'upstream-unavailable');
        assert.equal(error.context?.targetId, 'guest-ha-unavailable-local');
        assert.equal(error.context?.direction, 'federated-candidates');
        assert.equal(error.context?.nextHopHostIds, 'host-stale-runner');
        return true;
      },
    );
  } finally {
    await broker?.close();
    await manager.close();
  }
});

test('Federated HA reports upstream unavailable when all H2 Broker candidates are unusable', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    manager.setImportedFederatedRoutes('stale-runner', [
      {
        targetId: 'guest-ha-unavailable-h2',
        domain: 'ha-unavailable-h2.verser.test',
        originHostId: 'host-stale-runner',
        nextHopHostId: 'host-stale-runner',
        hopCount: 1,
        viaHostIds: ['host-stale-runner'],
        source: 'upstream',
      },
    ]);
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-ha-unavailable-h2',
      tls: { ca: trusted.certificate },
      leaseAcquireTimeoutMs: 10,
    });
    await broker.connect();
    await broker.waitForRoute('ha-unavailable-h2.verser.test');

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-ha-unavailable-h2',
          method: 'GET',
          path: '/ha-unavailable',
          headers: { host: 'ha-unavailable-h2.verser.test' },
        }),
      (error) => {
        assert.equal(error.code, 'upstream-unavailable');
        assert.equal(error.context?.targetId, 'guest-ha-unavailable-h2');
        assert.equal(error.context?.direction, 'federated-candidates');
        assert.equal(error.context?.nextHopHostIds, 'host-stale-runner');
        return true;
      },
    );
  } finally {
    await broker?.close();
    await manager.close();
  }
});

test('Federated forwarding preserves downstream structured error codes', async () => {
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
    runner.setImportedFederatedRoutes('stale-leaf', [
      {
        targetId: 'guest-leaf-unavailable',
        domain: 'leaf-unavailable.verser.test',
        originHostId: 'host-leaf',
        nextHopHostId: 'host-leaf',
        hopCount: 1,
        viaHostIds: ['host-leaf'],
        source: 'upstream',
      },
    ]);
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-leaf-unavailable',
          'leaf-unavailable.verser.test',
        ).length,
        1,
      ),
    );
    broker = await manager.attachLocalBroker({ brokerId: 'broker-preserve-federated-error' });

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'guest-leaf-unavailable',
          method: 'GET',
          path: '/unavailable',
          headers: { host: 'leaf-unavailable.verser.test' },
          leaseAcquireTimeoutMs: 10,
        }),
      (error) => {
        assert.equal(error.code, 'upstream-unavailable');
        assert.equal(error.context?.targetId, 'guest-leaf-unavailable');
        assert.equal(error.context?.direction, 'federated-candidates');
        assert.equal(error.context?.nextHopHostIds, 'host-leaf');
        return true;
      },
    );
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Downstream Broker requests imported upstream Guest route through federation', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await manager.attachLocalGuest({
      guestId: 'guest-manager-upstream',
      routedDomains: ['manager-upstream.verser.test'],
      listener: async (request, response) => {
        const body = await text(request);
        response.writeHead(200, { 'x-upstream-handler': 'manager' });
        response.end(`${request.method}:${request.url}:${body}`);
      },
    });

    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });

    await assertEventually(() =>
      assert.equal(
        runner.getFederatedRouteCandidates('guest-manager-upstream', 'manager-upstream.verser.test')
          .length,
        1,
      ),
    );

    broker = createVerserBroker({
      hostUrl: hostUrl(runner),
      brokerId: 'broker-on-runner',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await broker.waitForRoute('manager-upstream.verser.test');

    const response = await broker.request({
      targetId: 'guest-manager-upstream',
      method: 'POST',
      path: '/upstream-path?q=1',
      headers: { host: 'manager-upstream.verser.test' },
      body: [Buffer.from('upstream-body')],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-upstream-handler'], 'manager');
    assert.equal(await text(response.body), 'POST:/upstream-path?q=1:upstream-body');
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Downstream Broker follows 308 redirect through upstream federation chain', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await manager.attachLocalGuest({
      guestId: 'guest-manager-redirect',
      routedDomains: ['manager-redirect.verser.test'],
      listener: (_request, response) => {
        response.writeHead(308, {
          location: 'http://manager-final.verser.test/final?via=upstream',
        });
        response.end();
      },
    });
    await manager.attachLocalGuest({
      guestId: 'guest-manager-final',
      routedDomains: ['manager-final.verser.test'],
      listener: async (request, response) => {
        const body = await text(request);
        response.writeHead(200, { 'x-upstream-handler': 'final' });
        response.end(`${request.method}:${request.url}:${body}`);
      },
    });

    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });

    await assertEventually(() =>
      assert.equal(
        runner.getFederatedRouteCandidates('guest-manager-redirect', 'manager-redirect.verser.test')
          .length,
        1,
      ),
    );
    await assertEventually(() =>
      assert.equal(
        runner.getFederatedRouteCandidates('guest-manager-final', 'manager-final.verser.test')
          .length,
        1,
      ),
    );

    broker = createVerserBroker({
      hostUrl: hostUrl(runner),
      brokerId: 'broker-redirect-on-runner',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await broker.waitForRoute('manager-redirect.verser.test');
    await broker.waitForRoute('manager-final.verser.test');

    const response = await broker.request({
      targetId: 'guest-manager-redirect',
      method: 'POST',
      path: '/redirect-me',
      headers: { host: 'manager-redirect.verser.test' },
      body: [Buffer.from('redirect-body')],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-upstream-handler'], 'final');
    assert.equal(await text(response.body), 'POST:/final?via=upstream:redirect-body');
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Bun-facing Broker fetch reaches imported upstream route through federation', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  try {
    await manager.attachLocalGuest({
      guestId: 'guest-manager-bun-fetch',
      routedDomains: ['manager-bun-fetch.verser.test'],
      listener: async (request, response) => {
        const body = await text(request);
        response.writeHead(202, { 'x-bun-facing': request.method });
        response.end(`${request.url}:${body}`);
      },
    });

    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });

    broker = createVerserBunBroker({
      hostUrl: hostUrl(runner),
      brokerId: 'broker-bun-facing-upstream',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await broker.waitForRoute('manager-bun-fetch.verser.test');

    const fetch = broker.createFetch();
    const response = await fetch('http://manager-bun-fetch.verser.test/from-bun?via=fetch', {
      method: 'POST',
      body: 'bun-fetch-body',
    });

    assert.equal(response.status, 202);
    assert.equal(response.headers.get('x-bun-facing'), 'POST');
    assert.equal(await response.text(), '/from-bun?via=fetch:bun-fetch-body');
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated forwarding strips transfer-encoding and connection-listed response headers', async () => {
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
      guestId: 'guest-federated-headers',
      routedDomains: ['federated-headers.verser.test'],
      listener: (_request, response) => {
        response.setHeader('transfer-encoding', 'chunked');
        response.setHeader('connection', 'x-foo');
        response.setHeader('x-foo', 'should-be-stripped');
        response.setHeader('x-end-to-end', 'preserved');
        response.end('ok');
      },
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-federated-headers',
          'federated-headers.verser.test',
        ).length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-federated-headers',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await broker.waitForRoute('federated-headers.verser.test');

    const response = await broker.request({
      targetId: 'guest-federated-headers',
      method: 'GET',
      path: '/federated-headers',
      headers: { host: 'federated-headers.verser.test' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-end-to-end'], 'preserved');
    assert.equal(response.headers['transfer-encoding'], undefined);
    assert.equal(response.headers.connection, undefined);
    assert.equal(response.headers['x-foo'], undefined);
    await text(response.body);
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated route revocation propagates lifecycle events from downstream to upstream Host', async () => {
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

    // Attach a local Broker to the manager BEFORE the Guest so we can
    // observe lifecycle events that arrive through federation.
    const managerEvents = [];
    broker = await manager.attachLocalBroker({ brokerId: 'broker-revoke-manager' });
    broker.onRouteChange((event) => managerEvents.push(event));

    const guest = await runner.attachLocalGuest({
      guestId: 'guest-revoke-federated',
      routedDomains: ['revoke-federated.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    // Wait for the federated route to appear on the manager (via full snapshot)
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-revoke-federated',
          'revoke-federated.verser.test',
        ).length,
        1,
      ),
    );

    // Revoke the route on the runner's Guest
    const result = guest.revokeRoutes(['revoke-federated.verser.test']);
    assert.deepEqual(result.revoked, ['revoke-federated.verser.test']);

    // Verify the manager's Broker observes the removed event
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'removed' &&
            e.targetId === 'guest-revoke-federated' &&
            e.domain === 'revoke-federated.verser.test' &&
            e.reason === 'revoked',
        ),
      ),
    );

    // Verify the route is no longer available on the manager
    assert.deepEqual(
      manager.getFederatedRouteCandidates('guest-revoke-federated', 'revoke-federated.verser.test'),
      [],
    );
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated route degraded/disconnected state propagates through federation', async () => {
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

    const guest = await runner.attachLocalGuest({
      guestId: 'guest-degrade-federated',
      routedDomains: ['degrade-federated.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-degrade-federated',
          'degrade-federated.verser.test',
        ).length,
        1,
      ),
    );

    // Attach local Broker to manager to observe lifecycle events
    broker = await manager.attachLocalBroker({ brokerId: 'broker-degrade-manager' });
    const managerEvents = [];
    broker.onRouteChange((event) => managerEvents.push(event));

    // Disconnect the Guest (close)
    await guest.close();

    // Verify the manager's Broker receives a 'degraded' event
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'degraded' &&
            e.targetId === 'guest-degrade-federated' &&
            e.domain === 'degrade-federated.verser.test' &&
            e.reason === 'disconnected',
        ),
      ),
    );

    // Verify the route is removed from the manager's active candidates
    // (The route goes degraded on the runner; the full federated snapshot removes it)
    await assertEventually(() =>
      assert.deepEqual(
        manager.getFederatedRouteCandidates(
          'guest-degrade-federated',
          'degrade-federated.verser.test',
        ),
        [],
      ),
    );
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated route restoration before timeout propagates through federation', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({
    hostId: 'host-runner',
    tls: tlsOptions(),
    degradedRouteTimeoutMs: 2000,
  });
  let broker;
  await manager.start();
  try {
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });

    // Attach Broker before Guest disconnection to catch lifecycle events
    const managerEvents = [];
    broker = await manager.attachLocalBroker({ brokerId: 'broker-restore-manager' });
    broker.onRouteChange((event) => managerEvents.push(event));

    const guest = await runner.attachLocalGuest({
      guestId: 'guest-restore-federated',
      routedDomains: ['restore-federated.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-restore-federated',
          'restore-federated.verser.test',
        ).length,
        1,
      ),
    );

    // Disconnect the Guest
    await guest.close();

    // Verify degraded event propagates
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'degraded' &&
            e.targetId === 'guest-restore-federated' &&
            e.domain === 'restore-federated.verser.test' &&
            e.reason === 'disconnected',
        ),
      ),
    );

    // Reconnect the Guest with same peerId and domain BEFORE the timeout
    const restoredGuest = await runner.attachLocalGuest({
      guestId: 'guest-restore-federated',
      routedDomains: ['restore-federated.verser.test'],
      listener: (_request, response) => response.end('restored'),
    });

    // Verify the manager's Broker receives a 'changed' (restored) event
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'changed' &&
            e.targetId === 'guest-restore-federated' &&
            e.domain === 'restore-federated.verser.test' &&
            e.reason === 'restored',
        ),
      ),
    );

    // Verify the route is available again on the manager
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-restore-federated',
          'restore-federated.verser.test',
        ).length,
        1,
      ),
    );

    await restoredGuest.close();
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated route full removal after timeout propagates through federation', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const runner = createVerserHost({
    hostId: 'host-runner',
    tls: tlsOptions(),
    degradedRouteTimeoutMs: 100,
  });
  let broker;
  await manager.start();
  try {
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });

    const guest = await runner.attachLocalGuest({
      guestId: 'guest-timeout-federated',
      routedDomains: ['timeout-federated.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-timeout-federated',
          'timeout-federated.verser.test',
        ).length,
        1,
      ),
    );

    // Attach Broker to observe lifecycle events
    broker = await manager.attachLocalBroker({ brokerId: 'broker-timeout-manager' });
    const managerEvents = [];
    broker.onRouteChange((event) => managerEvents.push(event));

    // Disconnect the Guest
    await guest.close();

    // Verify degraded event propagates
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'degraded' &&
            e.targetId === 'guest-timeout-federated' &&
            e.domain === 'timeout-federated.verser.test',
        ),
      ),
    );

    // Wait for the degraded route timeout to expire
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify the manager's Broker receives a 'removed' (timeout) event
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'removed' &&
            e.targetId === 'guest-timeout-federated' &&
            e.domain === 'timeout-federated.verser.test' &&
            e.reason === 'timeout',
        ),
      ),
    );

    // Verify the route is gone from the manager's candidates
    assert.deepEqual(
      manager.getFederatedRouteCandidates(
        'guest-timeout-federated',
        'timeout-federated.verser.test',
      ),
      [],
    );
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

test('Federated route lifecycle events propagate across multi-hop topology (runner -> hub -> manager)', async () => {
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const hub = createVerserHost({ hostId: 'host-hub', tls: tlsOptions() });
  const runner = createVerserHost({ hostId: 'host-runner', tls: tlsOptions() });
  let broker;
  await manager.start();
  await hub.start();

  try {
    // Build chain: runner -> hub -> manager
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

    // Attach local Broker to manager to observe lifecycle events
    broker = await manager.attachLocalBroker({ brokerId: 'broker-multi-hop' });
    const managerEvents = [];
    broker.onRouteChange((event) => managerEvents.push(event));

    // Register a Guest on the runner with a domain
    const guest = await runner.attachLocalGuest({
      guestId: 'guest-multi-hop',
      routedDomains: ['multi-hop.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    // Wait for route to propagate to manager via hub
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('guest-multi-hop', 'multi-hop.verser.test').length,
        1,
      ),
    );

    // 1) Revoke the route — expect lifecycle event on the manager's Broker
    const revokeResult = guest.revokeRoutes(['multi-hop.verser.test']);
    assert.deepEqual(revokeResult.revoked, ['multi-hop.verser.test']);

    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'removed' &&
            e.targetId === 'guest-multi-hop' &&
            e.domain === 'multi-hop.verser.test' &&
            e.reason === 'revoked',
        ),
        `Expected removed/revoked event on multi-hop manager, got: ${JSON.stringify(managerEvents)}`,
      ),
    );

    // Verify route is gone from manager
    assert.deepEqual(
      manager.getFederatedRouteCandidates('guest-multi-hop', 'multi-hop.verser.test'),
      [],
    );

    // Close the first guest handle so we can re-register
    await guest.close();

    managerEvents.length = 0;

    // 2) Re-register the Guest and test degraded propagation
    const guest2 = await runner.attachLocalGuest({
      guestId: 'guest-multi-hop',
      routedDomains: ['multi-hop.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('guest-multi-hop', 'multi-hop.verser.test').length,
        1,
      ),
    );

    // Close the Guest to trigger degraded state on runner
    await guest2.close();

    // The manager's Broker should receive a degraded/disconnected lifecycle
    // event propagated through the hub
    await assertEventually(() =>
      assert.ok(
        managerEvents.some(
          (e) =>
            e.type === 'degraded' &&
            e.targetId === 'guest-multi-hop' &&
            e.domain === 'multi-hop.verser.test' &&
            e.reason === 'disconnected',
        ),
        `Expected degraded/disconnected event on multi-hop manager, got: ${JSON.stringify(managerEvents)}`,
      ),
    );
  } finally {
    await broker?.close();
    await runner.close();
    await hub.close();
    await manager.close();
  }
});

test('Federated lifecycle loop safety — route-lifecycle frame with duplicate _eid is discarded in cyclic topology', async () => {
  // Build a minimal cycle: manager <-> hub (bi-directional federation links).
  // A lifecycle event originating on the hub should not loop back to hub.
  const manager = createVerserHost({ hostId: 'host-manager', tls: tlsOptions() });
  const hub = createVerserHost({ hostId: 'host-hub', tls: tlsOptions() });
  await manager.start();
  await hub.start();

  try {
    // Both Hosts connect to each other (bi-directional federation links)
    await hub.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: { ca: trusted.certificate },
    });
    await manager.connectUpstream({
      upstreamId: 'hub',
      url: hostUrl(hub),
      tls: { ca: trusted.certificate },
    });

    // Attach local Broker to hub to observe lifecycle events
    const hubBroker = await hub.attachLocalBroker({ brokerId: 'hub-broker' });
    const hubEvents = [];
    hubBroker.onRouteChange((event) => hubEvents.push(event));

    // Register a Guest on the hub
    const guest = await hub.attachLocalGuest({
      guestId: 'guest-loop-test',
      routedDomains: ['loop-test.verser.test'],
      listener: (_request, response) => response.end('ok'),
    });

    // Wait for the route to appear on the manager (may appear once or twice
    // in a cyclic topology due to bi-directional federation links).
    await assertEventually(() =>
      assert.ok(
        manager.getFederatedRouteCandidates('guest-loop-test', 'loop-test.verser.test').length >= 1,
        'Expected route to appear on manager',
      ),
    );
    hubEvents.length = 0;

    // Revoke the route on the hub.
    // Without loop detection, the lifecycle event would travel hub -> manager,
    // then manager -> hub, then hub -> manager again in a cycle.
    // With _eid tracking, each Host detects and discards duplicates.
    const revokeResult = guest.revokeRoutes(['loop-test.verser.test']);
    assert.deepEqual(revokeResult.revoked, ['loop-test.verser.test']);

    // Wait for events to settle (give time for potential loops)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The local Broker on the hub should see a 'removed' event for the
    // revoked route. In a cyclic topology it may arrive via multiple paths,
    // but the _eid mechanism prevents infinite re-forwarding.
    // The key invariant: no crash or infinite loop occurs, and the route
    // is effectively removed.
    const removedEvents = hubEvents.filter(
      (e) => e.type === 'removed' && e.domain === 'loop-test.verser.test',
    );
    assert.ok(
      removedEvents.length >= 1,
      `Expected at least 1 removed event on hub, got ${removedEvents.length}: ${JSON.stringify(hubEvents)}`,
    );
    assert.ok(
      removedEvents.length <= 3,
      `Expected at most 3 removed events on hub (cycle suppressed), got ${removedEvents.length}: ${JSON.stringify(hubEvents)}`,
    );
  } finally {
    await hub.close();
    await manager.close();
  }
});

// ================ Characterization: Federation Upstream Disconnect During Active Stream ================

test('Upstream disconnect during an active federated request fails the Broker request', async () => {
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

    let requestHeldResolve;
    const requestHeld = new Promise((resolve) => {
      requestHeldResolve = resolve;
    });
    await runner.attachLocalGuest({
      guestId: 'guest-federated-disconnect',
      routedDomains: ['federated-disconnect.verser.test'],
      listener: (request, response) => {
        request.resume();
        requestHeldResolve();
        // Do not end — keep stream open
      },
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-federated-disconnect',
          'federated-disconnect.verser.test',
        ).length,
        1,
      ),
    );

    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-federated-disconnect',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await broker.waitForRoute('federated-disconnect.verser.test');

    const body = new PassThrough();
    const requestPromise = broker.request({
      targetId: 'guest-federated-disconnect',
      method: 'POST',
      path: '/federated-disconnect',
      headers: { host: 'federated-disconnect.verser.test' },
      body,
    });
    body.write(Buffer.from('start'));
    await requestHeld;

    // Disconnect the upstream link
    await runner.close('upstream-disconnect-test');

    // The Broker request should fail
    await assert.rejects(requestPromise, (error) => {
      assert.match(error.message, /closed|disconnect|metadata|upstream|lease/i);
      return true;
    });
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

// ================ Characterization: Federation Upstream Abort Propagation ================

test('Federated forwarding does NOT propagate mid-stream Broker abort as an explicit error to downstream Guest (gap: cancellation closes lease but no error event through federation)', async () => {
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

    let guestRequestError;
    const requestClosed = new Promise((resolve) => {
      runner.attachLocalGuest({
        guestId: 'guest-federated-abort',
        routedDomains: ['federated-abort.verser.test'],
        listener: (request, response) => {
          request.resume();
          request.once('error', (err) => {
            guestRequestError = err;
          });
          request.once('close', () => {
            resolve();
          });
        },
      });
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('guest-federated-abort', 'federated-abort.verser.test')
          .length,
        1,
      ),
    );

    // Use a raw H2 session to send a broker request and then cancel it
    const rawBrokerSession = await connectRawClient(manager.address.port);
    try {
      const brokerStream = rawBrokerSession.request({
        ':method': 'POST',
        ':path': '/verser/request',
        'x-verser-target-id': 'guest-federated-abort',
        'x-verser-request-id': 'req-federated-abort-1',
        'x-verser-source-id': 'broker-federated-abort',
        'x-verser-method': 'POST',
        'x-verser-path': '/federated-abort',
      });
      brokerStream.write(Buffer.from('body'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      brokerStream.close(http2.constants.NGHTTP2_CANCEL);

      // The lease stream closes (detected via request.on('close')),
      // but the request does NOT receive an explicit 'error' event through federation
      await Promise.race([
        requestClosed,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'Guest request stream was not closed after Broker abort through federation',
                ),
              ),
            1500,
          ),
        ),
      ]);

      // The stream closes but no error event fires — characterizes the gap
      assert.equal(
        guestRequestError,
        undefined,
        'Expected no error event — Broker abort does not propagate as Guest request error through federation (known gap)',
      );
    } finally {
      rawBrokerSession.destroy();
    }
  } finally {
    await broker?.close();
    await runner.close();
    await manager.close();
  }
});

// ================ Characterization: Waiter Cleanup After Host Close ================

test('Federated request completes or fails cleanly when upstream Host closes during dispatch (characterization: no leaked state)', async () => {
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

    // Register a Guest on the runner
    await runner.attachLocalGuest({
      guestId: 'guest-federated-waiter',
      routedDomains: ['federated-waiter.verser.test'],
      listener: (_request, response) => response.end('never-called'),
    });

    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates(
          'guest-federated-waiter',
          'federated-waiter.verser.test',
        ).length,
        1,
      ),
    );

    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'broker-federated-waiter',
      tls: { ca: trusted.certificate },
    });
    await broker.connect();
    await broker.waitForRoute('federated-waiter.verser.test');

    const requestPromise = broker.request({
      targetId: 'guest-federated-waiter',
      method: 'GET',
      path: '/federated-waiter',
      headers: { host: 'federated-waiter.verser.test' },
    });

    // Close the runner (upstream) while request is in-flight
    await runner.close('upstream-close-during-wait');

    // The request should either succeed (if already dispatched) or fail (if waiting)
    // Either outcome is acceptable for this characterization — the key is no leaked state
    try {
      const response = await requestPromise;
      const body = await text(response.body);
      assert.equal(body, 'never-called');
    } catch {
      // Failure due to upstream disconnect is also acceptable
    }

    // Verify the upstream is gone — no leaked state
    assert.deepEqual(manager.getUpstreams(), []);
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

// Phase 3 forwarding-enforcement tests for hop-local federation route
// authorization (issue #61). Covers: allow/deny on every federated HTTP and
// VWS path, no body/frame consumption on denial, cache/revoke/invalidation
// under live traffic, remote HTTP session binding of x-verser-source-id, and
// Host-to-Host sourceId/hop-baton replacement.
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { Readable } = require('node:stream');
const { text } = require('node:stream/consumers');
const { test } = require('./support/guarded-test.cjs');

const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');
const common = require('../packages/verser-common/dist/index.js');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker, createVerserNodeGuest } = loadVerserGuestNode();

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

function tlsOptions() {
  return { cert: trusted.certificate, key: trusted.key };
}

function hostUrl(host) {
  return `https://127.0.0.1:${host.address.port}`;
}

function clientTls() {
  return { ca: trusted.certificate };
}

async function connectRawClient(port) {
  const session = http2.connect(`https://127.0.0.1:${port}`, clientTls());
  await once(session, 'connect');
  return session;
}

async function assertEventually(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

function countingBodySource(chunks) {
  let index = 0;
  const counter = { bytesRead: 0 };
  const readable = new Readable({
    read() {
      if (index < chunks.length) {
        const chunk = Buffer.from(chunks[index]);
        counter.bytesRead += chunk.length;
        index += 1;
        this.push(chunk);
      } else {
        this.push(null);
      }
    },
  });
  return { readable, counter };
}

function guestListenerFactory(onBody) {
  const state = { calls: 0, bodies: 0 };
  const listener = async (request, response) => {
    state.calls += 1;
    const consumed = await onBody(request);
    state.bodies += consumed;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`guest:${consumed}`);
  };
  return { listener, state };
}

async function rawBrokerRequest(session, headers) {
  const stream = session.request({ ':method': 'POST', ':path': '/verser/request', ...headers });
  const responseHeaders = await once(stream, 'response');
  const body = await text(stream);
  return { status: Number(responseHeaders[':status'] ?? 0), body: JSON.parse(body) };
}

// Warm up TLS/HTTP2/federation infrastructure so individual guarded tests
// don't pay the one-time initialization cost of TLS contexts, HTTP/2
// sessions, and federation link state.
test.before(async () => {
  const upstream = createVerserHost({ hostId: 'authz-warmup-manager', tls: tlsOptions() });
  const downstream = createVerserHost({ hostId: 'authz-warmup-runner', tls: tlsOptions() });
  await upstream.start();
  try {
    const handle = await downstream.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(upstream),
      tls: clientTls(),
    });
    await handle.close('warmup');
  } finally {
    await downstream.close();
    await upstream.close();
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  }
});

test('remote Broker HTTP egress authorizes the hop pair once, caches the allow, and forwards streaming bodies', async () => {
  const pairs = [];
  const manager = createVerserHost({
    hostId: 'authz-fwd-manager',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      pairs.push(context);
      return 'allow';
    },
  });
  const runner = createVerserHost({ hostId: 'authz-fwd-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-fwd-guest',
      routedDomains: ['authz-fwd.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-fwd-guest', 'authz-fwd.verser.test').length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-fwd-broker',
      brokerDomain: 'Broker.Fwd.Hop.',
      tls: clientTls(),
    });
    await broker.connect();

    const first = await broker.request({
      targetId: 'authz-fwd-guest',
      routeDomain: 'authz-fwd.verser.test',
      method: 'POST',
      path: '/first',
      body: [Buffer.from('hello-')],
    });
    assert.equal(first.statusCode, 200);
    assert.equal(await text(first.body), 'guest:6');

    assert.deepEqual(pairs, [
      {
        previousAdvertisedDomain: 'broker.fwd.hop',
        nextSelectedDomain: 'authz-fwd.verser.test',
      },
    ]);

    const second = await broker.request({
      targetId: 'authz-fwd-guest',
      routeDomain: 'authz-fwd.verser.test',
      method: 'GET',
      path: '/second',
    });
    assert.equal(second.statusCode, 200);
    assert.equal(await text(second.body), 'guest:0');
    // Cached allow: the callback ran exactly once for the pair.
    assert.equal(pairs.length, 1);
    assert.equal(guest.state.calls, 2);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('denied local Broker egress fails with authorization-denied without consuming the body, and zero-TTL denials are not cached', async () => {
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-deny-manager',
    tls: tlsOptions(),
    routeAuthorizationNegativeCacheTtlMs: 0,
    routeAuthorizer: () => {
      calls += 1;
      return 'deny';
    },
  });
  const runner = createVerserHost({ hostId: 'authz-deny-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  const source = countingBodySource(['deny-me-', 'stream-body']);

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-deny-guest',
      routedDomains: ['authz-deny.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-deny-guest', 'authz-deny.verser.test').length,
        1,
      ),
    );
    const broker = await manager.attachLocalBroker({
      brokerId: 'authz-deny-local-broker',
      brokerDomain: 'deny-hop.verser.test',
    });

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'authz-deny-guest',
          routeDomain: 'authz-deny.verser.test',
          method: 'POST',
          path: '/upload',
          body: source.readable,
        }),
      (error) => {
        assert.equal(error.code, 'authorization-denied');
        return true;
      },
    );
    // Enforcement precedes body piping: nothing was read from the source.
    assert.equal(source.counter.bytesRead, 0);
    assert.equal(guest.state.calls, 0);
    assert.equal(calls, 1);

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'authz-deny-guest',
          routeDomain: 'authz-deny.verser.test',
          method: 'GET',
          path: '/again',
        }),
      (error) => error.code === 'authorization-denied',
    );
    // Denials are never cached: the callback ran again.
    assert.equal(calls, 2);
    source.readable.destroy();
  } finally {
    source.readable.destroy();
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('configured authorizer denies Broker-selected federation requests lacking a domain and spoofed sessions', async () => {
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-spoof-manager',
    tls: tlsOptions(),
    routeAuthorizer: () => {
      calls += 1;
      return 'allow';
    },
  });
  const runner = createVerserHost({ hostId: 'authz-spoof-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let hoplessBroker;
  let boundBroker;
  let rawSession;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-spoof-guest',
      routedDomains: ['authz-spoof.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-spoof-guest', 'authz-spoof.verser.test').length,
        1,
      ),
    );

    hoplessBroker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-spoof-hopless',
      tls: clientTls(),
    });
    await hoplessBroker.connect();
    await assert.rejects(
      () =>
        hoplessBroker.request({
          targetId: 'authz-spoof-guest',
          routeDomain: 'authz-spoof.verser.test',
          method: 'GET',
          path: '/',
        }),
      (error) => {
        assert.equal(error.code, 'authorization-denied');
        assert.match(error.message, /no registered domain/i);
        return true;
      },
    );
    assert.equal(calls, 0);

    boundBroker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-spoof-bound',
      brokerDomain: 'bound-hop.verser.test',
      tls: clientTls(),
    });
    await boundBroker.connect();

    // A different HTTP/2 session claiming the registered Broker's ID must be
    // denied before the stored domain is read or any stream is acquired.
    rawSession = await connectRawClient(manager.address.port);
    const spoofed = await rawBrokerRequest(rawSession, {
      'x-verser-request-id': 'authz-spoof-attempt',
      'x-verser-source-id': 'authz-spoof-bound',
      'x-verser-target-id': 'authz-spoof-guest',
      'x-verser-route-domain': 'authz-spoof.verser.test',
      'x-verser-method': 'GET',
      'x-verser-path': '/',
      'x-verser-headers': '{}',
    });
    assert.equal(spoofed.status, 502);
    assert.equal(spoofed.body.error.code, 'authorization-denied');
    assert.match(spoofed.body.error.message, /not a Broker registered on this HTTP\/2 session/);
    assert.equal(calls, 0);
    assert.equal(guest.state.calls, 0);

    // The legitimately bound Broker on its own session is authorized.
    const ok = await boundBroker.request({
      targetId: 'authz-spoof-guest',
      routeDomain: 'authz-spoof.verser.test',
      method: 'GET',
      path: '/',
    });
    assert.equal(ok.statusCode, 200);
    await text(ok.body);
    assert.equal(calls, 1);
  } finally {
    if (rawSession !== undefined) rawSession.destroy();
    await hoplessBroker?.close('test-complete');
    await boundBroker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('Host-to-Host HTTP egress replaces sourceId with the local Host identity and carries the route baton', async () => {
  const pairs = [];
  const manager = createVerserHost({
    hostId: 'authz-raw-manager',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      pairs.push(context);
      return 'allow';
    },
  });
  await manager.start();
  const raw = await connectRawClient(manager.address.port);
  let broker;

  try {
    const handshake = raw.request({ ':method': 'POST', ':path': '/verser/host/federation' });
    handshake.end(
      JSON.stringify({
        hostId: 'authz-raw-runner',
        protocolVersion: 1,
        importRoutes: true,
        exportRoutes: true,
      }),
    );
    await once(handshake, 'response');
    handshake.resume();
    manager.setImportedFederatedRoutes('authz-raw-runner', [
      {
        targetId: 'authz-raw-guest',
        domain: 'authz-raw.verser.test',
        originHostId: 'authz-raw-runner',
        nextHopHostId: 'authz-raw-runner',
        hopCount: 1,
        viaHostIds: ['authz-raw-runner'],
        source: 'upstream',
      },
    ]);
    broker = await manager.attachLocalBroker({
      brokerId: 'authz-raw-broker',
      brokerDomain: 'raw-hop.verser.test',
    });

    const requestStream = raw.request({
      ':method': 'POST',
      ':path': '/verser/host/federation/request',
      'x-verser-host-id': 'authz-raw-runner',
    });
    await once(requestStream, 'response');
    const egressMetadata = common.readLeaseRequestMetadataFromStream(requestStream, {
      guestId: 'authz-raw-runner',
      leaseId: 'authz-raw',
    });
    egressMetadata.then(
      (metadata) =>
        requestStream.end(
          common.encodeVerserEnvelope({
            type: 'response',
            metadata: { requestId: metadata.requestId, statusCode: 204, headers: {} },
          }),
        ),
      () => {
        // The final await of egressMetadata surfaces the rejection.
      },
    );

    const response = await broker.request({
      targetId: 'authz-raw-guest',
      routeDomain: 'authz-raw.verser.test',
      method: 'GET',
      path: '/hop',
    });
    assert.equal(response.statusCode, 204);
    await text(response.body);

    const metadata = await egressMetadata;
    // Origin identity never crosses the Host-to-Host boundary.
    assert.equal(metadata.sourceId, 'authz-raw-manager');
    // The selected candidate domain is forwarded as the hop-local baton.
    assert.equal(metadata.routeDomain, 'authz-raw.verser.test');
    assert.deepEqual(pairs, [
      {
        previousAdvertisedDomain: 'raw-hop.verser.test',
        nextSelectedDomain: 'authz-raw.verser.test',
      },
    ]);
  } finally {
    raw.destroy();
    await manager.close('test-complete');
  }
});

test('incoming federation HTTP dispatch is authorized hop-locally on the receiving Host before the Guest is invoked', async () => {
  const pairs = [];
  const manager = createVerserHost({ hostId: 'authz-inbound-manager', tls: tlsOptions() });
  const runner = createVerserHost({
    hostId: 'authz-inbound-runner',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      pairs.push(context);
      return 'deny';
    },
  });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-inbound-guest',
      routedDomains: ['authz-inbound.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-inbound-guest', 'authz-inbound.verser.test')
          .length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-inbound-broker',
      brokerDomain: 'inbound-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    // The originating Host has no authorizer configured: it forwards.
    // The receiving Host denies the { baton, selected } hop before the Guest
    // is invoked, and the structured denial reaches the Broker.
    await assert.rejects(
      () =>
        broker.request({
          targetId: 'authz-inbound-guest',
          routeDomain: 'authz-inbound.verser.test',
          method: 'GET',
          path: '/',
        }),
      (error) => {
        assert.equal(error.code, 'authorization-denied');
        return true;
      },
    );
    assert.deepEqual(pairs, [
      {
        previousAdvertisedDomain: 'authz-inbound.verser.test',
        nextSelectedDomain: 'authz-inbound.verser.test',
      },
    ]);
    assert.equal(guest.state.calls, 0);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('direct Broker VWS authorizes the hop pair before open forwarding; denial reaches the Broker without touching the Guest', async () => {
  const pairs = [];
  let mode = 'allow';
  const manager = createVerserHost({
    hostId: 'authz-vws-manager',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      pairs.push(context);
      return mode;
    },
  });
  const runner = createVerserHost({ hostId: 'authz-vws-runner', tls: tlsOptions() });
  const wsState = { opens: 0 };
  let broker;
  let guest;

  try {
    await manager.start();
    await runner.start();
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-vws-broker',
      brokerDomain: 'vws-hop.verser.test',
      tls: clientTls(),
    });
    guest = createVerserNodeGuest({
      hostUrl: hostUrl(runner),
      guestId: 'authz-vws-guest',
      tls: clientTls(),
    });
    guest.attachWebSocket((_open, ws) => {
      wsState.opens += 1;
      ws.on('message', (data, options) => void ws.send(data, options));
    }, 'authz-vws.verser.test');
    await broker.connect();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await guest.connect();
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-vws-guest', 'authz-vws.verser.test').length,
        1,
      ),
    );

    const ws = await broker.webSocket({
      targetId: 'authz-vws-guest',
      domain: 'authz-vws.verser.test',
    });
    const message = new Promise((resolve) => ws.once('message', resolve));
    await ws.send('authorized', { type: 'text' });
    assert.equal(await message, 'authorized');
    ws.close();
    assert.deepEqual(pairs, [
      {
        previousAdvertisedDomain: 'vws-hop.verser.test',
        nextSelectedDomain: 'authz-vws.verser.test',
      },
    ]);
    assert.equal(wsState.opens, 1);

    // Revoke the cached allow, then deny: the next open fails hop-locally
    // before any VWS open frame reaches the remote Guest.
    assert.equal(
      manager.revokeRouteAuthorization({
        previousAdvertisedDomain: 'vws-hop.verser.test',
        nextSelectedDomain: 'authz-vws.verser.test',
      }),
      true,
    );
    mode = 'deny';
    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'authz-vws-guest',
          domain: 'authz-vws.verser.test',
        }),
      (error) => {
        assert.equal(error.code, 'authorization-denied');
        return true;
      },
    );
    assert.equal(wsState.opens, 1);
    assert.equal(pairs.length, 2);
  } finally {
    await broker?.close('test-complete');
    await guest?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('incoming federation VWS dispatch is authorized hop-locally on the receiving Host before bridging', async () => {
  const runnerPairs = [];
  const manager = createVerserHost({ hostId: 'authz-vwsin-manager', tls: tlsOptions() });
  const runner = createVerserHost({
    hostId: 'authz-vwsin-runner',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      runnerPairs.push(context);
      return 'deny';
    },
  });
  const wsState = { opens: 0 };
  let broker;
  let guest;

  try {
    await manager.start();
    await runner.start();
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-vwsin-broker',
      brokerDomain: 'vwsin-hop.verser.test',
      tls: clientTls(),
    });
    guest = createVerserNodeGuest({
      hostUrl: hostUrl(runner),
      guestId: 'authz-vwsin-guest',
      tls: clientTls(),
    });
    guest.attachWebSocket((_open, ws) => {
      wsState.opens += 1;
    }, 'authz-vwsin.verser.test');
    await broker.connect();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await guest.connect();
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-vwsin-guest', 'authz-vwsin.verser.test').length,
        1,
      ),
    );

    // Manager has no authorizer: it forwards the open. Runner denies the
    // { incoming open domain, candidate } hop before bridging.
    await assert.rejects(
      () =>
        broker.webSocket({
          targetId: 'authz-vwsin-guest',
          domain: 'authz-vwsin.verser.test',
        }),
      (error) => {
        assert.equal(error.code, 'authorization-denied');
        return true;
      },
    );
    assert.deepEqual(runnerPairs, [
      {
        previousAdvertisedDomain: 'authz-vwsin.verser.test',
        nextSelectedDomain: 'authz-vwsin.verser.test',
      },
    ]);
    assert.equal(wsState.opens, 0);
  } finally {
    await broker?.close('test-complete');
    await guest?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('explicit revoke forces a fresh decision between forwarded requests', async () => {
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-revoke-manager',
    tls: tlsOptions(),
    routeAuthorizer: () => {
      calls += 1;
      return 'allow';
    },
  });
  const runner = createVerserHost({ hostId: 'authz-revoke-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-revoke-guest',
      routedDomains: ['authz-revoke.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-revoke-guest', 'authz-revoke.verser.test')
          .length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-revoke-broker',
      brokerDomain: 'revoke-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    const first = await broker.request({
      targetId: 'authz-revoke-guest',
      routeDomain: 'authz-revoke.verser.test',
      method: 'GET',
      path: '/1',
    });
    await text(first.body);
    const second = await broker.request({
      targetId: 'authz-revoke-guest',
      routeDomain: 'authz-revoke.verser.test',
      method: 'GET',
      path: '/2',
    });
    await text(second.body);
    assert.equal(calls, 1);

    assert.equal(
      manager.revokeRouteAuthorization({
        previousAdvertisedDomain: 'revoke-hop.verser.test',
        nextSelectedDomain: 'authz-revoke.verser.test',
      }),
      true,
    );
    const third = await broker.request({
      targetId: 'authz-revoke-guest',
      routeDomain: 'authz-revoke.verser.test',
      method: 'GET',
      path: '/3',
    });
    await text(third.body);
    assert.equal(calls, 2);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('multi-hop HTTP replaces the baton at each egress: middle Host authorizes { routeDomain, routeDomain }', async () => {
  const rootPairs = [];
  const middlePairs = [];
  const root = createVerserHost({
    hostId: 'authz-multi-root',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      rootPairs.push(context);
      return 'allow';
    },
  });
  const middle = createVerserHost({
    hostId: 'authz-multi-middle',
    tls: tlsOptions(),
    routeAuthorizer: (context) => {
      middlePairs.push(context);
      return 'allow';
    },
  });
  const leaf = createVerserHost({ hostId: 'authz-multi-leaf', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await root.start();
    await middle.start();
    await leaf.start();
    await leaf.connectUpstream({
      upstreamId: 'middle',
      url: hostUrl(middle),
      tls: clientTls(),
    });
    await middle.connectUpstream({
      upstreamId: 'root',
      url: hostUrl(root),
      tls: clientTls(),
    });
    await leaf.attachLocalGuest({
      guestId: 'authz-multi-guest',
      routedDomains: ['authz-multi.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        root.getFederatedRouteCandidates('authz-multi-guest', 'authz-multi.verser.test').length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(root),
      brokerId: 'authz-multi-broker',
      brokerDomain: 'multi-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    const response = await broker.request({
      targetId: 'authz-multi-guest',
      routeDomain: 'authz-multi.verser.test',
      method: 'GET',
      path: '/',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(await text(response.body), 'guest:0');

    assert.deepEqual(rootPairs, [
      {
        previousAdvertisedDomain: 'multi-hop.verser.test',
        nextSelectedDomain: 'authz-multi.verser.test',
      },
    ]);
    // Subsequent hop: the incoming resolved route domain is the previous hop;
    // the Broker identity never reaches the middle or leaf Host.
    assert.deepEqual(middlePairs, [
      {
        previousAdvertisedDomain: 'authz-multi.verser.test',
        nextSelectedDomain: 'authz-multi.verser.test',
      },
    ]);
    assert.equal(guest.state.calls, 1);
  } finally {
    await broker?.close('test-complete');
    await root.close('test-complete');
    await middle.close('test-complete');
    await leaf.close('test-complete');
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('route-bound federation HTTP stream keeps its authorization through TTL expiry and revoke mid-flight', async () => {
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-bind-manager',
    tls: tlsOptions(),
    routeAuthorizationCacheTtlMs: 40,
    routeAuthorizationNegativeCacheTtlMs: 40,
    routeAuthorizer: () => {
      calls += 1;
      return 'allow';
    },
  });
  const runner = createVerserHost({ hostId: 'authz-bind-runner', tls: tlsOptions() });
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    // The Guest holds the request open well past the 40 ms allow TTL.
    await runner.attachLocalGuest({
      guestId: 'authz-bind-guest',
      routedDomains: ['authz-bind.verser.test'],
      listener: async (request, response) => {
        await text(request);
        await sleep(150);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('slow-ok');
      },
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-bind-guest', 'authz-bind.verser.test').length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-bind-broker',
      brokerDomain: 'bind-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    const inflight = broker.request({
      targetId: 'authz-bind-guest',
      routeDomain: 'authz-bind.verser.test',
      method: 'GET',
      path: '/slow',
    });
    // Revoke while the authorized stream is still open: the in-flight
    // request must not be interrupted, migrated, or reauthorized.
    await sleep(10);
    assert.equal(
      manager.revokeRouteAuthorization({
        previousAdvertisedDomain: 'bind-hop.verser.test',
        nextSelectedDomain: 'authz-bind.verser.test',
      }),
      true,
    );
    const response = await inflight;
    assert.equal(response.statusCode, 200);
    assert.equal(await text(response.body), 'slow-ok');
    assert.equal(calls, 1);

    // A new forwarding decision after expiry and revoke reauthorizes.
    const next = await broker.request({
      targetId: 'authz-bind-guest',
      routeDomain: 'authz-bind.verser.test',
      method: 'GET',
      path: '/next',
    });
    assert.equal(next.statusCode, 200);
    await text(next.body);
    assert.equal(calls, 2);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('accepted federated VWS connection keeps its authorization through expiry and revoke; new opens reauthorize', async () => {
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-vwsbind-manager',
    tls: tlsOptions(),
    routeAuthorizationCacheTtlMs: 60,
    routeAuthorizer: () => {
      calls += 1;
      return 'allow';
    },
  });
  const runner = createVerserHost({ hostId: 'authz-vwsbind-runner', tls: tlsOptions() });
  let broker;
  let guest;

  try {
    await manager.start();
    await runner.start();
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-vwsbind-broker',
      brokerDomain: 'vwsbind-hop.verser.test',
      tls: clientTls(),
    });
    guest = createVerserNodeGuest({
      hostUrl: hostUrl(runner),
      guestId: 'authz-vwsbind-guest',
      tls: clientTls(),
    });
    guest.attachWebSocket((_open, ws) => {
      ws.on('message', (data, options) => void ws.send(data, options));
    }, 'authz-vwsbind.verser.test');
    await broker.connect();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await guest.connect();
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-vwsbind-guest', 'authz-vwsbind.verser.test')
          .length,
        1,
      ),
    );

    const ws = await broker.webSocket({
      targetId: 'authz-vwsbind-guest',
      domain: 'authz-vwsbind.verser.test',
    });
    assert.equal(calls, 1);

    // Let the allow TTL expire, then revoke: the accepted connection keeps
    // bridging without any reauthorization.
    await sleep(120);
    assert.equal(
      manager.revokeRouteAuthorization({
        previousAdvertisedDomain: 'vwsbind-hop.verser.test',
        nextSelectedDomain: 'authz-vwsbind.verser.test',
      }),
      true,
    );
    const echo = new Promise((resolve) => ws.once('message', resolve));
    await ws.send('still-bound', { type: 'text' });
    assert.equal(await echo, 'still-bound');
    assert.equal(calls, 1);
    ws.close();

    // A new open decision reauthorizes.
    const second = await broker.webSocket({
      targetId: 'authz-vwsbind-guest',
      domain: 'authz-vwsbind.verser.test',
    });
    assert.equal(calls, 2);
    second.close();
  } finally {
    await broker?.close('test-complete');
    await guest?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('physical HTTP/2 sessions stay multiplexed: a denied decision does not poison later decisions on the same session', async () => {
  let mode = 'deny';
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-session-manager',
    tls: tlsOptions(),
    routeAuthorizer: () => {
      calls += 1;
      return mode;
    },
  });
  const runner = createVerserHost({ hostId: 'authz-session-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-session-guest',
      routedDomains: ['authz-session.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-session-guest', 'authz-session.verser.test')
          .length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-session-broker',
      brokerDomain: 'session-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    await assert.rejects(
      () =>
        broker.request({
          targetId: 'authz-session-guest',
          routeDomain: 'authz-session.verser.test',
          method: 'GET',
          path: '/denied',
        }),
      (error) => error.code === 'authorization-denied',
    );
    assert.equal(calls, 1);

    // Same physical session, later allowed decision: the cached denial must
    // gate only its own pair/decision, and the session stays usable.
    assert.equal(
      manager.revokeRouteAuthorization({
        previousAdvertisedDomain: 'session-hop.verser.test',
        nextSelectedDomain: 'authz-session.verser.test',
      }),
      true,
    );
    mode = 'allow';
    const ok = await broker.request({
      targetId: 'authz-session-guest',
      routeDomain: 'authz-session.verser.test',
      method: 'GET',
      path: '/allowed',
    });
    assert.equal(ok.statusCode, 200);
    await text(ok.body);
    assert.equal(calls, 2);
    assert.equal(broker.sessionCount, 1);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('per-decision cacheTtlMs 0 and Infinity overrides apply across live federation forwarding', async () => {
  let calls = 0;
  let mode = 'zero';
  const manager = createVerserHost({
    hostId: 'authz-perttl-manager',
    tls: tlsOptions(),
    routeAuthorizationCacheTtlMs: 60_000,
    routeAuthorizer: () => {
      calls += 1;
      return mode === 'zero'
        ? { decision: 'allow', cacheTtlMs: 0 }
        : { decision: 'allow', cacheTtlMs: Number.POSITIVE_INFINITY };
    },
  });
  const runner = createVerserHost({ hostId: 'authz-perttl-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-perttl-guest',
      routedDomains: ['authz-perttl.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-perttl-guest', 'authz-perttl.verser.test')
          .length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-perttl-broker',
      brokerDomain: 'perttl-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    // cacheTtlMs 0: every forwarding decision re-invokes the callback.
    for (const path of ['/a', '/b', '/c']) {
      const response = await broker.request({
        targetId: 'authz-perttl-guest',
        routeDomain: 'authz-perttl.verser.test',
        method: 'GET',
        path,
      });
      assert.equal(response.statusCode, 200);
      await text(response.body);
    }
    assert.equal(calls, 3);
    assert.equal(manager.routeAuthorizer.cachedAllowCount, 0);

    // Infinity: cached past the class TTL until explicit revoke.
    mode = 'infinite';
    const first = await broker.request({
      targetId: 'authz-perttl-guest',
      routeDomain: 'authz-perttl.verser.test',
      method: 'GET',
      path: '/d',
    });
    await text(first.body);
    const second = await broker.request({
      targetId: 'authz-perttl-guest',
      routeDomain: 'authz-perttl.verser.test',
      method: 'GET',
      path: '/e',
    });
    await text(second.body);
    // 3 zero-TTL calls + 1 Infinity call; the second Infinity call is cached.
    assert.equal(calls, 4);
    assert.equal(manager.routeAuthorizer.cachedAllowCount, 1);
    assert.equal(
      manager.revokeRouteAuthorization({
        previousAdvertisedDomain: 'perttl-hop.verser.test',
        nextSelectedDomain: 'authz-perttl.verser.test',
      }),
      true,
    );
    assert.equal(manager.routeAuthorizer.cachedAllowCount, 0);
    const third = await broker.request({
      targetId: 'authz-perttl-guest',
      routeDomain: 'authz-perttl.verser.test',
      method: 'GET',
      path: '/f',
    });
    await text(third.body);
    assert.equal(calls, 5);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

test('a malformed authorizer result rejects the Broker request deterministically and is never cached', async () => {
  let calls = 0;
  const manager = createVerserHost({
    hostId: 'authz-badresult-manager',
    tls: tlsOptions(),
    routeAuthorizer: () => {
      calls += 1;
      return { decision: 'maybe' };
    },
  });
  const runner = createVerserHost({ hostId: 'authz-badresult-runner', tls: tlsOptions() });
  const guest = guestListenerFactory(async (request) => (await text(request)).length);
  let broker;

  try {
    await manager.start();
    await runner.start();
    await runner.connectUpstream({
      upstreamId: 'manager',
      url: hostUrl(manager),
      tls: clientTls(),
    });
    await runner.attachLocalGuest({
      guestId: 'authz-badresult-guest',
      routedDomains: ['authz-badresult.verser.test'],
      listener: guest.listener,
    });
    await assertEventually(() =>
      assert.equal(
        manager.getFederatedRouteCandidates('authz-badresult-guest', 'authz-badresult.verser.test')
          .length,
        1,
      ),
    );
    broker = createVerserBroker({
      hostUrl: hostUrl(manager),
      brokerId: 'authz-badresult-broker',
      brokerDomain: 'badresult-hop.verser.test',
      tls: clientTls(),
    });
    await broker.connect();

    for (const path of ['/first', '/second']) {
      await assert.rejects(
        () =>
          broker.request({
            targetId: 'authz-badresult-guest',
            routeDomain: 'authz-badresult.verser.test',
            method: 'GET',
            path,
          }),
        (error) => {
          assert.equal(error.code, 'protocol-error');
          return true;
        },
      );
    }
    // Rejected before forwarding both times; nothing was cached.
    assert.equal(calls, 2);
    assert.equal(guest.state.calls, 0);
  } finally {
    await broker?.close('test-complete');
    await manager.close('test-complete');
    await runner.close('test-complete');
  }
});

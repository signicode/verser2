const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadVerserHost } = require('./support/verser-package-imports.cjs');

const { createVerserHost } = loadVerserHost();

function importedRoute(overrides = {}) {
  return {
    targetId: 'guest-alpha',
    domain: 'alpha.verser.test',
    originHostId: 'host-runner',
    nextHopHostId: 'host-hub',
    hopCount: 1,
    viaHostIds: ['host-runner'],
    source: 'upstream',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('Host without routeAuthorizer preserves existing behavior and revokes nothing', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });

  assert.equal(host.routeAuthorizer, undefined);
  assert.equal(
    host.revokeRouteAuthorization({
      previousAdvertisedDomain: 'broker.verser.test',
      nextSelectedDomain: 'alpha.verser.test',
    }),
    false,
  );
  assert.equal(
    await host.authorizeFederatedHopPair('broker.verser.test', 'alpha.verser.test'),
    true,
  );

  await host.close();
});

test('route authorizer caches allowed pairs, never caches denials, and receives normalized context', async () => {
  const calls = [];
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: (context) => {
      calls.push(context);
      return calls.length === 1 ? 'allow' : 'deny';
    },
  });

  assert.equal(
    await host.authorizeFederatedHopPair(' Broker.Hop.Example. ', ' ALPHA.verser.test '),
    true,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    previousAdvertisedDomain: 'broker.hop.example',
    nextSelectedDomain: 'alpha.verser.test',
  });

  // Cached allow: no second callback invocation.
  assert.equal(
    await host.authorizeFederatedHopPair('broker.hop.example', 'alpha.verser.test'),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);

  // Denial: resolves false and is not cached, so the callback runs again.
  assert.equal(await host.authorizeFederatedHopPair('other.hop', 'alpha.verser.test'), false);
  assert.equal(await host.authorizeFederatedHopPair('other.hop', 'alpha.verser.test'), false);
  assert.equal(calls.length, 3);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);

  await host.close();
});

test('route authorizer shares one in-flight decision per pair (single-flight)', async () => {
  const gate = deferred();
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      return gate.promise;
    },
  });

  const first = host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test');
  const second = host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test');
  assert.equal(host.routeAuthorizer.pendingDecisionCount, 1);
  gate.resolve('allow');

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls, 1);
  assert.equal(host.routeAuthorizer.pendingDecisionCount, 0);

  await host.close();
});

test('explicit revoke clears a cached allow and abandons a pending decision', async () => {
  const gate = deferred();
  let mode = 'allow';
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      if (mode === 'gate') {
        return gate.promise;
      }
      return mode;
    },
  });

  assert.equal(await host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'), true);
  assert.equal(
    host.revokeRouteAuthorization({
      previousAdvertisedDomain: 'BROKER.hop',
      nextSelectedDomain: 'alpha.verser.test',
    }),
    true,
  );
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);
  assert.equal(
    host.revokeRouteAuthorization({
      previousAdvertisedDomain: 'never.hop',
      nextSelectedDomain: 'alpha.verser.test',
    }),
    false,
  );

  // A decision allowed while pending must not resurrect a revoked pair.
  mode = 'gate';
  const pending = host.authorizeFederatedHopPair('revoked.hop', 'alpha.verser.test');
  assert.equal(
    host.revokeRouteAuthorization({
      previousAdvertisedDomain: 'revoked.hop',
      nextSelectedDomain: 'alpha.verser.test',
    }),
    true,
  );
  gate.resolve('allow');
  assert.equal(await pending, false);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);
  assert.equal(host.routeAuthorizer.pendingDecisionCount, 0);

  await host.close();
});

test('route mutations invalidate cached allows with generation-safe pending handling', async () => {
  const gate = deferred();
  let mode = 'allow';
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      if (mode === 'gate') {
        return gate.promise;
      }
      return mode;
    },
  });

  assert.equal(await host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'), true);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);

  // Imported snapshot replacement invalidates the cache.
  host.setImportedFederatedRoutes('upstream-manager', [importedRoute()]);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  // Re-cache, then an identical (unchanged) snapshot must not invalidate.
  assert.equal(await host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'), true);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);
  host.setImportedFederatedRoutes('upstream-manager', [importedRoute()]);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);

  // Imported route removal (federation-link removal) invalidates.
  host.removeImportedFederatedRoutes('upstream-manager');
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  // A pending allow interrupted by a route change must not be cached, and
  // the generation bump clears the whole allow cache (conservative).
  assert.equal(await host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'), true);
  mode = 'gate';
  const pending = host.authorizeFederatedHopPair('late.hop', 'alpha.verser.test');
  host.removeImportedFederatedRoutes('other-upstream');
  gate.resolve('allow');
  assert.equal(await pending, false);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  // Local Guest attachment (local route change) invalidates.
  const guest = await host.attachLocalGuest({
    guestId: 'guest-alpha',
    routedDomains: ['alpha.verser.test'],
    listener: (_request, response) => response.end('ok'),
  });
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  // Local Guest route revocation invalidates.
  assert.equal(await host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'), true);
  guest.revokeRoutes(['alpha.verser.test']);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  await guest.close();
  await host.close();
});

test('Host shutdown invalidates every cached allow', async () => {
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => 'allow',
  });

  assert.equal(await host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'), true);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);

  await host.close();
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);
});

test('route authorizer callback rejection propagates without caching', async () => {
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      return Promise.reject(new Error('authorizer unavailable'));
    },
  });

  await assert.rejects(
    () => host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'),
    /authorizer unavailable/,
  );
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);
  assert.equal(host.routeAuthorizer.pendingDecisionCount, 0);

  // A later retry runs the callback again (no poisoned cache).
  await assert.rejects(
    () => host.authorizeFederatedHopPair('broker.hop', 'alpha.verser.test'),
    /authorizer unavailable/,
  );
  assert.equal(calls, 2);

  await host.close();
});

test('registered Broker hop-domain persists for remote and local Brokers and is omitted by default', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });

  const plainBroker = await host.attachLocalBroker({ brokerId: 'broker-plain' });
  assert.equal(host.getRegisteredBrokerHopDomain('broker-plain'), undefined);

  const hopBroker = await host.attachLocalBroker({
    brokerId: 'broker-hop',
    brokerHopDomain: ' Broker.Hop.Example. ',
  });
  // Local Brokers persist the normalized value and are exempt from certificate matching.
  assert.equal(host.getRegisteredBrokerHopDomain('broker-hop'), 'broker.hop.example');

  await assert.rejects(
    () => host.attachLocalBroker({ brokerId: 'broker-empty', brokerHopDomain: '   ' }),
    /brokerHopDomain must be a non-empty domain/,
  );
  assert.equal(host.getRegisteredBrokerHopDomain('guest-unknown'), undefined);

  await hopBroker.close();
  await plainBroker.close();
  await host.close();
});

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

test('Host route registry keeps local routes available without upstreams', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });
  const guest = await host.attachLocalGuest({
    guestId: 'guest-alpha',
    routedDomains: ['alpha.verser.test'],
    listener: (_request, response) => response.end('ok'),
  });
  const broker = await host.attachLocalBroker({ brokerId: 'broker-alpha' });

  assert.deepEqual(host.getRoutedDomains(), [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);
  assert.deepEqual(broker.getRoutes(), [{ targetId: 'guest-alpha', domain: 'alpha.verser.test' }]);

  await guest.close();
  await broker.close();
  await host.close();
});

test('Host route registry prefers local candidates and reveals imported routes after local withdrawal', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });
  host.setImportedFederatedRoutes('upstream-manager', [importedRoute({ source: 'local' })]);

  assert.deepEqual(host.getRoutedDomains(), [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);
  assert.deepEqual(
    host
      .getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test')
      .map((candidate) => candidate.source),
    ['upstream'],
  );

  const guest = await host.attachLocalGuest({
    guestId: 'guest-alpha',
    routedDomains: ['alpha.verser.test'],
    listener: (_request, response) => response.end('ok'),
  });

  assert.deepEqual(
    host
      .getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test')
      .map((candidate) => candidate.source),
    ['local', 'upstream'],
  );
  assert.deepEqual(host.getRoutedDomains(), [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  await guest.close();
  assert.deepEqual(
    host
      .getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test')
      .map((candidate) => candidate.source),
    ['upstream'],
  );
  assert.deepEqual(host.getRoutedDomains(), [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);
  await host.close();
});

test('Host route registry withdraws imported routes per upstream', () => {
  const host = createVerserHost({ hostId: 'host-hub' });

  host.setImportedFederatedRoutes('upstream-a', [importedRoute()]);
  host.setImportedFederatedRoutes('upstream-b', [
    importedRoute({
      nextHopHostId: 'host-sidecar',
      hopCount: 2,
      viaHostIds: ['host-runner', 'host-sidecar'],
    }),
  ]);

  assert.equal(host.getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test').length, 2);
  host.removeImportedFederatedRoutes('upstream-a');
  assert.equal(host.getFederatedRouteCandidates('guest-alpha', 'alpha.verser.test').length, 1);
  host.removeImportedFederatedRoutes('upstream-b');
  assert.deepEqual(host.getRoutedDomains(), []);
});

test('Host route registry advertises imported routes to Brokers after forwarding exists', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });
  host.setImportedFederatedRoutes('upstream-manager', [importedRoute()]);
  const broker = await host.attachLocalBroker({ brokerId: 'broker-alpha' });

  assert.deepEqual(host.getRoutedDomains(), [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);
  assert.deepEqual(broker.getRoutes(), [{ targetId: 'guest-alpha', domain: 'alpha.verser.test' }]);

  await broker.close();
  await host.close();
});

test('Host route registry suppresses looped and over-hop imported routes', () => {
  const host = createVerserHost({ hostId: 'host-hub', maxFederationHopCount: 2 });
  const rejected = host.setImportedFederatedRoutes('upstream-manager', [
    importedRoute({ viaHostIds: ['host-runner', 'host-hub'] }),
    importedRoute({
      nextHopHostId: 'host-sidecar',
      hopCount: 3,
      viaHostIds: ['host-runner', 'host-sidecar'],
    }),
  ]);

  assert.equal(rejected.length, 2);
  assert.deepEqual(
    rejected.map((error) => error.code),
    ['route-loop', 'route-loop'],
  );
  assert.deepEqual(host.getRoutedDomains(), []);
});

test('Host route registry revokes subset of routes without removing unrelated routes', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
    { targetId: 'guest-alpha', domain: 'beta.verser.test' },
    { targetId: 'guest-alpha', domain: 'gamma.verser.test' },
  ]);

  const result = registry.revokeRoutes('guest-alpha', ['alpha.verser.test', 'gamma.verser.test']);

  assert.deepEqual([...result.revoked].sort(), ['alpha.verser.test', 'gamma.verser.test']);
  assert.deepEqual(result.notFound, []);

  const routes = registry.getBrokerRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].domain, 'beta.verser.test');
  assert.equal(routes[0].targetId, 'guest-alpha');
});

test('Host route registry revoke of non-existent peer returns notFound', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  const result = registry.revokeRoutes('guest-alpha', ['alpha.verser.test']);
  assert.deepEqual(result.revoked, []);
  assert.deepEqual(result.notFound, ['alpha.verser.test']);
});

test('Host route registry revoke of non-existent domain returns notFound', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  const result = registry.revokeRoutes('guest-alpha', ['alpha.verser.test', 'missing.verser.test']);
  assert.deepEqual(result.revoked, ['alpha.verser.test']);
  assert.deepEqual(result.notFound, ['missing.verser.test']);

  const routes = registry.getBrokerRoutes();
  assert.equal(routes.length, 0);
});

test('Host route registry route degraded state removes routes from active candidates', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
    { targetId: 'guest-alpha', domain: 'beta.verser.test' },
  ]);

  assert.equal(registry.getBrokerRoutes().length, 2);
  assert.equal(registry.getCandidates('guest-alpha').length, 2);

  registry.setDegraded('guest-alpha');

  // Routes should be removed from active candidates
  assert.equal(registry.getCandidates('guest-alpha').length, 0);

  // Routes should remain visible in broker snapshot as degraded
  assert.equal(registry.getBrokerRoutes().length, 2);

  // Degraded routes should be tracked
  assert.equal(registry.hasDegradedRoutes('guest-alpha'), true);
});

test('Host route registry restores degraded routes with new generation metadata', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  const genBefore = registry.currentGeneration;

  registry.setDegraded('guest-alpha');

  assert.equal(registry.hasDegradedRoutes('guest-alpha'), true);
  assert.equal(registry.getCandidates('guest-alpha').length, 0);

  const restored = registry.restoreRoutes('guest-alpha');

  assert.equal(restored, true);
  assert.equal(registry.hasDegradedRoutes('guest-alpha'), false);

  // Routes should be back in active candidates
  assert.equal(registry.getCandidates('guest-alpha').length, 1);
  assert.equal(registry.getBrokerRoutes().length, 1);

  // Generation should have incremented
  assert.ok(registry.currentGeneration > genBefore);
});

test('Host route registry restore of non-degraded peer returns false', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  assert.equal(registry.restoreRoutes('guest-alpha'), false);
});

test('Host route registry sets degraded state only once per peer', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  registry.setDegraded('guest-alpha');
  const genAfterFirstDegrade = registry.currentGeneration;

  // Second degrade should be a no-op
  registry.setDegraded('guest-alpha');
  assert.equal(registry.currentGeneration, genAfterFirstDegrade);
  assert.equal(registry.hasDegradedRoutes('guest-alpha'), true);
});

test('Host route registry removes expired degraded routes after timeout', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  registry.setDegraded('guest-alpha');
  assert.equal(registry.hasDegradedRoutes('guest-alpha'), true);

  // Should not expire before timeout
  const earlyResult = registry.removeExpiredDegradedRoutes(Date.now(), 10000);
  assert.deepEqual(earlyResult, { expiredPeers: [], expiredRoutes: 0, expiredRouteEntries: [] });
  assert.equal(registry.hasDegradedRoutes('guest-alpha'), true);

  // Should expire after timeout
  const lateResult = registry.removeExpiredDegradedRoutes(Date.now() + 10001, 10000);
  assert.deepEqual(lateResult, {
    expiredPeers: ['guest-alpha'],
    expiredRoutes: 1,
    expiredRouteEntries: [{ peerId: 'guest-alpha', domain: 'alpha.verser.test' }],
  });
  assert.equal(registry.hasDegradedRoutes('guest-alpha'), false);
});

test('Host route registry preserves route snapshot compatibility after revocation', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
    { targetId: 'guest-alpha', domain: 'beta.verser.test' },
  ]);

  // Full route snapshot compatible with RoutedDomainRegistration
  assert.deepEqual(registry.getBrokerRoutes(), [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
    { targetId: 'guest-alpha', domain: 'beta.verser.test' },
  ]);

  registry.revokeRoutes('guest-alpha', ['alpha.verser.test']);

  // Snapshot still valid after revocation
  assert.deepEqual(registry.getBrokerRoutes(), [
    { targetId: 'guest-alpha', domain: 'beta.verser.test' },
  ]);
});

test('Host route registry removeImportedRoute removes specific imported route from upstream set', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setImportedRoutes('upstream-a', [
    importedRoute({ targetId: 'guest-alpha', domain: 'alpha.verser.test' }),
    importedRoute({ targetId: 'guest-alpha', domain: 'beta.verser.test' }),
  ]);

  assert.equal(registry.getCandidates('guest-alpha').length, 2);

  // Remove one specific route
  const removed = registry.removeImportedRoute('upstream-a', 'guest-alpha', 'beta.verser.test');
  assert.equal(removed, true);

  const remaining = registry.getCandidates('guest-alpha');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].domain, 'alpha.verser.test');

  // Remove the last route
  const removedLast = registry.removeImportedRoute(
    'upstream-a',
    'guest-alpha',
    'alpha.verser.test',
  );
  assert.equal(removedLast, true);
  assert.equal(registry.getCandidates('guest-alpha').length, 0);
});

test('Host route registry removeImportedRoute returns false for non-existent route', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setImportedRoutes('upstream-a', [
    importedRoute({ targetId: 'guest-alpha', domain: 'alpha.verser.test' }),
  ]);

  // Non-existent domain
  assert.equal(
    registry.removeImportedRoute('upstream-a', 'guest-alpha', 'missing.verser.test'),
    false,
  );

  // Non-existent upstream
  assert.equal(
    registry.removeImportedRoute('unknown-upstream', 'guest-alpha', 'alpha.verser.test'),
    false,
  );

  // Non-existent targetId
  assert.equal(
    registry.removeImportedRoute('upstream-a', 'guest-unknown', 'alpha.verser.test'),
    false,
  );
});

test('Host route registry getRouteGeneration returns generation for degraded routes', () => {
  const { createHostRouteRegistry } = loadVerserHost();
  const registry = createHostRouteRegistry({ hostId: 'host-hub' });

  registry.setLocalRoutes('guest-alpha', [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
    { targetId: 'guest-alpha', domain: 'beta.verser.test' },
  ]);

  // No generation for active routes
  assert.equal(registry.getRouteGeneration('guest-alpha', 'alpha.verser.test'), undefined);

  registry.setDegraded('guest-alpha');

  // Generation should exist for degraded routes
  const gen = registry.getRouteGeneration('guest-alpha', 'alpha.verser.test');
  assert.ok(gen);
  assert.ok(gen.generationId);
  assert.ok(gen.generationId.startsWith('gen-'));

  // All degraded routes share the same generation
  const gen2 = registry.getRouteGeneration('guest-alpha', 'beta.verser.test');
  assert.equal(gen.generationId, gen2.generationId);

  // Non-existent domain returns undefined
  assert.equal(registry.getRouteGeneration('guest-alpha', 'missing.verser.test'), undefined);

  // After restoration, generation no longer available via getRouteGeneration
  registry.restoreRoutes('guest-alpha');
  assert.equal(registry.getRouteGeneration('guest-alpha', 'alpha.verser.test'), undefined);
});

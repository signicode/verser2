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

  assert.deepEqual(host.getRoutedDomains(), []);
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
  assert.deepEqual(host.getRoutedDomains(), []);
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

test('Host route registry does not advertise imported routes to legacy Brokers before forwarding exists', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });
  host.setImportedFederatedRoutes('upstream-manager', [importedRoute()]);
  const broker = await host.attachLocalBroker({ brokerId: 'broker-alpha' });

  assert.deepEqual(host.getRoutedDomains(), []);
  assert.deepEqual(broker.getRoutes(), []);

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

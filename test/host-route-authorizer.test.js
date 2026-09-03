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

test('route authorizer caches allow and deny results and receives normalized context', async () => {
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

  // Denial: resolves false and is cached under the negative TTL, so the
  // callback does not run again for the pair.
  assert.equal(await host.authorizeFederatedHopPair('other.hop', 'alpha.verser.test'), false);
  assert.equal(await host.authorizeFederatedHopPair('other.hop', 'alpha.verser.test'), false);
  assert.equal(calls.length, 2);
  assert.equal(host.routeAuthorizer.cachedDenyCount, 1);
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

  // Invalidation clears cached denies as well, and a stale pending deny is
  // neither cached nor able to repopulate either cache.
  mode = 'deny';
  assert.equal(await host.authorizeFederatedHopPair('denied.hop', 'alpha.verser.test'), false);
  assert.equal(host.routeAuthorizer.cachedDenyCount, 1);
  host.removeImportedFederatedRoutes('other-upstream');
  assert.equal(host.routeAuthorizer.cachedDenyCount, 0);
  mode = 'gate';
  const pendingDeny = host.authorizeFederatedHopPair('late-deny.hop', 'alpha.verser.test');
  host.removeImportedFederatedRoutes('another-upstream');
  gate.resolve('deny');
  assert.equal(await pendingDeny, false);
  assert.equal(host.routeAuthorizer.cachedDenyCount, 0);

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

test('registered Broker domain persists for remote and local Brokers and is omitted by default', async () => {
  const host = createVerserHost({ hostId: 'host-hub' });

  const plainBroker = await host.attachLocalBroker({ brokerId: 'broker-plain' });
  assert.equal(host.getRegisteredBrokerDomain('broker-plain'), undefined);

  const hopBroker = await host.attachLocalBroker({
    brokerId: 'broker-hop',
    brokerDomain: ' Broker.Hop.Example. ',
  });
  // Local Brokers persist the normalized value and are exempt from certificate matching.
  assert.equal(host.getRegisteredBrokerDomain('broker-hop'), 'broker.hop.example');

  await assert.rejects(
    () => host.attachLocalBroker({ brokerId: 'broker-empty', brokerDomain: '   ' }),
    /brokerDomain must be a non-empty domain/,
  );
  assert.equal(host.getRegisteredBrokerDomain('guest-unknown'), undefined);

  await hopBroker.close();
  await plainBroker.close();
  await host.close();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('authorization TTL options default to 60000 and floor(allow/10), and reject invalid values', async () => {
  const defaults = createVerserHost({ hostId: 'host-hub', routeAuthorizer: () => 'allow' });
  assert.deepEqual(defaults.routeAuthorizer.options, { allowTtlMs: 60_000, denyTtlMs: 6_000 });
  await defaults.close();

  const derived = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => 'allow',
    routeAuthorizationCacheTtlMs: 5_001,
  });
  assert.deepEqual(derived.routeAuthorizer.options, { allowTtlMs: 5_001, denyTtlMs: 500 });
  await derived.close();

  const zeroAllow = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => 'allow',
    routeAuthorizationCacheTtlMs: 0,
  });
  assert.deepEqual(zeroAllow.routeAuthorizer.options, { allowTtlMs: 0, denyTtlMs: 0 });
  await zeroAllow.close();

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        createVerserHost({
          hostId: 'host-hub',
          routeAuthorizer: () => 'allow',
          routeAuthorizationCacheTtlMs: value,
        }),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(
          error.message,
          /routeAuthorizationCacheTtlMs must be a finite non-negative integer/,
        );
        return true;
      },
    );
    assert.throws(
      () =>
        createVerserHost({
          hostId: 'host-hub',
          routeAuthorizer: () => 'allow',
          routeAuthorizationNegativeCacheTtlMs: value,
        }),
      (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(
          error.message,
          /routeAuthorizationNegativeCacheTtlMs must be a finite non-negative integer/,
        );
        return true;
      },
    );
  }
});

test('allow TTL 0 disables the allow cache while still honoring the current decision', async () => {
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      return 'allow';
    },
    routeAuthorizationCacheTtlMs: 0,
  });

  assert.equal(await host.authorizeFederatedHopPair('zero.hop', 'alpha.verser.test'), true);
  assert.equal(await host.authorizeFederatedHopPair('zero.hop', 'alpha.verser.test'), true);
  assert.equal(calls, 2);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  await host.close();
});

test('deny TTL 0 disables the deny cache while still honoring the current denial', async () => {
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      return 'deny';
    },
    routeAuthorizationCacheTtlMs: 60_000,
    routeAuthorizationNegativeCacheTtlMs: 0,
  });

  assert.equal(await host.authorizeFederatedHopPair('zero-deny.hop', 'alpha.verser.test'), false);
  assert.equal(await host.authorizeFederatedHopPair('zero-deny.hop', 'alpha.verser.test'), false);
  assert.equal(calls, 2);
  assert.equal(host.routeAuthorizer.cachedDenyCount, 0);

  await host.close();
});

test('allow and deny entries expire lazily and single-flight still coalesces after expiry', async () => {
  let calls = 0;
  let decision = 'allow';
  const gate = deferred();
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      return calls === 2 ? gate.promise : decision;
    },
    routeAuthorizationCacheTtlMs: 40,
    routeAuthorizationNegativeCacheTtlMs: 40,
  });

  assert.equal(await host.authorizeFederatedHopPair('ttl.hop', 'alpha.verser.test'), true);
  assert.equal(await host.authorizeFederatedHopPair('ttl.hop', 'alpha.verser.test'), true);
  assert.equal(calls, 1);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 1);

  await sleep(80);
  assert.equal(host.routeAuthorizer.cachedAllowCount, 0);

  // Expired: the callback runs again and concurrent callers share one
  // (gated) decision — single-flight still coalesces after expiry.
  decision = 'deny';
  const first = host.authorizeFederatedHopPair('ttl.hop', 'alpha.verser.test');
  const second = host.authorizeFederatedHopPair('ttl.hop', 'alpha.verser.test');
  assert.equal(host.routeAuthorizer.pendingDecisionCount, 1);
  gate.resolve('deny');
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(calls, 2);

  assert.equal(await host.authorizeFederatedHopPair('ttl.hop', 'alpha.verser.test'), false);
  assert.equal(calls, 2);
  assert.equal(host.routeAuthorizer.cachedDenyCount, 1);

  await sleep(80);
  decision = 'allow';
  assert.equal(await host.authorizeFederatedHopPair('ttl.hop', 'alpha.verser.test'), true);
  assert.equal(calls, 3);

  await host.close();
});

test('revoke clears a cached deny and forces reauthorization of new decisions', async () => {
  let calls = 0;
  const host = createVerserHost({
    hostId: 'host-hub',
    routeAuthorizer: () => {
      calls += 1;
      return 'deny';
    },
  });

  assert.equal(await host.authorizeFederatedHopPair('rev.hop', 'alpha.verser.test'), false);
  assert.equal(await host.authorizeFederatedHopPair('rev.hop', 'alpha.verser.test'), false);
  assert.equal(calls, 1);
  assert.equal(
    host.revokeRouteAuthorization({
      previousAdvertisedDomain: 'rev.hop',
      nextSelectedDomain: 'alpha.verser.test',
    }),
    true,
  );
  assert.equal(host.routeAuthorizer.cachedDenyCount, 0);
  assert.equal(await host.authorizeFederatedHopPair('rev.hop', 'alpha.verser.test'), false);
  assert.equal(calls, 2);

  await host.close();
});

test('legacy brokerHopDomain option is rejected by local attachment and the Node/Bun Brokers', async () => {
  const {
    loadVerserGuestBun,
    loadVerserGuestNode,
  } = require('./support/verser-package-imports.cjs');
  const { createVerserBroker } = loadVerserGuestNode();
  const { createVerserBroker: createVerserBunBroker } = loadVerserGuestBun();
  const host = createVerserHost({ hostId: 'host-hub' });

  assert.throws(
    () =>
      createVerserBroker({
        hostUrl: 'https://127.0.0.1:1',
        brokerId: 'b',
        brokerHopDomain: 'x.test',
      }),
    /brokerHopDomain is not supported; use brokerDomain/,
  );
  assert.throws(
    () =>
      createVerserBunBroker({
        hostUrl: 'https://127.0.0.1:1',
        brokerId: 'b-bun',
        brokerHopDomain: 'x.test',
      }),
    /brokerHopDomain is not supported; use brokerDomain/,
  );
  // The renamed option constructs cleanly on both runtimes.
  assert.equal(
    typeof createVerserBroker({
      hostUrl: 'https://127.0.0.1:1',
      brokerId: 'b',
      brokerDomain: 'x.test',
    }).connect,
    'function',
  );
  assert.equal(
    typeof createVerserBunBroker({
      hostUrl: 'https://127.0.0.1:1',
      brokerId: 'b-bun',
      brokerDomain: 'x.test',
    }).connect,
    'function',
  );
  await assert.rejects(
    () => host.attachLocalBroker({ brokerId: 'legacy-local', brokerHopDomain: 'x.test' }),
    /brokerHopDomain is not supported; use brokerDomain/,
  );
  assert.equal(host.getRegisteredBrokerDomain('legacy-local'), undefined);

  await host.close();
});

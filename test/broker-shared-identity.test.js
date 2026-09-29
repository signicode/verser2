const assert = require('node:assert/strict');
const http2 = require('node:http2');
const test = require('./support/guarded-test.cjs');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  clientCa,
  trusted,
  trustedClient,
  trustedClientSibling,
  untrustedClient,
} = require('./support/tls-fixtures.cjs');

const brokerId = 'shared-mtls-broker';
const brokerDomain = 'trusted-client';
const guestId = 'shared-mtls-guest';
const guestDomain = 'shared-mtls.verser.test';
const timeoutMs = 5000;

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

function withTimeout(promise, description, duration = timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), duration);
    }),
  ]).finally(() => clearTimeout(timer));
}

function makeHost(
  authorizationContexts,
  authorizeRegistration,
  routeAuthorizer,
  routeAuthorizationCacheTtlMs,
) {
  return createVerserHost({
    hostId: 'shared-identity-host',
    port: 0,
    ...(routeAuthorizer === undefined ? {} : { routeAuthorizer }),
    ...(routeAuthorizationCacheTtlMs === undefined ? {} : { routeAuthorizationCacheTtlMs }),
    tls: {
      cert: trusted.certificate,
      key: trusted.key,
      clientAuth: {
        ca: clientCa.certificate,
        authorizeRegistration(context) {
          if (context.role === 'broker' && context.metadata.local !== true) {
            authorizationContexts.push(context);
          }
          if (
            context.metadata.local !== true &&
            !['trusted-client', 'trusted-client-sibling'].includes(context.certificate?.commonName)
          ) {
            return { action: 'close', reason: 'unexpected client certificate' };
          }
          if (authorizeRegistration !== undefined) {
            return authorizeRegistration(context);
          }
          return { action: 'allow' };
        },
      },
    },
  });
}

function hostUrl(host) {
  return `https://127.0.0.1:${host.address.port}`;
}

async function connectMtls(host, identity = trustedClient) {
  const session = http2.connect(hostUrl(host), {
    ca: trusted.certificate,
    cert: identity.certificate,
    key: identity.key,
  });
  await withTimeout(once(session, 'connect'), 'HTTP/2 TLS connection');
  return session;
}

function openBrokerRegistration(session, registration = {}) {
  const control = session.request({ ':method': 'POST', ':path': '/verser/register' });
  control.setEncoding('utf8');
  let pending = '';
  const frames = [];
  const waiters = [];
  const deliver = (frame) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(frame);
    else frames.push(frame);
  };
  control.on('data', (chunk) => {
    pending += chunk;
    assert.ok(pending.length <= 16 * 1024, 'registration control buffer exceeded its bound');
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      deliver(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  });
  control.on('end', () => {
    if (pending.length > 0) {
      try {
        deliver(JSON.parse(pending));
      } catch {
        deliver({ parseError: pending });
      }
      pending = '';
    }
  });
  control.on('error', (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  control.end(JSON.stringify({ peerId: brokerId, role: 'broker', brokerDomain, ...registration }));
  return {
    control,
    nextFrame(description = 'Broker registration/control frame') {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      return withTimeout(
        new Promise((resolve, reject) => waiters.push({ resolve, reject })),
        description,
      );
    },
  };
}

async function nextRouteSnapshot(registration) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const frame = await registration.nextFrame('Broker route update');
    if (frame.type === 'routes') return frame.routes;
  }
  throw new Error('Broker did not receive a full route snapshot');
}

function brokerRequest(session, requestId, path = '/') {
  const stream = session.request({
    ':method': 'POST',
    ':path': '/verser/request',
    'x-verser-source-id': brokerId,
    'x-verser-target-id': guestId,
    'x-verser-route-domain': guestDomain,
    'x-verser-request-id': requestId,
    'x-verser-method': 'GET',
    'x-verser-path': path,
    'x-verser-headers': JSON.stringify({ host: guestDomain }),
  });
  stream.end();
  const response = withTimeout(
    new Promise((resolve, reject) => {
      stream.once('response', (headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          body += chunk;
          assert.ok(body.length <= 4096, 'test response exceeded its small-body bound');
        });
        stream.once('end', () => resolve({ status: headers[':status'], body }));
      });
      stream.once('error', reject);
    }),
    `Broker request ${requestId}`,
  );
  return { stream, response };
}

function requestJson(session, headers) {
  const stream = session.request({ ':method': 'POST', ...headers });
  const response = withTimeout(
    new Promise((resolve, reject) => {
      stream.once('response', (responseHeaders) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          body += chunk;
          assert.ok(body.length <= 4096, 'small error response exceeded its bound');
        });
        stream.once('end', () =>
          resolve({ status: responseHeaders[':status'], body: JSON.parse(body) }),
        );
      });
      stream.once('error', reject);
    }),
    'HTTP/2 error response',
  );
  stream.end();
  return response;
}

test.before(async () => {
  const warmupHost = makeHost([]);
  let warmupSession;
  let warmupControl;

  try {
    await warmupHost.start();
    warmupSession = await connectMtls(warmupHost);
    const registration = openBrokerRegistration(warmupSession);
    warmupControl = registration.control;
    assert.equal((await registration.nextFrame('mTLS warmup registration')).status, 'registered');
  } finally {
    warmupControl?.close();
    warmupSession?.destroy();
    await warmupHost.close('warmup-complete');
  }
});

test('same mTLS Broker identity can use independent sessions, routes, requests and reconnect', async () => {
  const authorizationContexts = [];
  const host = makeHost(authorizationContexts);
  const sessions = [];
  const controls = [];
  let guest;
  let outsider;
  let releaseHeldRequest;
  let heldRequestStarted;

  try {
    await host.start();
    const first = await connectMtls(host);
    sessions.push(first);
    const firstRegistration = openBrokerRegistration(first);
    controls.push(firstRegistration.control);
    assert.equal((await firstRegistration.nextFrame()).status, 'registered');

    const sibling = await connectMtls(host, trustedClientSibling);
    sessions.push(sibling);
    const siblingRegistration = openBrokerRegistration(sibling);
    controls.push(siblingRegistration.control);
    const siblingInitialFrame = await siblingRegistration.nextFrame();
    assert.equal(
      siblingInitialFrame.status,
      'registered',
      `same-certificate sibling registration was rejected: ${JSON.stringify(siblingInitialFrame)}`,
    );
    assert.equal(
      authorizationContexts.filter((context) => context.peerId === brokerId).length,
      2,
      'each physical Broker session must be independently authorized',
    );
    assert.notEqual(
      authorizationContexts[0].certificate.fingerprint256,
      authorizationContexts[1].certificate.fingerprint256,
    );
    const duplicateOnSameSession = openBrokerRegistration(first);
    controls.push(duplicateOnSameSession.control);
    assert.notEqual(
      (await duplicateOnSameSession.nextFrame('same-session duplicate registration')).status,
      'registered',
    );
    duplicateOnSameSession.control.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      first.closed,
      false,
      'closing a rejected registration stream must not detach its Broker',
    );

    heldRequestStarted = new Promise((resolve) => {
      releaseHeldRequest = resolve;
    });
    let signalHeldStarted;
    const heldStarted = new Promise((resolve) => {
      signalHeldStarted = resolve;
    });
    guest = await host.attachLocalGuest({
      guestId,
      routedDomains: [guestDomain],
      listener: async (request, response) => {
        if (request.url === '/hold') {
          signalHeldStarted();
          await heldRequestStarted;
          response.end('held');
          return;
        }
        response.end('fast');
      },
    });

    const expectedRoute = { targetId: guestId, domain: guestDomain };
    assert.deepEqual(await nextRouteSnapshot(firstRegistration), [expectedRoute]);
    assert.deepEqual(await nextRouteSnapshot(siblingRegistration), [expectedRoute]);

    outsider = await connectMtls(host);
    const spoofedVws = await requestJson(outsider, {
      ':path': '/verser/websocket',
      'x-verser-source-id': brokerId,
      'x-verser-target-id': guestId,
      'x-verser-domain': guestDomain,
      'x-verser-ws-path': '/spoof',
    });
    assert.equal(spoofedVws.status, 502);
    assert.equal(spoofedVws.body.error.code, 'authorization-denied');

    const held = brokerRequest(first, 'same-shared-request-id', '/hold');
    await withTimeout(heldStarted, 'held Guest request start');
    const fast = brokerRequest(sibling, 'same-shared-request-id', '/fast');
    const fastResponse = await fast.response;
    assert.equal(fastResponse.status, 200);
    assert.equal(fastResponse.body, 'fast');
    releaseHeldRequest();
    const heldResponse = await held.response;
    assert.equal(heldResponse.status, 200);
    assert.equal(heldResponse.body, 'held');

    const firstSessionClosed = once(first, 'close');
    firstRegistration.control.close();
    await withTimeout(firstSessionClosed, 'Broker registration control closes its session');
    const siblingAfterDetach = brokerRequest(sibling, 'sibling-after-detach', '/after-close');
    assert.equal((await siblingAfterDetach.response).body, 'fast');

    const reconnected = await connectMtls(host);
    sessions.push(reconnected);
    const reconnectedRegistration = openBrokerRegistration(reconnected);
    controls.push(reconnectedRegistration.control);
    const reconnectFrame = await reconnectedRegistration.nextFrame();
    assert.equal(reconnectFrame.status, 'registered');
    assert.deepEqual(reconnectFrame.routes, [expectedRoute]);
  } finally {
    releaseHeldRequest?.();
    for (const control of controls) {
      if (!control.closed) control.close();
    }
    for (const session of sessions) session.destroy();
    outsider?.destroy();
    await guest?.close('test-complete');
    await host.close('test-complete');
  }
});

test('concurrent same-certificate Broker admissions independently authorize and join one logical identity', async () => {
  const authorizationContexts = [];
  const authorizationGates = [];
  let signalBothEntered;
  const bothEntered = new Promise((resolve) => {
    signalBothEntered = resolve;
  });
  const host = makeHost(authorizationContexts, () => {
    let resolve;
    const gate = new Promise((res) => {
      resolve = res;
    });
    authorizationGates.push({ resolve, gate });
    if (authorizationGates.length === 2) signalBothEntered();
    return gate;
  });
  const sessions = [];
  const controls = [];

  try {
    await host.start();
    const registrations = [];
    for (let index = 0; index < 2; index += 1) {
      const session = await connectMtls(host);
      sessions.push(session);
      const registration = openBrokerRegistration(session);
      controls.push(registration.control);
      registrations.push(registration);
    }
    await withTimeout(bothEntered, 'both authorizeRegistration callbacks');
    assert.equal(authorizationContexts.length, 2);
    for (const authorization of authorizationGates) {
      authorization.resolve({ action: 'allow' });
    }
    const responses = await Promise.all(
      registrations.map((registration) => registration.nextFrame()),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      ['registered', 'registered'],
    );
  } finally {
    for (const authorization of authorizationGates) {
      authorization.resolve({ action: 'allow' });
    }
    for (const control of controls) control.close();
    for (const session of sessions) session.destroy();
    await host.close('test-complete');
  }
});

test('closing one admitted Broker control stream detaches only that session', async () => {
  const host = makeHost([]);
  let firstSession;
  let firstControl;
  let duplicateControl;
  let siblingSession;
  let siblingControl;
  let guest;

  try {
    await host.start();
    firstSession = await connectMtls(host);
    const first = openBrokerRegistration(firstSession);
    firstControl = first.control;
    assert.equal((await first.nextFrame()).status, 'registered');

    const duplicate = openBrokerRegistration(firstSession);
    duplicateControl = duplicate.control;
    assert.notEqual(
      (await duplicate.nextFrame('duplicate registration result')).status,
      'registered',
    );
    duplicateControl.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      firstSession.closed,
      false,
      'a failed duplicate stream cannot detach the admitted session',
    );

    siblingSession = await connectMtls(host);
    const sibling = openBrokerRegistration(siblingSession);
    siblingControl = sibling.control;
    assert.equal((await sibling.nextFrame()).status, 'registered');

    guest = await host.attachLocalGuest({
      guestId,
      routedDomains: [guestDomain],
      listener: (_request, response) => response.end('sibling survived'),
    });
    const firstSessionClosed = once(firstSession, 'close');
    firstControl.close();
    await withTimeout(firstSessionClosed, 'registration-control session detachment');

    const response = brokerRequest(siblingSession, 'sibling-after-control-close');
    assert.equal((await response.response).body, 'sibling survived');
  } finally {
    for (const control of [firstControl, duplicateControl, siblingControl]) {
      if (control !== undefined && !control.closed) control.close();
    }
    firstSession?.destroy();
    siblingSession?.destroy();
    await guest?.close('test-complete');
    await host.close('test-complete');
  }
});

test('cancelled Broker VWS authorization stops route fallback and leaves its sibling usable', async () => {
  let authorizeVws;
  let signalAuthorization;
  const vwsAuthorization = new Promise((resolve) => {
    authorizeVws = resolve;
  });
  const authorizationStarted = new Promise((resolve) => {
    signalAuthorization = resolve;
  });
  const hopPairs = [];
  const host = makeHost(
    [],
    undefined,
    (pair) => {
      hopPairs.push(pair);
      if (hopPairs.length === 1) {
        signalAuthorization();
        return vwsAuthorization;
      }
      return 'allow';
    },
    0,
  );
  let firstSession;
  let firstControl;
  let siblingSession;
  let siblingControl;
  let guest;
  let vwsStream;

  try {
    await host.start();
    firstSession = await connectMtls(host);
    const first = openBrokerRegistration(firstSession);
    firstControl = first.control;
    assert.equal((await first.nextFrame()).status, 'registered');
    siblingSession = await connectMtls(host);
    const sibling = openBrokerRegistration(siblingSession);
    siblingControl = sibling.control;
    assert.equal((await sibling.nextFrame()).status, 'registered');

    guest = await host.attachLocalGuest({
      guestId,
      routedDomains: [guestDomain],
      listener: (_request, response) => response.end('same-ID sibling stays live'),
    });
    const forwardedRoute = (nextHopHostId) => ({
      targetId: guestId,
      domain: guestDomain,
      originHostId: `origin-${nextHopHostId}`,
      nextHopHostId,
      hopCount: 1,
      viaHostIds: [`origin-${nextHopHostId}`],
      source: 'upstream',
    });
    host.setImportedFederatedRoutes('vws-hop-a', [forwardedRoute('vws-hop-a')]);
    host.setImportedFederatedRoutes('vws-hop-b', [forwardedRoute('vws-hop-b')]);

    vwsStream = firstSession.request({
      ':method': 'POST',
      ':path': '/verser/websocket',
      'x-verser-source-id': brokerId,
      'x-verser-target-id': guestId,
      'x-verser-domain': guestDomain,
      'x-verser-ws-path': '/cancel-before-forward',
    });
    vwsStream.on('error', () => {});
    vwsStream.end();
    await withTimeout(authorizationStarted, 'pending Broker VWS hop authorization');
    vwsStream.close(http2.constants.NGHTTP2_CANCEL);
    await new Promise((resolve) => setTimeout(resolve, 30));
    authorizeVws('allow');
    await new Promise((resolve) => setTimeout(resolve, 75));

    assert.equal(hopPairs.length, 1, 'a cancelled VWS open must not fall back to another route');
    const response = brokerRequest(siblingSession, 'sibling-after-vws-cancel');
    assert.equal((await response.response).body, 'same-ID sibling stays live');
  } finally {
    authorizeVws?.('deny');
    vwsStream?.close(http2.constants.NGHTTP2_CANCEL);
    for (const control of [firstControl, siblingControl]) {
      if (control !== undefined && !control.closed) control.close();
    }
    firstSession?.destroy();
    siblingSession?.destroy();
    await guest?.close('test-complete');
    await host.close('test-complete');
  }
});

test('duplicate Broker identity without an authenticated client certificate remains unique', async () => {
  const host = createVerserHost({
    hostId: 'shared-identity-no-mtls-host',
    port: 0,
    tls: { cert: trusted.certificate, key: trusted.key },
  });
  const sessions = [];
  const controls = [];

  try {
    await host.start();
    const registrations = [];
    for (let index = 0; index < 2; index += 1) {
      const session = http2.connect(hostUrl(host), { ca: trusted.certificate });
      sessions.push(session);
      await withTimeout(once(session, 'connect'), 'no-mTLS HTTP/2 connection');
      const registration = openBrokerRegistration(session);
      controls.push(registration.control);
      registrations.push(registration);
    }
    assert.equal((await registrations[0].nextFrame()).status, 'registered');
    assert.notEqual((await registrations[1].nextFrame()).status, 'registered');
  } finally {
    for (const control of controls) control.close();
    for (const session of sessions) session.destroy();
    await host.close('test-complete');
  }
});

test('Broker identity cannot join an ID already owned by a federated Host', async () => {
  const authorizationContexts = [];
  const host = makeHost(authorizationContexts);
  let federationSession;
  let brokerSession;
  let brokerControl;

  try {
    await host.start();
    federationSession = await connectMtls(host);
    const handshake = federationSession.request({
      ':method': 'POST',
      ':path': '/verser/host/federation',
    });
    handshake.end(
      JSON.stringify({
        hostId: brokerId,
        protocolVersion: 1,
        importRoutes: false,
        exportRoutes: false,
      }),
    );
    await withTimeout(once(handshake, 'response'), 'federation identity registration');
    handshake.resume();

    brokerSession = await connectMtls(host);
    const registration = openBrokerRegistration(brokerSession);
    brokerControl = registration.control;
    assert.notEqual(
      (await registration.nextFrame('federation identity collision response')).status,
      'registered',
    );
  } finally {
    brokerControl?.close();
    federationSession?.destroy();
    brokerSession?.destroy();
    await host.close('test-complete');
  }
});

test('a denied same-identity Broker session does not evict its admitted sibling', async () => {
  const authorizationContexts = [];
  const host = makeHost(authorizationContexts, (context) => {
    if (context.metadata.local === true) return { action: 'allow' };
    return authorizationContexts.length === 1
      ? { action: 'allow' }
      : { action: 'close', reason: 'sibling denied by test policy' };
  });
  let admittedSession;
  let admittedControl;
  let deniedSession;
  let deniedControl;
  let guest;

  try {
    await host.start();
    admittedSession = await connectMtls(host);
    const admitted = openBrokerRegistration(admittedSession);
    admittedControl = admitted.control;
    assert.equal((await admitted.nextFrame()).status, 'registered');

    deniedSession = await connectMtls(host);
    const denied = openBrokerRegistration(deniedSession);
    deniedControl = denied.control;
    await withTimeout(once(deniedSession, 'close'), 'denied sibling session close');
    assert.equal(authorizationContexts.length, 2);

    guest = await host.attachLocalGuest({
      guestId,
      routedDomains: [guestDomain],
      listener: (_request, response) => response.end('first session retained'),
    });
    const response = brokerRequest(admittedSession, 'denied-sibling-preserved');
    assert.equal((await response.response).body, 'first session retained');
  } finally {
    admittedControl?.close();
    deniedControl?.close();
    admittedSession?.destroy();
    deniedSession?.destroy();
    await guest?.close('test-complete');
    await host.close('test-complete');
  }
});

test('rejected mTLS siblings with mismatched registration or certificate do not evict the admitted Broker', async () => {
  const authorizationContexts = [];
  const host = makeHost(authorizationContexts);
  let admittedSession;
  let admittedControl;
  let mismatchedSession;
  let mismatchedControl;
  let omittedDomainSession;
  let omittedDomainControl;
  let roleMismatchSession;
  let roleMismatchControl;
  let untrustedSession;
  let guest;

  try {
    await host.start();
    admittedSession = await connectMtls(host);
    const admitted = openBrokerRegistration(admittedSession);
    admittedControl = admitted.control;
    assert.equal((await admitted.nextFrame()).status, 'registered');

    mismatchedSession = await connectMtls(host);
    const mismatch = openBrokerRegistration(mismatchedSession, {
      brokerDomain: 'not-the-certificate-domain.verser.test',
    });
    mismatchedControl = mismatch.control;
    const mismatchFrame = await mismatch.nextFrame('mismatched-domain registration response');
    assert.notEqual(mismatchFrame.status, 'registered');

    omittedDomainSession = await connectMtls(host);
    const omittedDomain = openBrokerRegistration(omittedDomainSession, { brokerDomain: undefined });
    omittedDomainControl = omittedDomain.control;
    assert.notEqual(
      (await omittedDomain.nextFrame('valid but mismatched registration response')).status,
      'registered',
    );
    assert.equal(authorizationContexts.at(-1).peerId, brokerId);
    assert.equal(authorizationContexts.at(-1).role, 'broker');
    assert.equal(authorizationContexts.at(-1).brokerDomain, undefined);

    roleMismatchSession = await connectMtls(host);
    const roleMismatch = openBrokerRegistration(roleMismatchSession, {
      role: 'guest',
      brokerDomain: undefined,
      routedDomains: [guestDomain],
    });
    roleMismatchControl = roleMismatch.control;
    assert.notEqual(
      (await roleMismatch.nextFrame('mismatched-role registration response')).status,
      'registered',
    );

    untrustedSession = http2.connect(hostUrl(host), {
      ca: trusted.certificate,
      cert: untrustedClient.certificate,
      key: untrustedClient.key,
    });
    let rejectedDuringTls = false;
    try {
      await withTimeout(once(untrustedSession, 'connect'), 'untrusted client TLS connection');
    } catch {
      rejectedDuringTls = true;
    }
    if (!rejectedDuringTls) {
      const untrustedRegistration = openBrokerRegistration(untrustedSession);
      const untrustedResult = await withTimeout(
        Promise.race([
          untrustedRegistration
            .nextFrame('untrusted-certificate registration response')
            .then((frame) => ({ frame })),
          once(untrustedSession, 'close').then(() => ({ closed: true })),
        ]),
        'untrusted certificate rejection',
      );
      assert.ok(
        untrustedResult.closed || untrustedResult.frame?.status !== 'registered',
        'untrusted client certificate must not be admitted',
      );
      untrustedRegistration.control.close();
    }

    guest = await host.attachLocalGuest({
      guestId,
      routedDomains: [guestDomain],
      listener: (_request, response) => response.end('survived'),
    });
    const response = brokerRequest(admittedSession, 'surviving-primary-broker');
    assert.equal((await response.response).body, 'survived');
  } finally {
    admittedControl?.close();
    mismatchedControl?.close();
    omittedDomainControl?.close();
    roleMismatchControl?.close();
    admittedSession?.destroy();
    mismatchedSession?.destroy();
    omittedDomainSession?.destroy();
    roleMismatchSession?.destroy();
    untrustedSession?.destroy();
    await guest?.close('test-complete');
    await host.close('test-complete');
  }
});

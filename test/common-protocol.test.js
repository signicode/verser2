const assert = require('node:assert/strict');
const { test } = require('node:test');

const common = require('../packages/verser-common/dist/index.js');

test('shared protocol helpers create identifiers and route registrations', () => {
  const guestId = common.createGuestId('guest-alpha');
  const peerId = common.createPeerId('peer-beta');
  const route = common.createRoutedDomainRegistration({
    targetId: guestId,
    domain: 'alpha.verser.test',
  });

  assert.equal(guestId, 'guest-alpha');
  assert.equal(peerId, 'peer-beta');
  assert.deepEqual(route, {
    targetId: 'guest-alpha',
    domain: 'alpha.verser.test',
  });
  assert.throws(() => common.createGuestId(''), /guest id/i);
  assert.throws(
    () => common.createRoutedDomainRegistration({ targetId: guestId, domain: '' }),
    /domain/i,
  );
});

test('shared protocol resolves advertised routes by exact hostname', () => {
  assert.deepEqual(
    common.resolveRouteForHostname(
      [
        { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
        { targetId: 'guest-beta', domain: 'beta.verser.test' },
      ],
      'beta.verser.test',
    ),
    {
      targetId: 'guest-beta',
      domain: 'beta.verser.test',
    },
  );

  assert.equal(
    common.resolveRouteForHostname(
      [
        { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
        { targetId: 'guest-beta', domain: 'beta.verser.test' },
      ],
      'verser.test',
    ),
    undefined,
  );
});

test('shared registration protocol helpers parse registration requests and responses', () => {
  assert.deepEqual(
    common.parseRegistrationRequest(
      JSON.stringify({
        peerId: 'guest-alpha',
        role: 'guest',
        routedDomains: ['alpha.verser.test'],
      }),
    ),
    {
      peerId: 'guest-alpha',
      role: 'guest',
      routedDomains: ['alpha.verser.test'],
    },
  );
  assert.deepEqual(
    common.parseRegistrationRequest(JSON.stringify({ peerId: 'broker-alpha', role: 'broker' })),
    {
      peerId: 'broker-alpha',
      role: 'broker',
      routedDomains: [],
    },
  );
  assert.throws(
    () => common.parseRegistrationRequest(JSON.stringify({ peerId: 'peer-alpha', role: 'admin' })),
    /Registration role must be broker or guest/,
  );
  assert.deepEqual(common.parseRegistrationResponse('{"status":"ok"}', 'guest-alpha'), {
    status: 'ok',
  });
  assert.throws(
    () => common.parseRegistrationResponse('not-json', 'guest-alpha'),
    /Host returned invalid registration JSON/,
  );
});

test('shared broker control frames preserve route advertisements', () => {
  const frame = common.createBrokerRoutesControlFrame([
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  assert.deepEqual(frame, {
    type: 'routes',
    routes: [{ targetId: 'guest-alpha', domain: 'alpha.verser.test' }],
  });
});

test('shared request and response envelopes preserve HTTP semantics', () => {
  const request = common.createRoutedRequestEnvelope({
    requestId: 'req-1',
    sourceId: 'broker-1',
    targetId: 'guest-alpha',
    method: 'POST',
    path: '/hello?name=verser',
    headers: { 'content-type': 'text/plain' },
    timeoutMs: 5000,
  });
  const response = common.createRoutedResponseEnvelope({
    requestId: request.requestId,
    statusCode: 201,
    headers: { 'x-guest': 'alpha' },
  });

  assert.deepEqual(request, {
    requestId: 'req-1',
    sourceId: 'broker-1',
    targetId: 'guest-alpha',
    method: 'POST',
    path: '/hello?name=verser',
    headers: { 'content-type': 'text/plain' },
    timeoutMs: 5000,
  });
  assert.deepEqual(response, {
    requestId: 'req-1',
    statusCode: 201,
    headers: { 'x-guest': 'alpha' },
  });
  assert.equal(
    common.createRoutedRequestEnvelope({
      requestId: 'req-2',
      sourceId: 'broker-1',
      targetId: 'guest-alpha',
      method: 'GET',
      path: '/',
      headers: {},
    }).timeoutMs,
    undefined,
  );
});

test('shared lifecycle names and contextual errors are exported', () => {
  assert.deepEqual(common.VERSER_LIFECYCLE_EVENTS, {
    connected: 'connected',
    disconnected: 'disconnected',
    registered: 'registered',
    routeAdvertised: 'route-advertised',
    requestStarted: 'request-started',
    requestCompleted: 'request-completed',
    error: 'error',
    closed: 'closed',
  });

  const error = common.createVerserError('missing-guest', 'Target guest is not connected', {
    targetId: 'guest-alpha',
    method: 'GET',
    path: '/missing',
  });

  assert.equal(error.name, 'VerserError');
  assert.equal(error.code, 'missing-guest');
  assert.equal(error.context.targetId, 'guest-alpha');
  assert.match(error.message, /missing-guest/);
  assert.match(error.message, /guest-alpha/);

  const contextFreeError = common.createVerserError('timeout', 'Request timed out');
  assert.equal(contextFreeError.message, '[timeout] Request timed out');
});

test('shared HTTP error response shape is stable', () => {
  const encoded = common.toVerserHttpErrorResponse(
    common.createVerserError('missing-guest', 'No guest', { targetId: 'guest-1' }),
  );

  assert.deepEqual(encoded, {
    error: {
      code: 'missing-guest',
      message: '[missing-guest] No guest (targetId=guest-1',
      context: {
        targetId: 'guest-1',
      },
    },
  });
});

test('shared error code parser accepts known codes and falls back', () => {
  assert.equal(common.toVerserErrorCode('timeout'), 'timeout');
  assert.equal(common.toVerserErrorCode('disconnected-target'), 'disconnected-target');
  assert.equal(common.toVerserErrorCode(undefined), 'local-handler-failure');
  assert.equal(common.toVerserErrorCode('unknown-code'), 'local-handler-failure');
});

test('shared HTTP/2 pseudo-header mapping keeps protocol fields explicit', () => {
  assert.deepEqual(common.toHttp2RequestHeaders({ method: 'PUT', path: '/items/1' }), {
    ':method': 'PUT',
    ':path': '/items/1',
  });
  assert.deepEqual(common.fromHttp2RequestHeaders({ ':method': 'PATCH', ':path': '/items/2' }), {
    method: 'PATCH',
    path: '/items/2',
  });
  assert.deepEqual(common.toHttp2ResponseHeaders({ statusCode: 204 }), { ':status': 204 });
  assert.deepEqual(common.fromHttp2ResponseHeaders({ ':status': 202 }), { statusCode: 202 });
  assert.throws(() => common.fromHttp2RequestHeaders({ ':path': '/missing-method' }), /:method/);
  assert.throws(() => common.fromHttp2ResponseHeaders({ ':status': 99 }), /status code/);
});

test('shared header helpers flatten and decode routed metadata', () => {
  assert.deepEqual(common.flattenVerserHeaders({ a: 'one', b: ['two', 'three'] }), {
    a: 'one',
    b: 'two,three',
  });

  assert.deepEqual(common.decodeHeaderMap('{"x-a":"1","x-b":2}'), {
    'x-a': '1',
    'x-b': '2',
  });
});

test('shared protocol helpers parse lease-acquire timeout header', () => {
  assert.equal(
    common.parseLeaseAcquireTimeoutMs({ 'x-verser-lease-acquire-timeout-ms': '250' }),
    250,
  );
  assert.equal(common.parseLeaseAcquireTimeoutMs({}), 5000);
  assert.equal(
    common.parseLeaseAcquireTimeoutMs({ 'x-verser-lease-acquire-timeout-ms': '-1' }),
    5000,
  );
  assert.equal(
    common.parseLeaseAcquireTimeoutMs({ 'x-verser-lease-acquire-timeout-ms': 'NaN' }),
    5000,
  );
  assert.equal(
    common.parseLeaseAcquireTimeoutMs({ 'x-verser-lease-acquire-timeout-ms': 'Infinity' }),
    5000,
  );
});

test('shared HTTP/2 pseudo-header stripping removes :headers', () => {
  assert.deepEqual(common.stripHttp2PseudoHeaders({ ':status': 200, 'x-a': '1' }), {
    'x-a': '1',
  });
});

test('shared development certificate helpers expose and verify a pinned self-signed certificate', () => {
  const certificate = common.createDevelopmentTlsCertificate();
  const fingerprint = common.getCertificateFingerprint(certificate.cert);

  assert.match(certificate.cert, /BEGIN CERTIFICATE/);
  assert.match(certificate.key, /BEGIN PRIVATE KEY/);
  assert.equal(common.verifyPinnedCertificate(certificate.cert, fingerprint).valid, true);
  assert.deepEqual(common.verifyPinnedCertificate(certificate.cert, 'sha256:invalid'), {
    valid: false,
    reason: 'certificate fingerprint mismatch',
  });
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');

const { loadVerserCommon } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient } = require('./support/tls-fixtures.cjs');

const common = loadVerserCommon();

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

test('shared protocol resolves routes by URL', () => {
  const routes = [
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
    { targetId: 'guest-beta', domain: 'beta.verser.test' },
  ];

  assert.deepEqual(common.resolveRouteForUrl(routes, new URL('https://beta.verser.test/items')), {
    targetId: 'guest-beta',
    domain: 'beta.verser.test',
  });

  assert.equal(
    common.resolveRouteForUrl(routes, new URL('https://missing.verser.test/items')),
    undefined,
  );
});

test('shared broker request normalization normalizes method, path, headers, and body', () => {
  const request = common.createCommonBrokerRequest({
    targetId: 'guest-alpha',
    method: ' post ',
    path: 'api/items?sort=asc',
    headers: {
      'X-Input': 'value',
      uppercase: 2,
    },
    body: 'hello',
  });

  assert.equal(request.targetId, 'guest-alpha');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/items?sort=asc');
  assert.deepEqual(request.headers, {
    'x-input': 'value',
    uppercase: '2',
  });
  assert.deepEqual(request.body, [Buffer.from('hello')]);

  assert.equal(
    common.createCommonBrokerRequest({
      targetId: 'guest-alpha',
      method: 'GET',
      path: '/',
      body: undefined,
    }).body,
    undefined,
  );

  assert.throws(() => {
    common.createCommonBrokerRequest({
      targetId: 'guest-alpha',
      method: 'GET',
      path: '/',
      headers: { 'bad header': 'x' },
    });
  }, /VerserError/);
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

test('shared broad headers normalize array joins and validates names/values', () => {
  const normalized = common.normalizeHeaders({
    'X-Array': ['a', 'b', 1, false],
    plain: 'value',
    omitted: undefined,
    keepNull: null,
    pairs: ['x', '1'],
  });

  assert.deepEqual(normalized, {
    'x-array': 'a,b,1,false',
    plain: 'value',
    pairs: 'x,1',
  });

  assert.equal(common.flattenHeaderValue(['a', 'b', 1]), 'a,b,1');
  assert.equal(common.flattenHeaderValue(undefined), undefined);

  assert.throws(() => {
    common.normalizeHeaders({ 'bad header': 'value' });
  }, /VerserError/);

  assert.deepStrictEqual(common.validateRuntimeNeutralHeaders({ 'x-good': 'value' }), {
    'x-good': 'value',
  });
  assert.equal(common.isValidHeaderName('x-good'), true);
  assert.equal(common.isValidHeaderName('bad header'), false);
  assert.equal(common.isValidHeaderValue('safe\u0000value'), false);
  assert.equal(common.isValidHeaderValue('safe-value'), true);
  assert.equal(common.isValidHeaderValue(''), true);
});

test('shared Node OutgoingHttpHeaders normalization uses comma joining', () => {
  assert.deepEqual(
    common.normalizeRequestHeaders({
      'x-a': ['one', 'two'],
      'x-b': 2,
      'x-c': 'three',
    }),
    {
      'x-a': 'one,two',
      'x-b': '2',
      'x-c': 'three',
    },
  );
});

test('shared toVerserError coerces unknown errors and preserves VerserError identity', () => {
  const source = common.createVerserError('protocol-error', 'Source failure', {
    requestId: 'req-coerce',
  });
  const passthrough = common.toVerserError(source);
  assert.equal(passthrough, source);

  const passthroughWithGuest = common.toVerserError(source, { guestId: 'guest-1' });
  assert.equal(passthroughWithGuest, source);
  assert.equal(passthroughWithGuest.code, 'protocol-error');
  assert.equal(passthroughWithGuest.context.requestId, 'req-coerce');
  assert.equal(passthroughWithGuest.context.guestId, 'guest-1');

  const coerced = common.toVerserError(new Error('boom'), { guestId: 'guest-2' });
  assert.equal(coerced.code, 'protocol-error');
  assert.equal(coerced.context.guestId, 'guest-2');
  assert.match(coerced.message, /boom/);
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

test('shared body helper identifies iterable request bodies', () => {
  assert.equal(common.isIterableBody('not-iterable'), false);
  assert.equal(common.isIterableBody({}), false);
  assert.equal(common.isIterableBody([]), true);
  assert.equal(common.isIterableBody('abc'), false);

  const asyncIterable = {
    async *[Symbol.asyncIterator]() {
      yield 'value';
    },
  };

  assert.equal(common.isAsyncIterableBody(asyncIterable), true);
  assert.equal(common.isAsyncIterableBody({}), false);
});

test('shared body normalization converts string and buffers', () => {
  const stringBody = common.normalizeBrokerRequestBody('payload');
  assert.deepEqual(stringBody, [Buffer.from('payload')]);

  const bufferBody = Buffer.from('binary');
  const normalizedBuffer = common.normalizeBrokerRequestBody(bufferBody);
  assert.deepEqual(normalizedBuffer, [bufferBody]);

  const uint8Body = new Uint8Array([104, 105]);
  const normalizedUint8 = common.normalizeBrokerRequestBody(uint8Body);
  assert.deepEqual(normalizedUint8, [Buffer.from('hi')]);
});

test('shared body normalization converts iterables to Readable', async () => {
  const normalized = common.normalizeBrokerRequestBody(['first', 'second']);
  assert.ok(normalized instanceof Readable);

  const normalizedChunks = await new Promise((resolve, reject) => {
    const bufferChunks = [];
    normalized.on('data', (chunk) => {
      bufferChunks.push(Buffer.from(chunk));
    });
    normalized.once('end', () => resolve(Buffer.concat(bufferChunks)));
    normalized.once('error', reject);
  });

  assert.deepEqual(normalizedChunks, Buffer.from('firstsecond'));
});

test('shared body normalization rejects unsupported bodies', () => {
  assert.equal(common.normalizeBrokerRequestBody(null), undefined);
  assert.throws(
    () => common.normalizeBrokerRequestBody({ foo: 'bar' }),
    /Verser Dispatcher does not support this request body type/,
  );
});

test('shared certificate helpers expose and verify a pinned certificate', () => {
  const fingerprint = common.getCertificateFingerprint(trusted.certificate);

  assert.match(trusted.certificate, /BEGIN CERTIFICATE/);
  assert.equal(common.verifyPinnedCertificate(trusted.certificate, fingerprint).valid, true);
  assert.deepEqual(common.verifyPinnedCertificate(trusted.certificate, 'sha256:invalid'), {
    valid: false,
    reason: 'certificate fingerprint mismatch',
  });
});

test('shared TLS normalizers preserve PEM server identity compatibility', () => {
  assert.deepEqual(
    common.normalizeServerTlsOptions({ cert: trusted.certificate, key: trusted.key }),
    {
      cert: trusted.certificate,
      key: trusted.key,
      passphrase: undefined,
    },
  );
  assert.throws(
    () => common.normalizeServerTlsOptions({ cert: trusted.certificate, keyFile: trusted.keyPath }),
    /Ambiguous TLS config/,
  );
});

test('shared TLS normalizers support PFX server identity', () => {
  assert.deepEqual(common.normalizeServerTlsOptions({ pfx: trusted.pfx }), {
    pfx: trusted.pfx,
    passphrase: undefined,
  });
  assert.deepEqual(common.normalizeServerTlsOptions({ pfxFile: trusted.pfxPath }), {
    pfx: trusted.pfx,
    passphrase: undefined,
  });
});

test('shared TLS normalizers support client PEM and PFX identity', () => {
  assert.deepEqual(
    common.normalizeClientTlsOptions({
      ca: trusted.certificate,
      cert: trustedClient.certificate,
      key: trustedClient.key,
    }),
    {
      ca: trusted.certificate,
      cert: trustedClient.certificate,
      key: trustedClient.key,
      passphrase: undefined,
    },
  );
  assert.deepEqual(
    common.normalizeClientTlsOptions({
      caFile: trusted.certificatePath,
      pfxFile: trustedClient.pfxPath,
      passphrase: trustedClient.pfxPassphrase,
    }),
    {
      ca: trusted.certificate,
      pfx: trustedClient.pfx,
      passphrase: trustedClient.pfxPassphrase,
    },
  );
  assert.deepEqual(
    common.normalizeClientTlsOptions({
      cert: trustedClient.certificate,
      key: trustedClient.key,
    }),
    {
      cert: trustedClient.certificate,
      key: trustedClient.key,
      passphrase: undefined,
    },
  );
});

test('shared TLS normalizers support Host client certificate trust', () => {
  assert.equal(common.normalizeHostClientAuthTlsOptions(undefined), undefined);
  assert.deepEqual(
    common.normalizeHostClientAuthTlsOptions({
      caFile: clientCa.certificatePath,
      knownExtensionOids: ['1.2.3.4'],
    }),
    {
      ca: clientCa.certificate,
      requestCert: true,
      rejectUnauthorized: true,
      knownExtensionOids: ['1.2.3.4'],
    },
  );
});

test('shared certificate identity extraction summarizes peer certificate metadata', () => {
  const raw = Buffer.from('trusted-client-raw');
  const identity = common.extractCertificateIdentity(
    {
      subject: { CN: 'trusted-client', OU: 'tests' },
      issuer: { CN: 'verser-client-ca' },
      subjectaltname: 'DNS:trusted-client, URI:urn:verser:client:trusted-client',
      valid_from: 'Jan  1 00:00:00 2026 GMT',
      valid_to: 'Jan  1 00:00:00 2027 GMT',
      fingerprint256: 'AA:BB:CC',
      raw,
      customExtensions: {
        '1.2.3.4': 'verser-extension-value',
      },
    },
    ['1.2.3.4', '1.2.3.5'],
  );

  assert.deepEqual(identity, {
    commonName: 'trusted-client',
    dnsNames: ['trusted-client'],
    uriNames: ['urn:verser:client:trusted-client'],
    fingerprint256: 'sha256:aabbcc',
    subject: 'CN=trusted-client, OU=tests',
    issuer: 'CN=verser-client-ca',
    validFrom: 'Jan  1 00:00:00 2026 GMT',
    validTo: 'Jan  1 00:00:00 2027 GMT',
    raw: raw.toString('base64'),
    customExtensions: {
      '1.2.3.4': 'verser-extension-value',
    },
  });
});

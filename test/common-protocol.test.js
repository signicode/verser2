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

test('shared federation VWS contract is versioned and preserves route metadata', () => {
  assert.equal(common.FEDERATION_VWS_VERSION, 1);
  assert.equal(common.FEDERATION_VWS_PATH, '/verser/host/federation/websocket');

  const open = common.createFederationVwsOpen({
    sourceId: 'broker-a',
    targetId: 'guest-z',
    domain: 'socket.verser.test',
    path: '/chat',
    protocol: 'chat.v1',
    originHostId: 'host-a',
    viaHostIds: ['host-a'],
    hopCount: 1,
  });
  assert.deepEqual(open, {
    type: 'open',
    version: 1,
    sourceId: 'broker-a',
    targetId: 'guest-z',
    domain: 'socket.verser.test',
    path: '/chat',
    protocol: 'chat.v1',
    originHostId: 'host-a',
    viaHostIds: ['host-a'],
    hopCount: 1,
  });
  assert.deepEqual(common.createFederationVwsAccept({ protocol: 'chat.v1' }), {
    type: 'accept',
    version: 1,
    protocol: 'chat.v1',
  });
});

test('federation VWS negotiation without a response has a deterministic error', () => {
  assert.throws(
    () =>
      common.createFederationVwsNegotiationFailure({
        targetId: 'guest-z',
        domain: 'socket.verser.test',
      }),
    (error) => {
      assert.equal(error.code, 'websocket-negotiation-failed');
      assert.match(error.message, /negotiation response/i);
      assert.equal(error.context.targetId, 'guest-z');
      return true;
    },
  );
});

test('federation VWS negotiation frames round-trip with VWS/1 wire shapes', () => {
  const errorFrame = common.createFederationVwsError('peer rejected the open');
  assert.deepEqual(errorFrame, {
    type: 'error',
    version: 1,
    message: 'peer rejected the open',
    code: 'protocol-error',
  });
  assert.deepEqual(common.decodeVwsFrame(JSON.stringify(errorFrame)), errorFrame);

  const response = common.toVerserHttpErrorResponse(
    common.createVerserError('websocket-negotiation-failed', 'no response', {
      targetId: 'guest-z',
    }),
  );
  const roundTrip = common.verserErrorFromResponseBody(
    Buffer.from(JSON.stringify(response)),
    'guest-z',
  );
  assert.equal(roundTrip.code, 'websocket-negotiation-failed');
  assert.match(roundTrip.message, /no response/);
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

  assert.throws(
    () =>
      common.createCommonBrokerRequest({
        targetId: 'guest-alpha',
        method: 'GET',
        path: '/',
        headers: { 'bad header': 'x' },
      }),
    TypeError,
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

test('registration brokerHopDomain is broker-only, normalized, and omitted when absent', () => {
  assert.deepEqual(
    common.parseRegistrationRequest(
      JSON.stringify({
        peerId: 'broker-alpha',
        role: 'broker',
        brokerHopDomain: '  Broker.Hop.Example.  ',
      }),
    ),
    {
      peerId: 'broker-alpha',
      role: 'broker',
      routedDomains: [],
      brokerHopDomain: 'broker.hop.example',
    },
  );
  assert.deepEqual(
    common.parseRegistrationRequest(
      JSON.stringify({
        peerId: 'broker-beta',
        role: 'broker',
        brokerHopDomain: 'beta.verser.test',
      }),
    ),
    {
      peerId: 'broker-beta',
      role: 'broker',
      routedDomains: [],
      brokerHopDomain: 'beta.verser.test',
    },
  );
  assert.equal(
    'brokerHopDomain' in
      common.parseRegistrationRequest(JSON.stringify({ peerId: 'broker-gamma', role: 'broker' })),
    false,
  );
  assert.throws(
    () =>
      common.parseRegistrationRequest(
        JSON.stringify({
          peerId: 'guest-alpha',
          role: 'guest',
          routedDomains: ['alpha.verser.test'],
          brokerHopDomain: 'hop.verser.test',
        }),
      ),
    /brokerHopDomain is only valid for broker registrations/,
  );
  assert.throws(
    () =>
      common.parseRegistrationRequest(
        JSON.stringify({ peerId: 'broker-alpha', role: 'broker', brokerHopDomain: '   ' }),
      ),
    /brokerHopDomain must be a non-empty domain/,
  );
  assert.throws(
    () =>
      common.parseRegistrationRequest(
        JSON.stringify({ peerId: 'broker-alpha', role: 'broker', brokerHopDomain: 42 }),
      ),
    /brokerHopDomain must be a string/,
  );
});

test('shared route domain normalizer produces the canonical exact-match form', () => {
  assert.equal(common.normalizeVerserRouteDomain('  API.Example.COM. '), 'api.example.com');
  assert.equal(common.normalizeVerserRouteDomain('api.example.com'), 'api.example.com');
  assert.equal(common.normalizeVerserRouteDomain('[2001:db8::1]'), '2001:db8::1');
  assert.equal(common.normalizeVerserRouteDomain('not a domain'), 'not a domain');
  assert.equal(common.normalizeVerserRouteDomain(''), '');
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

test('shared federation helpers create host ids and handshake metadata', () => {
  const hostId = common.createVerserHostId('host-runner');
  const handshake = common.createVerserHostFederationHandshake({
    hostId,
    protocolVersion: 1,
    maxHopCount: 4,
    importRoutes: true,
    exportRoutes: false,
  });

  assert.equal(hostId, 'host-runner');
  assert.deepEqual(handshake, {
    type: 'verser-host-federation-handshake',
    protocolVersion: 1,
    hostId: 'host-runner',
    maxHopCount: 4,
    importRoutes: true,
    exportRoutes: false,
  });
  assert.throws(() => common.createVerserHostId(''), /host id/i);
  assert.throws(
    () => common.createVerserHostFederationHandshake({ hostId: 'host-a', protocolVersion: 0 }),
    /protocol version/i,
  );
  assert.throws(
    () =>
      common.createVerserHostFederationHandshake({
        type: 'wrong-handshake-type',
        hostId: 'host-a',
        protocolVersion: 1,
      }),
    /handshake type/i,
  );
  assert.throws(
    () =>
      common.createVerserHostFederationHandshake({
        hostId: 'host-a',
        protocolVersion: 1,
        importRoutes: 'yes',
      }),
    /importRoutes/i,
  );
});

test('shared federation route metadata validates hop counts and loop prevention', () => {
  const route = common.createFederatedRouteRegistration({
    targetId: 'guest-alpha',
    domain: 'alpha.verser.test',
    originHostId: 'host-runner',
    nextHopHostId: 'host-hub',
    hopCount: 2,
    viaHostIds: ['host-runner', 'host-hub'],
    source: 'upstream',
  });

  assert.deepEqual(route, {
    targetId: 'guest-alpha',
    domain: 'alpha.verser.test',
    originHostId: 'host-runner',
    nextHopHostId: 'host-hub',
    hopCount: 2,
    viaHostIds: ['host-runner', 'host-hub'],
    source: 'upstream',
  });
  assert.equal(common.isFederatedRouteLoop(route, 'host-hub'), true);
  assert.equal(common.isFederatedRouteLoop(route, 'host-manager'), false);
  assert.equal(common.exceedsFederatedRouteHopLimit(route, 1), true);
  assert.equal(common.exceedsFederatedRouteHopLimit(route, 2), false);
  assert.throws(
    () =>
      common.createFederatedRouteRegistration({
        targetId: 'guest-alpha',
        domain: 'alpha.verser.test',
        originHostId: 'host-runner',
        nextHopHostId: 'host-hub',
        hopCount: -1,
        viaHostIds: [],
        source: 'upstream',
      }),
    /hop count/i,
  );
  assert.throws(
    () =>
      common.createFederatedRouteRegistration({
        targetId: 'guest-alpha',
        domain: 'alpha.verser.test',
        originHostId: 'host-runner',
        nextHopHostId: 'host-hub',
        hopCount: 1,
        source: 'upstream',
      }),
    /viaHostIds/i,
  );
  assert.throws(
    () =>
      common.createFederatedRouteRegistration({
        targetId: 'guest-alpha',
        domain: 'alpha.verser.test',
        originHostId: 'host-runner',
        nextHopHostId: 'host-hub',
        hopCount: 1,
        viaHostIds: ['host-runner'],
        source: 'sideways',
      }),
    /source/i,
  );
});

test('shared federation control frames preserve legacy broker route compatibility', () => {
  const federatedRoute = common.createFederatedRouteRegistration({
    targetId: 'guest-alpha',
    domain: 'alpha.verser.test',
    originHostId: 'host-runner',
    nextHopHostId: 'host-hub',
    hopCount: 1,
    viaHostIds: ['host-runner'],
    source: 'local',
  });
  const federationFrame = common.createFederatedRoutesControlFrame([federatedRoute]);
  const brokerFrame = common.createBrokerRoutesControlFrame(federationFrame.routes);

  assert.deepEqual(federationFrame, {
    type: 'federated-routes',
    routes: [federatedRoute],
  });
  assert.deepEqual(brokerFrame, {
    type: 'routes',
    routes: [{ targetId: 'guest-alpha', domain: 'alpha.verser.test' }],
  });
});

test('shared federation error codes are recognized', () => {
  assert.equal(common.toVerserErrorCode('upstream-unavailable'), 'upstream-unavailable');
  assert.equal(common.toVerserErrorCode('route-loop'), 'route-loop');
  assert.equal(common.toVerserErrorCode('authorization-denied'), 'authorization-denied');
  assert.equal(common.toVerserErrorCode('unsafe-retry'), 'unsafe-retry');
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
    routeRevoked: 'route-revoked',
    routeDegraded: 'route-degraded',
    routeRestored: 'route-restored',
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

  assert.deepEqual(common.decodeHeaderMap('{"x-a":"1","x-b":["2","3"]}'), {
    'x-a': '1',
    'x-b': ['2', '3'],
  });
});

test('shared request header map decoder is strict while preserving scalar compatibility', () => {
  assert.deepEqual(common.decodeHeaderMap('{"x-one":"1","x-many":["a","b"]}'), {
    'x-one': '1',
    'x-many': ['a', 'b'],
  });
  for (const value of [
    '[]',
    'null',
    '{"x":1}',
    '{"x":true}',
    '{"x":{}}',
    '{"x":["safe",2]}',
    '{"bad name":"x"}',
    '{"x":"bad\\nvalue"}',
    '{"x":"emoji 😀"}',
  ]) {
    assert.throws(
      () => common.decodeHeaderMap(value),
      (error) => error.code === 'protocol-error',
    );
  }
});

test('shared request header map decoder safely retains __proto__ own properties', () => {
  for (const [value, expected] of [
    ['{"__proto__":"scalar"}', 'scalar'],
    ['{"__proto__":["one","two"]}', ['one', 'two']],
  ]) {
    const decoded = common.decodeHeaderMap(value);
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
    assert.equal(Object.hasOwn(decoded, '__proto__'), true);
    assert.deepEqual(decoded.__proto__, expected);
  }
  assert.throws(
    () => common.decodeHeaderMap('{"x-empty":[]}'),
    (error) => error.code === 'protocol-error',
  );
});

test('shared response metadata codec preserves exact header pairs and legacy projections', () => {
  const metadata = {
    version: 1,
    requestId: 'req-metadata-1',
    statusCode: 207,
    statusText: '',
    headers: [
      ['set-cookie', 'one=1'],
      ['x-quoted', '"one, two"\\value'],
      ['set-cookie', 'two=2'],
      ['x-empty', ''],
    ],
  };
  const encoded = common.encodeVerserResponseMetadata(metadata);
  const decoded = common.decodeVerserResponseMetadata(encoded);

  assert.deepEqual(decoded, metadata);
  assert.deepEqual(common.flattenVerserHeaderPairs(decoded.headers), {
    'set-cookie': 'two=2',
    'x-quoted': '"one, two"\\value',
    'x-empty': '',
  });
  assert.equal(
    Object.hasOwn(
      common.decodeVerserResponseMetadata(
        common.encodeVerserResponseMetadata({
          version: 1,
          requestId: 'req-metadata-omitted-text',
          statusCode: 204,
          headers: [],
        }),
      ),
      'statusText',
    ),
    false,
  );
});

test('shared response metadata codec enforces exact UTF-8 limits and status text safety', () => {
  const base = { version: 1, requestId: 'r', statusCode: 200, headers: [] };
  const encodedAtLimit = common.encodeVerserResponseMetadata({
    ...base,
    statusText: 'é'.repeat(512),
  });
  assert.ok(Buffer.byteLength(encodedAtLimit, 'utf8') <= common.VERSER_RESPONSE_METADATA_MAX_BYTES);
  assert.equal(
    Buffer.byteLength('é'.repeat(512), 'utf8'),
    common.VERSER_RESPONSE_METADATA_MAX_STATUS_TEXT_BYTES,
  );

  assert.throws(
    () => common.encodeVerserResponseMetadata({ ...base, statusText: 'a'.repeat(1025) }),
    /status text/i,
  );
  assert.throws(
    () => common.encodeVerserResponseMetadata({ ...base, statusText: 'é'.repeat(513) }),
    /status text/i,
  );
  for (const invalidText of ['bad\rtext', 'bad\ntext', 'bad\0text']) {
    assert.throws(
      () => common.encodeVerserResponseMetadata({ ...base, statusText: invalidText }),
      /status text/i,
    );
  }

  const atPairLimit = common.encodeVerserResponseMetadata({
    ...base,
    headers: Array.from(
      { length: common.VERSER_RESPONSE_METADATA_MAX_HEADER_PAIRS },
      (_, index) => [`x-${index}`, ''],
    ),
  });
  assert.equal(common.decodeVerserResponseMetadata(atPairLimit).headers.length, 64);
  assert.throws(
    () =>
      common.encodeVerserResponseMetadata({
        ...base,
        headers: Array.from({ length: 65 }, (_, index) => [`x-${index}`, '']),
      }),
    /header pairs/i,
  );

  const emptyHeaderValue = { ...base, headers: [['x', '']] };
  const emptyHeaderJson = JSON.stringify(emptyHeaderValue);
  const exactValue = JSON.stringify({
    ...base,
    headers: [['x', 'a'.repeat(4096 - Buffer.byteLength(emptyHeaderJson))]],
  });
  assert.equal(Buffer.byteLength(exactValue), common.VERSER_RESPONSE_METADATA_MAX_BYTES);
  assert.equal(
    common.decodeVerserResponseMetadata(exactValue).headers[0][1].length,
    4096 - Buffer.byteLength(emptyHeaderJson),
  );
  const overValue = JSON.stringify({
    ...base,
    headers: [['x', 'a'.repeat(4097 - Buffer.byteLength(emptyHeaderJson))]],
  });
  assert.equal(Buffer.byteLength(overValue), common.VERSER_RESPONSE_METADATA_MAX_BYTES + 1);
  assert.throws(() => common.decodeVerserResponseMetadata(overValue), /metadata.*bytes/i);
  assert.throws(
    () =>
      common.encodeVerserResponseMetadata({
        ...base,
        headers: [['x', 'a'.repeat(4097 - Buffer.byteLength(emptyHeaderJson))]],
      }),
    /metadata.*bytes/i,
  );
});

test('shared response metadata codec rejects malformed, unsafe, and incompatible values', () => {
  const valid = { version: 1, requestId: 'req-valid', statusCode: 200, headers: [['x-a', 'one']] };
  for (const metadata of [
    { ...valid, statusText: 'bad\ud800' },
    { ...valid, statusText: 'emoji 😀' },
    { ...valid, headers: [['x-a', 'bad\ud800']] },
    { ...valid, headers: [['x-a', 'emoji 😀']] },
  ]) {
    assert.throws(
      () => common.encodeVerserResponseMetadata(metadata),
      (error) => error.code === 'protocol-error',
    );
  }
  const invalidValues = [
    'not-json',
    '[]',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, requestId: '' }),
    JSON.stringify({ ...valid, statusCode: 199 }),
    JSON.stringify({ ...valid, statusCode: 600 }),
    JSON.stringify({ ...valid, headers: [['x-a']] }),
    JSON.stringify({ ...valid, headers: [[1, 'one']] }),
    JSON.stringify({ ...valid, headers: [['x-a', false]] }),
    JSON.stringify({ ...valid, headers: [['bad name', 'one']] }),
    JSON.stringify({ ...valid, headers: [['x-a', 'bad\nvalue']] }),
    JSON.stringify({ ...valid, headers: [['x-a', 'bad\u007fvalue']] }),
    JSON.stringify({ ...valid, requestId: 'bad\ud800' }),
    JSON.stringify({ ...valid, statusText: 'bad\udc00' }),
    JSON.stringify({ ...valid, statusText: 'emoji 😀' }),
    JSON.stringify({ ...valid, headers: [['x-a', 'bad\ud800']] }),
    JSON.stringify({ ...valid, headers: [['x-a', 'emoji 😀']] }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ version: 1, requestId: 'req-valid', statusCode: 200 }),
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => common.decodeVerserResponseMetadata(value),
      (error) => error.code === 'protocol-error',
    );
  }
});

test('local header validation accepts Latin-1 and rejects non-ByteString input as TypeError', () => {
  assert.deepEqual(common.validateLocalHeaders({ 'X-Cafe': 'café' }), { 'x-cafe': 'café' });
  for (const headers of [
    { 'bad name': 'value' },
    { 'x-control': 'line\nbreak' },
    { 'x-emoji': '😀' },
    { Connection: 'close' },
  ]) {
    assert.throws(() => common.validateLocalHeaders(headers), TypeError);
  }
});

test('shared response metadata sanitizes encoding and rejects locked decoding fields', () => {
  const base = { version: 1, requestId: 'req-locked', statusCode: 200 };
  const encoded = common.encodeVerserResponseMetadata({
    ...base,
    headers: [
      ['connection', 'x-private'],
      ['x-private', 'drop'],
      ['x-verser-response-metadata', 'drop'],
      ['x-keep', 'keep'],
    ],
  });
  assert.deepEqual(common.decodeVerserResponseMetadata(encoded).headers, [['x-keep', 'keep']]);
  for (const headers of [
    [['connection', 'close']],
    [['transfer-encoding', 'chunked']],
    [['x-verser-response-metadata', 'spoof']],
    [
      ['connection', 'x-private'],
      ['x-private', 'spoof'],
    ],
  ]) {
    assert.throws(
      () => common.decodeVerserResponseMetadata(JSON.stringify({ ...base, headers })),
      (error) => error.code === 'protocol-error',
    );
  }
});

test('shared response classifier distinguishes metadata application responses from transport errors', () => {
  const valid = common.encodeVerserResponseMetadata({
    version: 1,
    requestId: 'req-classify',
    statusCode: 500,
    headers: [],
  });
  assert.deepEqual(common.classifyVerserResponseMetadata(204, 'req-classify', []), {
    type: 'application-response',
  });
  assert.deepEqual(common.classifyVerserResponseMetadata(502, 'req-classify', undefined), {
    type: 'transport-error',
  });
  assert.equal(
    common.classifyVerserResponseMetadata(500, 'req-classify', [valid]).metadata.statusCode,
    500,
  );
  for (const values of [
    [valid, valid],
    ['not-json'],
    [
      common.encodeVerserResponseMetadata({
        version: 1,
        requestId: 'wrong',
        statusCode: 500,
        headers: [],
      }),
    ],
    [
      common.encodeVerserResponseMetadata({
        version: 1,
        requestId: 'req-classify',
        statusCode: 501,
        headers: [],
      }),
    ],
  ]) {
    assert.throws(
      () => common.classifyVerserResponseMetadata(500, 'req-classify', values),
      (error) => error.code === 'protocol-error',
    );
  }
});

test('shared routed response pairs override legacy maps and enforce final status/status text', () => {
  const response = common.createRoutedResponseEnvelope({
    requestId: 'req-pairs',
    statusCode: 200,
    statusText: '',
    headers: { contradictory: 'ignored' },
    headerPairs: [
      ['X-Value', 'first'],
      ['x-value', 'last'],
      ['connection', 'x-private'],
      ['x-private', 'drop'],
    ],
  });
  assert.deepEqual(response.headerPairs, [
    ['x-value', 'first'],
    ['x-value', 'last'],
  ]);
  assert.deepEqual(response.headers, { 'x-value': 'last' });
  for (const statusCode of [199, 600]) {
    assert.throws(
      () => common.createRoutedResponseEnvelope({ requestId: 'r', statusCode, headers: {} }),
      /final/i,
    );
  }
  assert.equal(
    common.createRoutedResponseEnvelope({ requestId: 'r', statusCode: 599, headers: {} })
      .statusCode,
    599,
  );
  for (const statusText of [
    'bad\rtext',
    'bad\ntext',
    'bad\0text',
    'bad\u007ftext',
    'a'.repeat(1025),
    'emoji 😀',
  ]) {
    assert.throws(
      () =>
        common.createRoutedResponseEnvelope({
          requestId: 'r',
          statusCode: 200,
          statusText,
          headers: {},
        }),
      /status text/i,
    );
  }
  assert.throws(
    () =>
      common.createRoutedResponseEnvelope({
        requestId: 'r',
        statusCode: 200,
        headers: {},
        headerPairs: [['x-emoji', 'emoji 😀']],
      }),
    (error) => error.code === 'protocol-error',
  );
});

test('shared pair-aware response sanitizer removes locked and connection-nominated fields', () => {
  const sanitized = common.sanitizeHttp2ResponseHeaderPairs([
    ['Set-Cookie', 'a=1'],
    ['connection', 'x-private, X-Remove'],
    ['x-private', 'private'],
    ['X-Remove', 'remove'],
    ['x-verser-response-metadata', 'spoof'],
    ['transfer-encoding', 'chunked'],
    ['set-cookie', 'b=2'],
  ]);

  assert.deepEqual(sanitized, [
    ['set-cookie', 'a=1'],
    ['set-cookie', 'b=2'],
  ]);
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

  for (const headers of [{ 'bad header': 'value' }, { 'x-emoji': '😀' }]) {
    assert.throws(() => common.normalizeHeaders(headers), TypeError);
  }

  assert.deepStrictEqual(common.validateRuntimeNeutralHeaders({ 'x-good': 'value' }), {
    'x-good': 'value',
  });
  assert.equal(common.isValidHeaderName('x-good'), true);
  assert.equal(common.isValidHeaderName('bad header'), false);
  assert.equal(common.isValidHeaderValue('safe\u0000value'), false);
  assert.equal(common.isValidHeaderValue('emoji 😀'), false);
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

test('shared sanitizeHttp2ResponseHeaders strips standard hop-by-hop response headers', () => {
  const sanitized = common.sanitizeHttp2ResponseHeaders({
    'content-type': 'text/plain',
    connection: 'close',
    'keep-alive': 'timeout=5',
    'proxy-authenticate': 'Basic',
    'proxy-authorization': 'token',
    te: 'trailers',
    trailer: 'x-custom',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    'x-end-to-end': 'preserved',
  });

  assert.equal(sanitized['content-type'], 'text/plain');
  assert.equal(sanitized['x-end-to-end'], 'preserved');
  assert.equal(sanitized.connection, undefined);
  assert.equal(sanitized['keep-alive'], undefined);
  assert.equal(sanitized['proxy-authenticate'], undefined);
  assert.equal(sanitized['proxy-authorization'], undefined);
  assert.equal(sanitized.te, undefined);
  assert.equal(sanitized.trailer, undefined);
  assert.equal(sanitized['transfer-encoding'], undefined);
  assert.equal(sanitized.upgrade, undefined);
});

test('shared sanitizeHttp2ResponseHeaders strips headers named in Connection value', () => {
  const sanitized = common.sanitizeHttp2ResponseHeaders({
    connection: 'x-foo, x-bar',
    'x-foo': 'should-be-stripped',
    'x-bar': 'also-stripped',
    'x-baz': 'preserved',
    'x-end-to-end': 'kept',
  });

  assert.equal(sanitized['x-baz'], 'preserved');
  assert.equal(sanitized['x-end-to-end'], 'kept');
  assert.equal(sanitized.connection, undefined);
  assert.equal(sanitized['x-foo'], undefined);
  assert.equal(sanitized['x-bar'], undefined);
});

test('shared sanitizeHttp2ResponseHeaders preserves end-to-end headers', () => {
  const sanitized = common.sanitizeHttp2ResponseHeaders({
    'content-type': 'application/json',
    'content-length': '42',
    'x-custom': 'value',
  });

  assert.equal(sanitized['content-type'], 'application/json');
  assert.equal(sanitized['content-length'], '42');
  assert.equal(sanitized['x-custom'], 'value');
});

test('shared sanitizeHttp2ResponseHeaders handles empty and absent Connection header', () => {
  const noConnection = common.sanitizeHttp2ResponseHeaders({
    'x-value': 'one',
    'transfer-encoding': 'chunked',
  });
  assert.equal(noConnection['x-value'], 'one');
  assert.equal(noConnection['transfer-encoding'], undefined);

  const emptyConnection = common.sanitizeHttp2ResponseHeaders({
    connection: '',
    'x-value': 'two',
  });
  assert.equal(emptyConnection['x-value'], 'two');
  assert.equal(emptyConnection.connection, undefined);
});

test('shared sanitizeHttp2ResponseHeaders handles array values', () => {
  const sanitized = common.sanitizeHttp2ResponseHeaders({
    'x-multi': ['a', 'b'],
    connection: 'close',
  });

  assert.equal(sanitized['x-multi'], 'a,b');
  assert.equal(sanitized.connection, undefined);
});

test('shared legacy response sanitizer preserves surviving map casing and removes reserved metadata', () => {
  assert.deepEqual(
    common.sanitizeHttp2ResponseHeaders({
      'X-Case': 'preserved',
      'X-Verser-Response-Metadata': 'spoof',
    }),
    { 'X-Case': 'preserved' },
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

test('shared TLS normalizer enables soft client rejection only for an unauthorized-client handler', () => {
  const unauthorizedClientHandler = async () => undefined;

  assert.deepEqual(
    common.normalizeHostClientAuthTlsOptions({
      ca: clientCa.certificate,
      unauthorizedClientHandler,
    }),
    {
      ca: clientCa.certificate,
      requestCert: true,
      rejectUnauthorized: false,
      knownExtensionOids: [],
      unauthorizedClientHandler,
      unauthorizedClientMaxRequestBodyBytes: 64 * 1024,
      unauthorizedClientMaxResponseBodyBytes: 64 * 1024,
      unauthorizedClientRequestTimeoutMs: 5000,
      unauthorizedClientHandlerTimeoutMs: 5000,
    },
  );
});

test('shared unauthorized-client handler limits have bounded safe defaults', () => {
  assert.equal(common.DEFAULT_MAX_UNAUTHORIZED_CLIENT_REQUEST_BODY_BYTES, 64 * 1024);
  assert.equal(common.DEFAULT_MAX_UNAUTHORIZED_CLIENT_RESPONSE_BODY_BYTES, 64 * 1024);
  assert.equal(common.DEFAULT_UNAUTHORIZED_CLIENT_REQUEST_TIMEOUT_MS, 5000);
  assert.equal(common.DEFAULT_UNAUTHORIZED_CLIENT_HANDLER_TIMEOUT_MS, 5000);
});

test('shared TLS normalizer validates unauthorized-client handler limits', () => {
  assert.throws(
    () =>
      common.normalizeHostClientAuthTlsOptions({
        ca: clientCa.certificate,
        unauthorizedClientHandler: async () => undefined,
        unauthorizedClientMaxRequestBodyBytes: 0,
      }),
    /unauthorizedClientMaxRequestBodyBytes.*positive safe integer/i,
  );
});

test('shared TLS normalizer rejects an unauthorized-client handler without client trust material', () => {
  assert.throws(
    () =>
      common.normalizeHostClientAuthTlsOptions({
        unauthorizedClientHandler: async () => undefined,
      }),
    /unauthorized.*client.*handler.*(ca|trust)/i,
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

test('shared route lifecycle constants are exported', () => {
  assert.deepEqual(common.VERSER_ROUTE_LIFECYCLE_EVENT_TYPES, {
    added: 'added',
    removed: 'removed',
    changed: 'changed',
    degraded: 'degraded',
  });
  assert.deepEqual(common.VERSER_ROUTE_EVENT_REASONS, {
    registered: 'registered',
    revoked: 'revoked',
    disconnected: 'disconnected',
    reconnected: 'reconnected',
    restored: 'restored',
    timeout: 'timeout',
    updated: 'updated',
  });
  assert.equal(common.DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS, 5000);
  assert.equal(common.VERSER_GUEST_REVOCATION_PATH, '/verser/guest/revoke');
  assert.equal(common.VERSER_LIFECYCLE_EVENTS.routeRevoked, 'route-revoked');
  assert.equal(common.VERSER_LIFECYCLE_EVENTS.routeDegraded, 'route-degraded');
  assert.equal(common.VERSER_LIFECYCLE_EVENTS.routeRestored, 'route-restored');
});

test('shared route lifecycle control frame preserves event types and reasons', () => {
  const frame = common.createBrokerRouteLifecycleControlFrame([
    {
      type: 'added',
      targetId: 'guest-alpha',
      domain: 'alpha.verser.test',
      reason: 'registered',
      generation: { generationId: 'gen-1' },
    },
    {
      type: 'removed',
      targetId: 'guest-alpha',
      domain: 'alpha.verser.test',
      reason: 'revoked',
    },
    {
      type: 'changed',
      targetId: 'guest-alpha',
      domain: 'alpha.verser.test',
      reason: 'restored',
    },
    {
      type: 'degraded',
      targetId: 'guest-alpha',
      domain: 'alpha.verser.test',
      reason: 'disconnected',
    },
  ]);

  assert.equal(frame.type, 'route-lifecycle');
  assert.equal(frame.events.length, 4);
  assert.equal(frame.events[0].type, 'added');
  assert.equal(frame.events[0].reason, 'registered');
  assert.equal(frame.events[0].generation.generationId, 'gen-1');
  assert.equal(frame.events[1].type, 'removed');
  assert.equal(frame.events[1].reason, 'revoked');
  assert.equal(frame.events[2].type, 'changed');
  assert.equal(frame.events[2].reason, 'restored');
  assert.equal(frame.events[3].type, 'degraded');
  assert.equal(frame.events[3].reason, 'disconnected');
  assert.equal(frame.events[3].generation, undefined);
});

test('shared route lifecycle control frame validates event type and reason', () => {
  assert.throws(
    () =>
      common.createBrokerRouteLifecycleControlFrame([
        { type: 'unknown', targetId: 'g', domain: 'd' },
      ]),
    /Invalid route lifecycle event type/,
  );
  assert.throws(
    () =>
      common.createBrokerRouteLifecycleControlFrame([
        { type: 'added', targetId: 'g', domain: 'd', reason: 'unknown-reason' },
      ]),
    /Invalid route lifecycle event reason/,
  );
  assert.throws(
    () =>
      common.createBrokerRouteLifecycleControlFrame([{ type: 'added', targetId: '', domain: 'd' }]),
    /targetId must not be empty/,
  );
  assert.throws(
    () =>
      common.createBrokerRouteLifecycleControlFrame([{ type: 'added', targetId: 'g', domain: '' }]),
    /domain must not be empty/,
  );
});

test('shared broker control frame union includes route lifecycle frame', () => {
  const routesFrame = common.createBrokerRoutesControlFrame([
    { targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);
  const lifecycleFrame = common.createBrokerRouteLifecycleControlFrame([
    { type: 'added', targetId: 'guest-alpha', domain: 'alpha.verser.test' },
  ]);

  // Both frame shapes should be valid control frames
  assert.equal(routesFrame.type, 'routes');
  assert.equal(lifecycleFrame.type, 'route-lifecycle');
  assert.equal(lifecycleFrame.events.length, 1);
  assert.equal(lifecycleFrame.events[0].type, 'added');

  // Legacy broker route compatibility preserved
  assert.deepEqual(routesFrame, {
    type: 'routes',
    routes: [{ targetId: 'guest-alpha', domain: 'alpha.verser.test' }],
  });
});

test('shared guest revocation request validates domains', () => {
  const request = common.createGuestRevocationRequest({
    domains: ['alpha.verser.test', 'beta.verser.test'],
  });

  assert.deepEqual(request.domains, ['alpha.verser.test', 'beta.verser.test']);

  assert.throws(() => common.createGuestRevocationRequest({ domains: [] }), /at least one domain/);
  assert.throws(
    () => common.createGuestRevocationRequest({ domains: [''] }),
    /domain must not be empty/,
  );
});

test('shared guest revocation response shapes are stable', () => {
  const ack = common.createGuestRevocationResponse({ status: 'ack' });
  assert.deepEqual(ack, { status: 'ack' });

  const partial = common.createGuestRevocationResponse({
    status: 'partial',
    message: 'Some domains failed',
    failedDomains: [{ domain: 'alpha.verser.test', error: 'Not found' }],
  });
  assert.deepEqual(partial, {
    status: 'partial',
    message: 'Some domains failed',
    failedDomains: [{ domain: 'alpha.verser.test', error: 'Not found' }],
  });

  const error = common.createGuestRevocationResponse({
    status: 'error',
    message: 'Request rejected',
  });
  assert.deepEqual(error, {
    status: 'error',
    message: 'Request rejected',
  });

  assert.throws(
    () => common.createGuestRevocationResponse({ status: 'invalid' }),
    /Invalid revocation response status/,
  );
});

test('shared guest revocation response omits optional fields when empty', () => {
  const ack = common.createGuestRevocationResponse({ status: 'ack' });
  assert.equal(ack.message, undefined);
  assert.equal(ack.failedDomains, undefined);

  const withEmptyFailed = common.createGuestRevocationResponse({
    status: 'ack',
    failedDomains: [],
  });
  assert.equal(withEmptyFailed.failedDomains, undefined);
});

test('shared route generation metadata is created with default and custom ids', () => {
  const gen = common.createVerserRouteGeneration();
  assert.ok(gen.generationId);
  assert.ok(gen.generationId.startsWith('gen-'));
  assert.equal(gen.sessionId, undefined);

  const genCustom = common.createVerserRouteGeneration({
    generationId: 'gen-42',
    sessionId: 'session-abc',
  });
  assert.equal(genCustom.generationId, 'gen-42');
  assert.equal(genCustom.sessionId, 'session-abc');

  const genNoSession = common.createVerserRouteGeneration({
    generationId: 'gen-7',
  });
  assert.equal(genNoSession.generationId, 'gen-7');
  assert.equal(genNoSession.sessionId, undefined);

  assert.throws(
    () => common.createVerserRouteGeneration({ generationId: '' }),
    /generationId must be a non-empty string/,
  );
});

test('shared route generation metadata propagates through lifecycle events', () => {
  const event = common.createRouteLifecycleEvent({
    type: 'added',
    targetId: 'guest-alpha',
    domain: 'alpha.verser.test',
    generation: { generationId: 'gen-1', sessionId: 'sess-1' },
  });

  assert.equal(event.generation.generationId, 'gen-1');
  assert.equal(event.generation.sessionId, 'sess-1');

  const eventNoGen = common.createRouteLifecycleEvent({
    type: 'added',
    targetId: 'guest-alpha',
    domain: 'beta.verser.test',
  });

  assert.equal(eventNoGen.generation, undefined);
});

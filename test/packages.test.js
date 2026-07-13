const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8');
}

function listFiles(relativePath) {
  const directoryPath = path.join(rootDirectory, relativePath);
  return fs.readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      return listFiles(entryPath);
    }
    return entryPath;
  });
}

function assertSingleFileDist(packageDirectory) {
  const distFiles = listFiles(path.join(packageDirectory, 'dist')).filter(
    (filePath) => !filePath.endsWith('.map') && !filePath.endsWith('.tsbuildinfo'),
  );

  assert.deepEqual(distFiles.sort(), [
    path.join(packageDirectory, 'dist/LICENSE'),
    path.join(packageDirectory, 'dist/index.d.ts'),
    path.join(packageDirectory, 'dist/index.js'),
  ]);
}

function assertDeclarationOmits(packageDirectory, patterns) {
  const declaration = readText(path.join(packageDirectory, 'dist/index.d.ts'));
  for (const pattern of patterns) {
    assert.doesNotMatch(declaration, pattern);
  }
}

function assertNoRuntimeSourcesMatch(patterns) {
  const packageDirectory = path.join(rootDirectory, 'packages');
  const packageDirectories = fs
    .readdirSync(packageDirectory, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => `packages/${dirent.name}`);

  for (const packagePath of packageDirectories) {
    const sourceFiles = listFiles(path.join(packagePath, 'src'));
    for (const filePath of sourceFiles.filter((value) => value.endsWith('.ts'))) {
      const source = readText(filePath);
      for (const pattern of patterns) {
        assert.doesNotMatch(source, pattern);
      }
    }
  }
}

test('@signicode/verser-common package exposes common foundations', () => {
  const packageManifest = readJson('packages/verser-common/package.json');
  const commonPackage = require('../packages/verser-common/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser-common');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(commonPackage).sort(), [
    'DEFAULT_DEGRADED_ROUTE_TIMEOUT_MS',
    'DEFAULT_MAX_ENVELOPE_METADATA_BYTES',
    'VERSER_COMMON_PACKAGE_NAME',
    'VERSER_ENVELOPE_PREFIX_BYTES',
    'VERSER_ENVELOPE_TYPES',
    'VERSER_ENVELOPE_VERSION',
    'VERSER_GUEST_REVOCATION_PATH',
    'VERSER_LEASE_ACQUIRE_TIMEOUT_HEADER',
    'VERSER_LIFECYCLE_EVENTS',
    'VERSER_ROUTE_EVENT_REASONS',
    'VERSER_ROUTE_LIFECYCLE_EVENT_TYPES',
    'VWS_MAX_FRAME_BYTES',
    'VerserError',
    'createBrokerRouteLifecycleControlFrame',
    'createBrokerRoutesControlFrame',
    'createCommonBrokerRequest',
    'createFederatedRouteRegistration',
    'createFederatedRoutesControlFrame',
    'createGuestId',
    'createGuestRevocationRequest',
    'createGuestRevocationResponse',
    'createPeerId',
    'createRouteLifecycleEvent',
    'createRoutedDomainRegistration',
    'createRoutedRequestEnvelope',
    'createRoutedResponseEnvelope',
    'createVerserEnvelopeParser',
    'createVerserError',
    'createVerserHostFederationHandshake',
    'createVerserHostId',
    'createVerserRouteGeneration',
    'decodeHeaderMap',
    'decodeVwsFrame',
    'encodeJsonLine',
    'encodeVerserEnvelope',
    'encodeVwsFrame',
    'exceedsFederatedRouteHopLimit',
    'extractCertificateIdentity',
    'flattenHeaderValue',
    'flattenVerserHeaders',
    'fromHttp2RequestHeaders',
    'fromHttp2ResponseHeaders',
    'getCertificateFingerprint',
    'getErrorMessage',
    'isAsyncIterableBody',
    'isFederatedRouteLoop',
    'isIterableBody',
    'isValidHeaderName',
    'isValidHeaderValue',
    'normalizeBrokerRequestBody',
    'normalizeClientTlsOptions',
    'normalizeHeaders',
    'normalizeHostClientAuthTlsOptions',
    'normalizeRequestHeaders',
    'normalizeServerTlsOptions',
    'parseLeaseAcquireTimeoutMs',
    'parseRegistrationRequest',
    'parseRegistrationResponse',
    'readExactly',
    'readLeaseRequestMetadataFromStream',
    'readLeaseResponseMetadataFromStream',
    'readNdjsonLines',
    'readVerserEnvelopeFromStream',
    'readVwsLine',
    'resolveRouteForHostname',
    'resolveRouteForUrl',
    'sanitizeHttp2ResponseHeaders',
    'stripHttp2PseudoHeaders',
    'toHttp2RequestHeaders',
    'toHttp2ResponseHeaders',
    'toVerserError',
    'toVerserErrorCode',
    'toVerserHttpErrorResponse',
    'validateRuntimeNeutralHeaders',
    'validateVerserHeaders',
    'verifyPinnedCertificate',
    'verserErrorFromResponseBody',
  ]);
  assert.equal(commonPackage.VERSER_COMMON_PACKAGE_NAME, '@signicode/verser-common');
  assert.equal(commonPackage.createDevelopmentTlsCertificate, undefined);
  assert.equal(
    readText('packages/verser-common/src/index.ts').includes('createDevelopmentTlsCertificate'),
    false,
  );
  assert.doesNotMatch(
    readText('packages/verser-common/src/index.ts'),
    /createDevelopmentTlsCertificate/,
  );
  assert.doesNotMatch(
    readText('packages/verser-common/dist/index.js'),
    /createDevelopmentTlsCertificate|DEVELOPMENT_CERTIFICATE|DEVELOPMENT_PRIVATE_KEY/,
  );
  assertDeclarationOmits('packages/verser-common', [
    /createDevelopmentTlsCertificate/,
    /DEVELOPMENT_CERTIFICATE/,
    /DEVELOPMENT_PRIVATE_KEY/,
  ]);
  assertNoRuntimeSourcesMatch([
    /createDevelopmentTlsCertificate/,
    /DEVELOPMENT_CERTIFICATE/,
    /DEVELOPMENT_PRIVATE_KEY/,
  ]);
  assertSingleFileDist('packages/verser-common');
});

test('@signicode/verser2-host package exposes Host API', () => {
  const packageManifest = readJson('packages/verser2-host/package.json');
  const hostPackage = require('../packages/verser2-host/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser2-host');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(hostPackage).sort(), [
    'HostRouteRegistry',
    'VERSER2_HOST_PACKAGE_NAME',
    'createHostRouteRegistry',
    'createVerserHost',
  ]);
  assert.equal(hostPackage.VERSER2_HOST_PACKAGE_NAME, '@signicode/verser2-host');
  assert.equal(typeof hostPackage.createVerserHost, 'function');

  const host = hostPackage.createVerserHost({ port: 0 });
  assert.equal(typeof host.attachLocalGuest, 'function');
  assert.equal(typeof host.attachLocalBroker, 'function');

  const hostDeclarations = readText('packages/verser2-host/dist/index.d.ts');
  assert.match(hostDeclarations, /VerserLocalGuestRequestListener/);
  assert.match(hostDeclarations, /VerserLocalGuestOptions/);
  assert.match(hostDeclarations, /VerserLocalBrokerOptions/);
  assert.match(hostDeclarations, /VerserLocalBrokerRequest/);
  assert.match(hostDeclarations, /VerserLocalBrokerResponse/);
  assert.match(hostDeclarations, /VerserLocalGuestResponse/);
  assert.match(hostDeclarations, /VerserLocalGuestHandle/);
  assert.match(hostDeclarations, /VerserLocalBrokerHandle/);
  assert.match(hostDeclarations, /setHeader\([^)]*\):[^;]*this/);
  assert.match(hostDeclarations, /writeHead\([^)]*\):[^;]*this/);
  assert.match(hostDeclarations, /end\([^)]*\):[^;]*this/);
  assert.match(hostDeclarations, /leaseAcquireTimeoutMs\?: number/);

  assertSingleFileDist('packages/verser2-host');
  assertDeclarationOmits('packages/verser2-host', [/NodeHttp2VerserHost/]);
});

test('@signicode/verser2-guest-js-common package exposes JS Guest foundations', () => {
  const packageManifest = readJson('packages/verser2-guest-js-common/package.json');
  const jsCommonPackage = require('../packages/verser2-guest-js-common/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser2-guest-js-common');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(jsCommonPackage).sort(), [
    'AbstractVerserFetchDispatcher',
    'VERSER2_GUEST_JS_COMMON_PACKAGE_NAME',
    'appendQueryString',
    'createCommonBrokerRequest',
    'flattenHeaderValue',
    'normalizeHeaders',
    'resolveRouteForHostname',
    'resolveRouteForUrl',
  ]);
  assert.equal(
    jsCommonPackage.VERSER2_GUEST_JS_COMMON_PACKAGE_NAME,
    '@signicode/verser2-guest-js-common',
  );
  assertSingleFileDist('packages/verser2-guest-js-common');
});

test('@signicode/verser2-guest-node package exposes Node Guest API', () => {
  const packageManifest = readJson('packages/verser2-guest-node/package.json');
  const guestPackage = require('../packages/verser2-guest-node/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser2-guest-node');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(guestPackage).sort(), [
    'MinimalIncomingMessage',
    'MinimalServerResponse',
    'VERSER2_GUEST_NODE_PACKAGE_NAME',
    'VerserWebSocket',
    'createVerserBroker',
    'createVerserNodeGuest',
  ]);
  assert.equal(guestPackage.VERSER2_GUEST_NODE_PACKAGE_NAME, '@signicode/verser2-guest-node');
  assert.equal(typeof guestPackage.createVerserBroker, 'function');
  assert.equal(typeof guestPackage.createVerserNodeGuest, 'function');

  const broker = guestPackage.createVerserBroker({
    hostUrl: 'https://localhost:1',
    brokerId: 'package-test-broker',
  });
  assert.equal(typeof broker.createDispatcher, 'function');
  assert.equal(typeof broker.createFetch, 'function');
  assertSingleFileDist('packages/verser2-guest-node');
  assertDeclarationOmits('packages/verser2-guest-node', [
    /BrokerControlFrame/,
    /BrokerRequestRouter/,
    /DispatcherHandler/,
    /Http2VerserBroker/,
    /Http2VerserNodeGuest/,
    /NodeRequestListenerResponse/,
  ]);
  assert.match(
    readText('packages/verser2-guest-node/dist/index.d.ts'),
    /createVerserBroker\(options: VerserBrokerOptions\): VerserBroker/,
  );
});

test('@signicode/verser2-guest-bun package exposes Bun Guest and Broker API without internals', () => {
  const packageManifest = readJson('packages/verser2-guest-bun/package.json');
  const guestPackage = require('../packages/verser2-guest-bun/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser2-guest-bun');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(guestPackage).sort(), [
    'VERSER2_GUEST_BUN_PACKAGE_NAME',
    'createVerserBroker',
    'createVerserBunGuest',
  ]);
  assert.equal(guestPackage.VERSER2_GUEST_BUN_PACKAGE_NAME, '@signicode/verser2-guest-bun');
  assert.equal(typeof guestPackage.createVerserBunGuest, 'function');
  assert.equal(typeof guestPackage.createVerserBroker, 'function');
  assert.equal('dispatchVerserBunRequest' in guestPackage, false);
  assert.equal('__internal' in guestPackage, false);
  assert.doesNotMatch(
    readText('packages/verser2-guest-bun/dist/index.d.ts'),
    /dispatchVerserBunRequest|__internal/,
  );
  assertDeclarationOmits('packages/verser2-guest-bun', [
    /VerserBunDispatchServer/,
    /VerserBunDispatchRequest/,
    /VerserBunDispatchResponse/,
    /VerserBunDispatchRequestHandler/,
  ]);
  const lifecycleEvents = [];
  const guest = guestPackage.createVerserBunGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'bun-package-test',
  });
  const broker = guestPackage.createVerserBroker({
    hostUrl: 'https://localhost:1',
    brokerId: 'bun-package-broker-test',
  });
  const unsubscribe = guest.onLifecycle((event) => lifecycleEvents.push(event));

  assert.equal(guest.connected, false);
  assert.equal(typeof broker.connect, 'function');
  assert.equal(typeof broker.close, 'function');
  assert.equal(typeof broker.request, 'function');
  assert.equal(typeof broker.getRoutes, 'function');
  assert.equal(typeof broker.waitForRoute, 'function');
  assert.equal(typeof broker.createAgent, 'function');
  assert.equal(typeof broker.createDispatcher, 'function');
  assert.equal(typeof broker.createFetch, 'function');
  assert.equal(guest.attach({ fetch: () => new Response() }), guest);
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(lifecycleEvents.length, 0);
  assertSingleFileDist('packages/verser2-guest-bun');
});

test('routed body transport no longer contains bodyBase64 control-frame paths', () => {
  const routedSources = [
    ...listFiles('packages/verser2-host/src'),
    ...listFiles('packages/verser2-guest-node/src'),
  ].filter((filePath) => filePath.endsWith('.ts'));

  for (const sourcePath of routedSources) {
    assert.doesNotMatch(
      readText(sourcePath),
      /bodyBase64|response-body|response-start|response-end/,
    );
  }
});

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

test('@signicode/verser-common package exposes common foundations', () => {
  const packageManifest = readJson('packages/verser-common/package.json');
  const commonPackage = require('../packages/verser-common/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser-common');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(commonPackage).sort(), [
    'DEFAULT_MAX_ENVELOPE_METADATA_BYTES',
    'VERSER_COMMON_PACKAGE_NAME',
    'VERSER_ENVELOPE_PREFIX_BYTES',
    'VERSER_ENVELOPE_TYPES',
    'VERSER_ENVELOPE_VERSION',
    'VERSER_LIFECYCLE_EVENTS',
    'VerserError',
    'createDevelopmentTlsCertificate',
    'createGuestId',
    'createPeerId',
    'createRoutedDomainRegistration',
    'createRoutedRequestEnvelope',
    'createRoutedResponseEnvelope',
    'createVerserEnvelopeParser',
    'createVerserError',
    'encodeVerserEnvelope',
    'fromHttp2RequestHeaders',
    'fromHttp2ResponseHeaders',
    'getCertificateFingerprint',
    'readExactly',
    'readLeaseRequestMetadataFromStream',
    'readLeaseResponseMetadataFromStream',
    'readNdjsonLines',
    'readVerserEnvelopeFromStream',
    'toHttp2RequestHeaders',
    'toHttp2ResponseHeaders',
    'validateVerserHeaders',
    'verifyPinnedCertificate',
  ]);
  assert.equal(commonPackage.VERSER_COMMON_PACKAGE_NAME, '@signicode/verser-common');
});

test('@signicode/verser2-host package exposes Host API', () => {
  const packageManifest = readJson('packages/verser2-host/package.json');
  const hostPackage = require('../packages/verser2-host/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser2-host');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(hostPackage).sort(), [
    'VERSER2_HOST_PACKAGE_NAME',
    'createVerserHost',
  ]);
  assert.equal(hostPackage.VERSER2_HOST_PACKAGE_NAME, '@signicode/verser2-host');
  assert.equal(typeof hostPackage.createVerserHost, 'function');
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
    'createCommonBrokerRequest',
    'flattenHeaderValue',
    'normalizeHeaders',
    'resolveRouteForHostname',
  ]);
  assert.equal(
    jsCommonPackage.VERSER2_GUEST_JS_COMMON_PACKAGE_NAME,
    '@signicode/verser2-guest-js-common',
  );
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
});

test('routed body transport no longer contains bodyBase64 control-frame paths', () => {
  const routedSources = [
    'packages/verser2-host/src/index.ts',
    'packages/verser2-guest-node/src/index.ts',
  ];

  for (const sourcePath of routedSources) {
    assert.doesNotMatch(
      readText(sourcePath),
      /bodyBase64|response-body|response-start|response-end/,
    );
  }
});

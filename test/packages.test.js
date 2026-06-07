const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
}

test('@signicode/verser-common package exposes common foundations', () => {
  const packageManifest = readJson('packages/verser-common/package.json');
  const commonPackage = require('../packages/verser-common/dist/index.js');

  assert.equal(packageManifest.name, '@signicode/verser-common');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(commonPackage).sort(), [
    'VERSER_COMMON_PACKAGE_NAME',
    'VERSER_LIFECYCLE_EVENTS',
    'VerserError',
    'createDevelopmentTlsCertificate',
    'createGuestId',
    'createPeerId',
    'createRoutedDomainRegistration',
    'createRoutedRequestEnvelope',
    'createRoutedResponseEnvelope',
    'createVerserError',
    'fromHttp2RequestHeaders',
    'fromHttp2ResponseHeaders',
    'getCertificateFingerprint',
    'toHttp2RequestHeaders',
    'toHttp2ResponseHeaders',
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
});

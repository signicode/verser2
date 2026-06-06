const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
}

test('verser2-host package exposes initial host metadata', () => {
  const packageManifest = readJson('packages/verser2-host/package.json');
  const hostPackage = require('../packages/verser2-host/dist/index.js');

  assert.equal(packageManifest.name, 'verser2-host');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(hostPackage).sort(), ['VERSER2_HOST_PACKAGE_NAME']);
  assert.equal(hostPackage.VERSER2_HOST_PACKAGE_NAME, 'verser2-host');
});

test('verser2-guest-node package exposes initial Node guest metadata', () => {
  const packageManifest = readJson('packages/verser2-guest-node/package.json');
  const guestPackage = require('../packages/verser2-guest-node/dist/index.js');

  assert.equal(packageManifest.name, 'verser2-guest-node');
  assert.equal(packageManifest.main, 'dist/index.js');
  assert.equal(packageManifest.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(guestPackage).sort(), ['VERSER2_GUEST_NODE_PACKAGE_NAME']);
  assert.equal(guestPackage.VERSER2_GUEST_NODE_PACKAGE_NAME, 'verser2-guest-node');
});

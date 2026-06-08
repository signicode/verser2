const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');
const packageManifestPath = path.join(rootDirectory, 'package.json');
const scriptPath = path.join(rootDirectory, 'scripts', 'test-package-tarballs.js');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('package tarball automated test command is exposed as an npm script', () => {
  const packageManifest = readJson(packageManifestPath);

  assert.equal(
    packageManifest.scripts['test:package-tarballs'],
    'node ./scripts/test-package-tarballs.js',
  );
  assert.ok(fs.existsSync(scriptPath), 'Expected scripts/test-package-tarballs.js to exist.');
});

test('package tarball automated test runner documents behavior test groups', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /includedGroups/);
  assert.match(script, /excludedGroups/);
  assert.match(script, /consumer-imports/);
  assert.match(script, /common-protocol-envelope/);
  assert.match(script, /host-guest-broker-smoke/);
});

test('package tarball automated test runner installs tarballs into a temp consumer', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /npm['"], \[['"]pack/);
  assert.match(script, /npm['"], \[['"]install/);
  assert.match(script, /mkdtempSync/);
  assert.match(script, /node_modules/);
  assert.match(script, /require\.resolve\([^)]*@signicode\/verser-common/);
});

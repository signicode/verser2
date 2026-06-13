const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

test('development docs document workspace setup commands', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');
  const developmentDocs = fs.readFileSync(path.join(rootDirectory, 'docs/development.md'), 'utf8');

  assert.match(readme, /docs\/development\.md/);
  assert.match(developmentDocs, /# Development guide/);
  assert.match(developmentDocs, /npm install/);
  assert.match(developmentDocs, /npm run build/);
  assert.match(developmentDocs, /npm test/);
  assert.match(developmentDocs, /npm run lint/);
  assert.match(developmentDocs, /@signicode\/verser-common/);
  assert.match(developmentDocs, /packages\/verser-common/);
  assert.match(developmentDocs, /@signicode\/verser2-host/);
  assert.match(developmentDocs, /packages\/verser2-host/);
  assert.match(developmentDocs, /@signicode\/verser2-guest-node/);
  assert.match(developmentDocs, /packages\/verser2-guest-node/);
  assert.match(developmentDocs, /@signicode\/verser2-guest-bun/);
  assert.match(developmentDocs, /packages\/verser2-guest-bun/);
  assert.match(developmentDocs, /VERSER_PACKAGE_DOCS_REF/);
});

test('task docs document Bun Guest usage and non-listen behavior', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');
  const exposingDocs = fs.readFileSync(path.join(rootDirectory, 'docs/exposing-http.md'), 'utf8');
  const makingRequestsDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/making-requests.md'),
    'utf8',
  );

  assert.match(readme, /verser2-guest-bun/);
  assert.match(exposingDocs, /createVerserBunGuest/);
  assert.match(makingRequestsDocs, /createFetch/);
  assert.match(makingRequestsDocs, /createDispatcher/);
  assert.match(exposingDocs, /route advertisement/);
  assert.match(exposingDocs, /fetch\(request, server\)/);
  assert.doesNotMatch(exposingDocs, /dispatchVerserBunRequest/);
  assert.match(exposingDocs, /routes\s*:/);
  assert.match(exposingDocs, /WebSocket/i);
  assert.match(exposingDocs, /server\.upgrade\(request\)[\s\S]*`false`/i);
  assert.match(exposingDocs, /never needs\s+to call/i);
  assert.match(exposingDocs, /listen\(\)/);
});

test('Bun package README documents handler and entrypoint semantics', () => {
  const bunReadme = fs.readFileSync(
    path.join(rootDirectory, 'packages/verser2-guest-bun/README.md'),
    'utf8',
  );

  assert.match(bunReadme, /## Basic usage/);
  assert.match(bunReadme, /VERSER2_GUEST_BUN_PACKAGE_NAME/);
  assert.match(bunReadme, /createVerserBunGuest/);
  assert.match(bunReadme, /createVerserBroker/);
  assert.match(bunReadme, /createAgent\(\)/);
  assert.match(bunReadme, /createDispatcher\(\)/);
  assert.match(bunReadme, /createFetch\(\)/);
  assert.match(bunReadme, /fetch\(request\)/);
  assert.doesNotMatch(bunReadme, /dispatchVerserBunRequest/);
  assert.match(bunReadme, /Bun-facing Broker wrapper/i);
  assert.match(bunReadme, /Fetch-style request bodies/i);
  assert.match(bunReadme, /WebSocket/i);
  assert.match(bunReadme, /does \*\*not\*\* call/i);
  assert.match(bunReadme, /`Bun\.serve\(\)`/);
  assert.match(bunReadme, /`listen\(\)`/);
  assert.match(
    bunReadme,
    /upgrade forwarding is \*\*not\*\* implemented|server\.upgrade\(request\)[\s\S]*returns `false`/i,
  );
});

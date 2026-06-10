const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

test('README documents workspace setup commands', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');

  assert.match(readme, /## Development Setup/);
  assert.match(readme, /npm install/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /npm test/);
  assert.match(readme, /npm run lint/);
  assert.match(readme, /@signicode\/verser-common/);
  assert.match(readme, /packages\/verser-common/);
  assert.match(readme, /@signicode\/verser2-host/);
  assert.match(readme, /packages\/verser2-host/);
  assert.match(readme, /@signicode\/verser2-guest-node/);
  assert.match(readme, /packages\/verser2-guest-node/);
  assert.match(readme, /@signicode\/verser2-guest-bun/);
  assert.match(readme, /packages\/verser2-guest-bun/);
});

test('root README documents Bun Guest usage and non-listen behavior', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');

  assert.match(readme, /## Bun Guest usage/);
  assert.match(readme, /createVerserBunGuest/);
  assert.match(readme, /createVerserBroker/);
  assert.match(readme, /broker.createAgent/);
  assert.match(readme, /broker\.createDispatcher/);
  assert.match(readme, /broker\.createFetch/);
  assert.match(readme, /route-advertis|route advertisement/);
  assert.match(readme, /fetch\(request, server\)/);
  assert.match(readme, /route-advert|route advert/);
  assert.match(readme, /Request bodies can be routed/i);
  assert.doesNotMatch(readme, /dispatchVerserBunRequest/);
  assert.match(readme, /routes\s*:/);
  assert.match(readme, /WebSocket upgrades are intentionally not forwarded/i);
  assert.match(readme, /server\.upgrade\(\)[\s\S]*`false`/i);
  assert.match(readme, /Bun Guests do not call/i);
  assert.match(readme, /listen\(\)/);
});

test('Bun package README documents handler and entrypoint semantics', () => {
  const bunReadme = fs.readFileSync(
    path.join(rootDirectory, 'packages/verser2-guest-bun/README.md'),
    'utf8',
  );

  assert.match(bunReadme, /## Bun Guest usage/);
  assert.match(bunReadme, /VERSER2_GUEST_BUN_PACKAGE_NAME/);
  assert.match(bunReadme, /createVerserBunGuest/);
  assert.match(bunReadme, /createVerserBroker/);
  assert.match(bunReadme, /createAgent\(\)/);
  assert.match(bunReadme, /createDispatcher\(\)/);
  assert.match(bunReadme, /createFetch\(\)/);
  assert.match(bunReadme, /fetch\(request, server\)/);
  assert.doesNotMatch(bunReadme, /dispatchVerserBunRequest/);
  assert.match(bunReadme, /Node compatibility/i);
  assert.match(bunReadme, /Streaming behavior/i);
  assert.match(bunReadme, /WebSocket/i);
  assert.match(bunReadme, /does \*\*not\*\* call/i);
  assert.match(bunReadme, /`Bun\.serve\(\)`/);
  assert.match(bunReadme, /`listen\(\)`/);
  assert.match(
    bunReadme,
    /upgrade forwarding is not implemented|server\.upgrade\(request\) returns `false`/i,
  );
});

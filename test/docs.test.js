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
});

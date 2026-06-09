const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');
const packageDirectory = path.join(rootDirectory, 'packages', 'verser2-guest-python');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('Python Guest package scaffold is discoverable by npm workspace tooling', () => {
  const manifestPath = path.join(packageDirectory, 'package.json');

  assert.ok(fs.existsSync(manifestPath), 'Expected Python Guest package.json to exist');

  const manifest = readJson(manifestPath);
  assert.equal(manifest.name, '@signicode/verser2-guest-python');
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.main, 'dist/index.js');
  assert.equal(manifest.types, 'dist/index.d.ts');
  assert.equal(typeof manifest.scripts.build, 'string');
  assert.equal(typeof manifest.scripts.venv, 'string');
  assert.equal(typeof manifest.scripts.test, 'string');
  assert.equal(typeof manifest.scripts.lint, 'string');
});

test('Python Guest package includes Python packaging metadata and source layout', () => {
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'pyproject.toml')),
    'Expected pyproject.toml to exist',
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'src', 'verser2_guest_python', '__init__.py')),
    'Expected Python package source entrypoint to exist',
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'tests', 'test_scaffold.py')),
    'Expected Python package smoke tests to exist',
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'README.md')),
    'Expected Python package README to exist',
  );
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
}

test('root package declares npm workspace commands', () => {
  const packageManifest = readJson('package.json');

  assert.deepEqual(packageManifest.workspaces, ['packages/*']);
  assert.equal(packageManifest.scripts.build, 'tsc -b packages/*');
  assert.equal(packageManifest.scripts.test, 'node --test test/*.test.js');
  assert.equal(packageManifest.scripts.lint, 'biome check .');
});

test('root TypeScript configuration targets strict CommonJS ES2019 declarations', () => {
  const tsconfig = readJson('tsconfig.json');

  assert.equal(tsconfig.compilerOptions.target, 'ES2019');
  assert.equal(tsconfig.compilerOptions.module, 'CommonJS');
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.declaration, true);
  assert.equal(tsconfig.compilerOptions.noUnusedLocals, true);
});

test('Biome configuration is available for repository linting', () => {
  const biomeConfig = readJson('biome.json');

  assert.equal(biomeConfig.$schema, 'https://biomejs.dev/schemas/1.9.4/schema.json');
  assert.equal(biomeConfig.formatter.enabled, true);
  assert.equal(biomeConfig.linter.enabled, true);
});

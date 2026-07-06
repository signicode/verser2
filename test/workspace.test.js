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
  assert.equal(
    packageManifest.scripts.build,
    'npm run build --workspace=@signicode/verser-common && npm run build --workspace=@signicode/verser2-guest-js-common && npm run build --workspace=@signicode/verser2-guest-node && npm run build --workspace=@signicode/verser2-host && npm run build --workspace=@signicode/verser2-guest-bun && npm run build --workspace=@signicode/verser2-guest-python',
  );
  assert.equal(
    packageManifest.scripts.test,
    'npm run build && npm run stage:packages && node --test test/*.test.js',
  );
  assert.equal(packageManifest.scripts['test:bounded'], 'node ./scripts/run-bounded-tests.js');
  assert.equal(
    packageManifest.scripts['test:bounded:coverage'],
    'node ./scripts/run-bounded-tests.js --coverage',
  );
  assert.equal(packageManifest.scripts.lint, 'biome check .');
});

test('bounded test runner preserves full validation flow with default heap limits', () => {
  const runnerPath = path.join(rootDirectory, 'scripts/run-bounded-tests.js');

  assert.ok(fs.existsSync(runnerPath), 'Expected scripts/run-bounded-tests.js to exist.');

  const runnerSource = fs.readFileSync(runnerPath, 'utf8');

  assert.match(runnerSource, /DEFAULT_OLD_SPACE_SIZE_MB\s*=\s*512/);
  assert.match(runnerSource, /--max-old-space-size=\$\{oldSpaceSizeMb\}/);
  assert.match(runnerSource, /npm[\s\S]*run[\s\S]*build/);
  assert.match(runnerSource, /npm[\s\S]*run[\s\S]*stage:packages/);
  assert.match(runnerSource, /DEFAULT_TEST_FILES\s*=\s*\['test\/\*\.test\.js'\]/);
  assert.match(runnerSource, /DEFAULT_MEMORY_LEAK_BYTES\s*=\s*1024\s*\*\s*1024/);
  assert.match(
    runnerSource,
    /testArgs\s*=\s*\['--expose-gc',\s*'--test',\s*'--test-concurrency=1'\]/,
  );
  assert.match(runnerSource, /VERSER_TEST_MEMORY_GUARD:\s*'1'/);
  assert.match(runnerSource, /VERSER_TEST_MEMORY_LEAK_BYTES:\s*String\(options\.memoryLeakBytes\)/);
  assert.match(runnerSource, /runCommand\(process\.execPath, testArgs/);
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

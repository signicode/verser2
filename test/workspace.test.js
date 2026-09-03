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
  assert.equal(packageManifest.scripts.test, 'npm run test:bounded');
  assert.equal(packageManifest.scripts['test:bounded'], 'node ./scripts/run-bounded-tests.js');
  assert.equal(
    packageManifest.scripts['test:bounded:staged'],
    'node ./scripts/run-bounded-tests.js --skip-build-stage --live-timestamps',
  );
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
  assert.match(runnerSource, /readdirSync\([\s\S]*test[\s\S]*\.test\.js/);
  assert.match(runnerSource, /DEFAULT_MEMORY_LEAK_BYTES\s*=\s*1024\s*\*\s*1024/);
  assert.match(
    runnerSource,
    /--test-concurrency=\$\{options\.testConcurrency\}[\s\S]*test-timeout=\$\{TEST_TIMEOUT_MS\}/,
  );
  assert.match(runnerSource, /TEST_TIMEOUT_MS\s*=\s*10_000/);
  assert.match(runnerSource, /partitionTestFiles/);
  assert.match(runnerSource, /VERSER_TEST_MEMORY_GUARD:\s*'1'/);
  assert.match(runnerSource, /VERSER_TEST_MEMORY_LEAK_BYTES:\s*String\(options\.memoryLeakBytes\)/);
  assert.match(runnerSource, /runOne\(process\.execPath, partitionArgs/);
});

test('bounded runner partitions one and two focused files without discovery', () => {
  const runner = require('../scripts/run-bounded-tests.js');
  assert.deepEqual(
    runner.partitionTestFiles(['test/one.test.js']).filter((p) => p.length > 0),
    [['test/one.test.js']],
  );
  assert.deepEqual(runner.partitionTestFiles(['test/a.test.js', 'test/b.test.js']), [
    ['test/a.test.js'],
    ['test/b.test.js'],
  ]);
});

test('bounded runner rejects timeout bypasses and option-like test paths', () => {
  const runner = require('../scripts/run-bounded-tests.js');
  assert.throws(() => runner.parseArgs(['--test-timeout=1']), /timeout bypasses/i);
  assert.throws(() => runner.parseArgs(['--', '--test-timeout=1']), /hyphen|timeout/i);
});

test('guarded test wrapper supports per-test memory allowances', () => {
  const guardedTestPath = path.join(rootDirectory, 'test/support/guarded-test.cjs');

  assert.ok(fs.existsSync(guardedTestPath), 'Expected test/support/guarded-test.cjs to exist.');

  const guardedTestSource = fs.readFileSync(guardedTestPath, 'utf8');

  assert.match(
    guardedTestSource,
    /memoryLeakBytes\s*\?\?\s*process\.env\.VERSER_TEST_MEMORY_LEAK_BYTES/,
  );
  assert.match(guardedTestSource, /const \{ memoryLeakBytes, \.\.\.nodeTestOptions \} = options/);
  assert.match(guardedTestSource, /nodeTest\.test\(name, nodeTestOptions/);
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

test('bounded runner parses and validates test concurrency and staged/live flags', () => {
  const runner = require('../scripts/run-bounded-tests.js');

  const defaults = runner.parseArgs([]);
  assert.equal(defaults.testConcurrency, 1);
  assert.equal(defaults.skipBuildStage, false);
  assert.equal(defaults.liveTimestamps, false);

  assert.equal(runner.parseArgs(['--test-concurrency', '4']).testConcurrency, 4);
  assert.equal(runner.parseArgs(['--test-concurrency=2']).testConcurrency, 2);
  assert.equal(runner.parseArgs(['--skip-build-stage']).skipBuildStage, true);
  assert.equal(runner.parseArgs(['--live-timestamps']).liveTimestamps, true);

  assert.throws(() => runner.parseArgs(['--test-concurrency']), /Missing value/);
  assert.throws(() => runner.parseArgs(['--test-concurrency=0']), /positive integer/);
  assert.throws(() => runner.parseArgs(['--test-concurrency', '-1']), /positive integer/);
  assert.throws(() => runner.parseArgs(['--test-concurrency=1.5']), /positive integer/);
  assert.throws(() => runner.parseArgs(['--test-concurrency=abc']), /positive integer/);
});

test('bounded runner preflight requires the complete staged publish set per package', () => {
  const runner = require('../scripts/run-bounded-tests.js');
  const { STAGED_PACKAGE_REQUIRED_FILES } = require('../scripts/staged-artifacts.js');
  const fsLocal = require('node:fs');
  const os = require('node:os');
  const root = fsLocal.mkdtempSync(path.join(os.tmpdir(), 'verser-preflight-'));
  const writeStagedFile = (relative) => {
    const target = path.join(root, 'dist', 'packages', 'scope-fake', relative);
    fsLocal.mkdirSync(path.dirname(target), { recursive: true });
    fsLocal.writeFileSync(target, '{}');
  };
  try {
    fsLocal.mkdirSync(path.join(root, 'packages', 'fake'), { recursive: true });
    fsLocal.writeFileSync(
      path.join(root, 'packages', 'fake', 'package.json'),
      JSON.stringify({ name: '@scope/fake' }),
    );

    const missing = runner.preflightStagedArtifacts(root);
    for (const requiredFile of STAGED_PACKAGE_REQUIRED_FILES) {
      assert.ok(
        missing.some((item) =>
          item.startsWith(`${path.posix.join('dist', 'packages', 'scope-fake', requiredFile)} (`),
        ),
        `expected ${requiredFile} in missing list, got ${JSON.stringify(missing)}`,
      );
    }
    assert.ok(
      missing.some((item) => item.includes('verser2-guest-python')),
      'expected the Python distribution directory in missing list',
    );

    // The previously accepted "manifest only + non-empty Python directory"
    // state must now be rejected for every missing piece.
    fsLocal.mkdirSync(path.join(root, 'dist', 'packages', 'scope-fake'), { recursive: true });
    fsLocal.writeFileSync(path.join(root, 'dist', 'packages', 'scope-fake', 'package.json'), '{}');
    fsLocal.mkdirSync(path.join(root, 'packages', 'verser2-guest-python', 'dist', 'python'), {
      recursive: true,
    });
    fsLocal.writeFileSync(
      path.join(root, 'packages', 'verser2-guest-python', 'dist', 'python', 'unrelated.txt'),
      'x',
    );
    const incomplete = runner.preflightStagedArtifacts(root);
    for (const requiredFile of STAGED_PACKAGE_REQUIRED_FILES) {
      if (requiredFile === 'package.json') {
        continue;
      }
      assert.ok(
        incomplete.some((item) =>
          item.startsWith(
            `${path.posix.join('dist', 'packages', 'scope-fake', requiredFile)} (missing`,
          ),
        ),
        `incomplete staging must report missing ${requiredFile}, got ${JSON.stringify(incomplete)}`,
      );
    }
    assert.ok(
      incomplete.some((item) => /wheel/.test(item)) &&
        incomplete.some((item) => /source distribution/.test(item)),
      `non-empty Python directory without real artifacts must be rejected: ${JSON.stringify(incomplete)}`,
    );

    // The complete staged publish set is accepted.
    for (const requiredFile of STAGED_PACKAGE_REQUIRED_FILES) {
      if (requiredFile === 'package.json') {
        continue;
      }
      writeStagedFile(requiredFile);
    }
    fsLocal.writeFileSync(
      path.join(
        root,
        'packages',
        'verser2-guest-python',
        'dist',
        'python',
        'verser2_guest_python-0.0.0.tar.gz',
      ),
      'sdist',
    );
    fsLocal.writeFileSync(
      path.join(
        root,
        'packages',
        'verser2-guest-python',
        'dist',
        'python',
        'verser2_guest_python-0.0.0-py3-none-any.whl',
      ),
      'wheel',
    );
    assert.deepEqual(runner.preflightStagedArtifacts(root), []);

    // Empty files, directories in place of files, and empty Python
    // distributions are rejected even when the names exist.
    fsLocal.writeFileSync(path.join(root, 'dist', 'packages', 'scope-fake', 'LICENSE'), '');
    assert.ok(
      runner
        .preflightStagedArtifacts(root)
        .some((item) => item.startsWith('dist/packages/scope-fake/LICENSE (empty')),
      'empty staged files must be rejected',
    );
    fsLocal.writeFileSync(path.join(root, 'dist', 'packages', 'scope-fake', 'LICENSE'), 'lic');

    fsLocal.rmSync(path.join(root, 'dist', 'packages', 'scope-fake', 'README.md'), {
      recursive: true,
      force: true,
    });
    fsLocal.mkdirSync(path.join(root, 'dist', 'packages', 'scope-fake', 'README.md'));
    assert.ok(
      runner
        .preflightStagedArtifacts(root)
        .some((item) => item.startsWith('dist/packages/scope-fake/README.md (not a regular file')),
      'directories in place of staged files must be rejected',
    );
    fsLocal.rmSync(path.join(root, 'dist', 'packages', 'scope-fake', 'README.md'), {
      recursive: true,
      force: true,
    });
    fsLocal.writeFileSync(
      path.join(root, 'dist', 'packages', 'scope-fake', 'README.md'),
      '# readme',
    );

    fsLocal.writeFileSync(
      path.join(
        root,
        'packages',
        'verser2-guest-python',
        'dist',
        'python',
        'verser2_guest_python-0.0.0-py3-none-any.whl',
      ),
      '',
    );
    assert.ok(
      runner.preflightStagedArtifacts(root).some((item) => /missing valid wheel/.test(item)),
      'an empty Python wheel must not satisfy the distribution requirement',
    );
    assert.deepEqual(
      runner.preflightStagedArtifacts(root).filter((item) => /source distribution/.test(item)),
      [],
      'the non-empty sdist must still satisfy its requirement',
    );
    fsLocal.writeFileSync(
      path.join(
        root,
        'packages',
        'verser2-guest-python',
        'dist',
        'python',
        'verser2_guest_python-0.0.0-py3-none-any.whl',
      ),
      'wheel',
    );
    assert.deepEqual(runner.preflightStagedArtifacts(root), []);
  } finally {
    fsLocal.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded runner buffers partial lines and flushes the final remainder', async () => {
  const runner = require('../scripts/run-bounded-tests.js');
  const { PassThrough } = require('node:stream');
  const source = new PassThrough();
  const lines = [];
  runner.pipeStreamWithLineBuffering(source, (line) => lines.push(line));

  source.write('alpha');
  assert.deepEqual(lines, [], 'partial lines must not be emitted before a newline');
  source.write('-beta\ngam');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, ['alpha-beta']);
  source.write('ma-partial');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, ['alpha-beta'], 'trailing partial stays buffered');
  source.end();
  await new Promise((resolve) => source.once('close', resolve));
  assert.deepEqual(lines, ['alpha-beta', 'gamma-partial']);
});

test('bounded runner timestamps are monotonic relative values', async () => {
  const runner = require('../scripts/run-bounded-tests.js');
  const start = process.hrtime.bigint();
  const first = runner.formatLiveTimestamp(start, process.hrtime.bigint());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = runner.formatLiveTimestamp(start, process.hrtime.bigint());

  assert.match(first, /^\[t\+\d+(\.\d+)?ms\]$/);
  const firstMs = Number(first.slice(3, -3));
  const secondMs = Number(second.slice(3, -3));
  assert.ok(secondMs >= firstMs, 'relative timestamps must be monotonic');
});

test('bounded runner streams labeled child stdout/stderr with monotonic timestamps', async () => {
  const runner = require('../scripts/run-bounded-tests.js');
  const { Writable } = require('node:stream');
  const collect = () => {
    const lines = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.length > 0) {
            lines.push(line);
          }
        }
        callback();
      },
    });
    return { lines, stream };
  };
  const out = collect();
  const err = collect();
  const startHrtime = process.hrtime.bigint();

  const outcome = await runner.runCommandWithLiveTimestamps(
    process.execPath,
    [
      '-e',
      'process.stdout.write("par"); process.stdout.write("tial\\nfinal-partial"); process.stderr.write("to-stderr\\n");',
    ],
    {
      env: { ...process.env },
      label: 'p1',
      cwd: rootDirectory,
      startHrtime,
      stdout: out.stream,
      stderr: err.stream,
    },
  );

  assert.equal(outcome.code, 0);
  assert.match(out.lines[0], /^\[t\+\d+(\.\d+)?ms\]\[p1:stdout\] partial$/);
  assert.match(out.lines[1], /^\[t\+\d+(\.\d+)?ms\]\[p1:stdout\] final-partial$/);
  assert.equal(out.lines.length, 2, 'the newline-less remainder must flush as one final line');
  assert.equal(err.lines.length, 1);
  assert.match(err.lines[0], /^\[t\+\d+(\.\d+)?ms\]\[p1:stderr\] to-stderr$/);
  const stampsOf = (lines) => lines.map((line) => Number(line.slice(3, line.indexOf('ms]'))));
  for (const lines of [out.lines, err.lines]) {
    const stamps = stampsOf(lines);
    for (let index = 1; index < stamps.length; index += 1) {
      assert.ok(stamps[index] >= stamps[index - 1], 'per-stream stamps must be monotonic');
    }
  }
});

function createRunnerSandbox({ staged = true, fixture = 'pass' } = {}) {
  const fsLocal = require('node:fs');
  const os = require('node:os');
  const { STAGED_PACKAGE_REQUIRED_FILES } = require('../scripts/staged-artifacts.js');
  const root = fsLocal.mkdtempSync(path.join(os.tmpdir(), 'verser-runner-e2e-'));
  fsLocal.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fsLocal.copyFileSync(
    path.join(rootDirectory, 'scripts', 'run-bounded-tests.js'),
    path.join(root, 'scripts', 'run-bounded-tests.js'),
  );
  fsLocal.copyFileSync(
    path.join(rootDirectory, 'scripts', 'staged-artifacts.js'),
    path.join(root, 'scripts', 'staged-artifacts.js'),
  );
  fsLocal.mkdirSync(path.join(root, 'packages', 'fake'), { recursive: true });
  fsLocal.writeFileSync(
    path.join(root, 'packages', 'fake', 'package.json'),
    JSON.stringify({ name: '@scope/fake' }),
  );
  fsLocal.mkdirSync(path.join(root, 'test'), { recursive: true });
  fsLocal.writeFileSync(
    path.join(root, 'test', 'one.test.js'),
    fixture === 'fail'
      ? "const { test } = require('node:test');\ntest('failing', () => {\n  throw new Error('boom');\n});\n"
      : "const { test } = require('node:test');\ntest('passing', () => {});\n",
  );
  if (staged) {
    const files = staged === 'incomplete' ? ['package.json'] : STAGED_PACKAGE_REQUIRED_FILES;
    for (const requiredFile of files) {
      const target = path.join(root, 'dist', 'packages', 'scope-fake', requiredFile);
      fsLocal.mkdirSync(path.dirname(target), { recursive: true });
      fsLocal.writeFileSync(target, '{}');
    }
    fsLocal.mkdirSync(path.join(root, 'packages', 'verser2-guest-python', 'dist', 'python'), {
      recursive: true,
    });
    if (staged !== 'incomplete') {
      fsLocal.writeFileSync(
        path.join(
          root,
          'packages',
          'verser2-guest-python',
          'dist',
          'python',
          'verser2_guest_python-0.0.0.tar.gz',
        ),
        'sdist',
      );
      fsLocal.writeFileSync(
        path.join(
          root,
          'packages',
          'verser2-guest-python',
          'dist',
          'python',
          'verser2_guest_python-0.0.0-py3-none-any.whl',
        ),
        'wheel',
      );
    }
  }
  return root;
}

function runRunnerSandbox(root, args) {
  const { spawnSync } = require('node:child_process');
  // The sandboxed `node --test` must not inherit this test process's runner
  // context (it triggers the recursive-run guard and skips running files).
  const {
    NODE_TEST_CONTEXT: _testContext,
    NODE_TEST_REPORTER: _testReporter,
    NODE_TEST_REPORTER_ARGS: _testReporterArgs,
    ...inheritedEnv
  } = process.env;
  const env = { ...inheritedEnv, NODE_OPTIONS: '' };
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'run-bounded-tests.js'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env,
    },
  );
}

test('bounded runner e2e: live timestamps label streamed TAP and preflight gates staged skips', () => {
  const fsLocal = require('node:fs');
  const passRoot = createRunnerSandbox();
  const failRoot = createRunnerSandbox({ fixture: 'fail' });
  const unstagedRoot = createRunnerSandbox({ staged: false });
  try {
    const live = runRunnerSandbox(passRoot, ['--skip-build-stage', '--live-timestamps']);
    assert.equal(live.status, 0, live.stderr);
    assert.ok(live.stdout.includes('TAP version 13'), 'TAP output must be preserved');
    const liveLines = live.stdout.split('\n').filter((line) => line.length > 0);
    assert.ok(
      liveLines.every((line) => /^\[t\+\d+(\.\d+)?ms\]\[(p1:stdout|runner:stdout)\] /.test(line)),
      `every streamed line must carry a timestamp and stream label: ${JSON.stringify(liveLines.slice(0, 3))}`,
    );
    assert.ok(live.stdout.includes('[p1:stdout]'));
    assert.ok(live.stdout.includes('--test-concurrency=1'), 'banner must show the default');

    const concurrency = runRunnerSandbox(passRoot, [
      '--skip-build-stage',
      '--live-timestamps',
      '--test-concurrency=2',
    ]);
    assert.equal(concurrency.status, 0, concurrency.stderr);
    assert.ok(concurrency.stdout.includes('--test-concurrency=2'));

    const raw = runRunnerSandbox(passRoot, ['--skip-build-stage']);
    assert.equal(raw.status, 0, raw.stderr);
    assert.ok(raw.stdout.includes('TAP version 13'), 'default mode keeps inherited raw TAP output');
    assert.equal(
      raw.stdout.split('\n').some((line) => /^\[t\+\d+(\.\d+)?ms\]\[/.test(line)),
      false,
      'default mode must not add timestamps',
    );

    const failing = runRunnerSandbox(failRoot, ['--skip-build-stage', '--live-timestamps']);
    assert.notEqual(failing.status, 0, 'child failure must propagate a non-zero exit');
    assert.ok(failing.stdout.includes('not ok'));

    const badConcurrency = runRunnerSandbox(passRoot, ['--test-concurrency=0']);
    assert.equal(badConcurrency.status, 1);
    assert.ok(/positive integer/.test(badConcurrency.stderr));

    const missingStaged = runRunnerSandbox(unstagedRoot, ['--skip-build-stage']);
    assert.equal(missingStaged.status, 1);
    assert.ok(
      /--skip-build-stage requires staged package artifacts/.test(missingStaged.stderr),
      'preflight must block skipping build/stage without staged artifacts',
    );
    assert.ok(missingStaged.stderr.includes('scope-fake'));

    // Incomplete staging (only manifests + a non-empty Python directory with
    // no real wheel/sdist) must also be rejected with the missing pieces.
    const incompleteRoot = createRunnerSandbox({ staged: 'incomplete' });
    try {
      const incomplete = runRunnerSandbox(incompleteRoot, ['--skip-build-stage']);
      assert.equal(incomplete.status, 1);
      assert.ok(
        /--skip-build-stage requires staged package artifacts/.test(incomplete.stderr),
        'preflight must block incomplete staged publish sets',
      );
      assert.ok(incomplete.stderr.includes('dist/packages/scope-fake/dist/index.js'));
      assert.ok(incomplete.stderr.includes('dist/packages/scope-fake/dist/index.d.ts'));
      assert.ok(incomplete.stderr.includes('dist/packages/scope-fake/LICENSE'));
      assert.ok(incomplete.stderr.includes('dist/packages/scope-fake/README.md'));
      assert.ok(incomplete.stderr.includes('wheel'));
      assert.ok(incomplete.stderr.includes('source distribution'));
    } finally {
      fsLocal.rmSync(incompleteRoot, { recursive: true, force: true });
    }
  } finally {
    fsLocal.rmSync(passRoot, { recursive: true, force: true });
    fsLocal.rmSync(failRoot, { recursive: true, force: true });
    fsLocal.rmSync(unstagedRoot, { recursive: true, force: true });
  }
});

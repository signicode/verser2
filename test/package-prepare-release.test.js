const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// The canonical version-policy conversion is reused, never re-implemented, so
// these tests assert the same rule the workflow's tag-version-check applies.
const policy = require('../scripts/package-version-policy.js');

const rootDirectory = path.resolve(__dirname, '..');

function createReleaseSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verser-prepare-release-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const script of ['prepare-release.js', 'package-version-policy.js', 'staged-artifacts.js']) {
    fs.copyFileSync(
      path.join(rootDirectory, 'scripts', script),
      path.join(root, 'scripts', script),
    );
  }

  fs.mkdirSync(path.join(root, 'packages', 'verser-common'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'verser-common', 'package.json'),
    `${JSON.stringify(
      {
        name: '@signicode/verser-common',
        version: '0.0.0',
        keywords: ['verser2', 'reverse-http', 'http2', 'guest', 'broker', 'protocol'],
      },
      null,
      2,
    )}\n`,
  );
  fs.mkdirSync(path.join(root, 'packages', 'verser2-guest-python'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'verser2-guest-python', 'package.json'),
    `${JSON.stringify(
      {
        name: '@signicode/verser2-guest-python',
        version: '0.0.0',
        dependencies: { '@signicode/verser-common': '0.0.0' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'verser2-guest-python', 'pyproject.toml'),
    '[project]\nname = "verser2-guest-python"\nversion = "0.0.0"\n',
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'verser2-guest-python', 'uv.lock'),
    'version = 1\n\n[[package]]\nname = "verser2-guest-python"\nversion = "0.0.0"\nsource = { editable = "." }\n',
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'verser2',
        lockfileVersion: 3,
        packages: {
          '': { name: 'verser2' },
          'packages/verser-common': {
            name: '@signicode/verser-common',
            version: '0.0.0',
          },
          'packages/verser2-guest-python': {
            name: '@signicode/verser2-guest-python',
            version: '0.0.0',
            dependencies: { '@signicode/verser-common': '0.0.0' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function runPrepareRelease(root, version) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'prepare-release.js'), '--version', version, '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `prepare-release failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function readVersionFromPyproject(root) {
  const content = fs.readFileSync(
    path.join(root, 'packages', 'verser2-guest-python', 'pyproject.toml'),
    'utf8',
  );
  return content.match(/^version = "(.+)"$/m)[1];
}

function readVersionFromUvLock(root) {
  const content = fs.readFileSync(
    path.join(root, 'packages', 'verser2-guest-python', 'uv.lock'),
    'utf8',
  );
  return content.match(/\[\[package\]\]\nname = "verser2-guest-python"\nversion = "(.+)"\n/)[1];
}

/**
 * Mirrors the workflow's tag-version-check assertions with the canonical
 * policy conversion: every JS workspace manifest must equal the tag SemVer
 * and the Python metadata must equal toPythonVersion(tag SemVer).
 */
function assertTagVersionConsistency(root, tagVersion) {
  for (const entry of fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(root, 'packages', entry.name, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(
      manifest.version,
      tagVersion,
      `${manifest.name} must carry the tag SemVer version for tag consistency`,
    );
  }
  assert.equal(
    readVersionFromPyproject(root),
    policy.toPythonVersion(tagVersion),
    'pyproject metadata must carry the canonical PEP 440 tag version',
  );
  assert.equal(
    readVersionFromUvLock(root),
    policy.toPythonVersion(tagVersion),
    'uv.lock package entry must carry the canonical PEP 440 tag version',
  );
}

test('prepare-release writes six-item keywords arrays on one line', () => {
  const root = createReleaseSandbox();
  try {
    runPrepareRelease(root, '1.2.3');
    const manifestPath = path.join(root, 'packages', 'verser-common', 'package.json');
    const content = fs.readFileSync(manifestPath, 'utf8');

    assert.match(
      content,
      /^ {2}"keywords": \["verser2", "reverse-http", "http2", "guest", "broker", "protocol"\]$/m,
    );
    assert.deepEqual(JSON.parse(content).keywords, [
      'verser2',
      'reverse-http',
      'http2',
      'guest',
      'broker',
      'protocol',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, version] of [
  ['stable', '1.2.3'],
  ['prerelease', '1.2.3-rc.1'],
]) {
  test(`prepare-release keeps SemVer in JS manifests and writes the canonical PEP 440 version to Python metadata for ${label} releases`, () => {
    const root = createReleaseSandbox();
    try {
      runPrepareRelease(root, version);
      const expectedPythonVersion = policy.toPythonVersion(version);

      const jsManifest = JSON.parse(
        fs.readFileSync(path.join(root, 'packages', 'verser-common', 'package.json'), 'utf8'),
      );
      assert.equal(jsManifest.version, version, 'JS workspace manifests keep the SemVer version');

      assert.equal(readVersionFromPyproject(root), expectedPythonVersion);
      assert.equal(readVersionFromUvLock(root), expectedPythonVersion);

      const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
      assert.equal(lock.packages['packages/verser-common'].version, version);
      assert.equal(
        lock.packages['packages/verser2-guest-python'].dependencies['@signicode/verser-common'],
        version,
      );

      assertTagVersionConsistency(root, version);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`tag push v${version} passes the fail-closed tag version check after release preparation`, () => {
    const root = createReleaseSandbox();
    try {
      runPrepareRelease(root, version);
      // The workflow derives tagVersion from refs/tags/v<version>; the
      // fail-closed check must pass for the prepared metadata.
      const tagVersion = `v${version}`.slice(1);
      assertTagVersionConsistency(root, tagVersion);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

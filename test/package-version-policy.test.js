const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');
const scriptPath = path.join(rootDirectory, 'scripts', 'package-version-policy.js');
const policy = require(scriptPath);

function createTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeStagedPackage(root, name, version) {
  return writeNamedStagedPackage(root, name, `@signicode/${name}`, version);
}

function writeNamedStagedPackage(root, directoryName, packageName, version) {
  const packageDirectory = path.join(root, directoryName);
  fs.mkdirSync(packageDirectory, { recursive: true });
  const manifest = {
    name: packageName,
    version,
    description: 'test package',
  };
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return packageDirectory;
}

function readStagedVersion(stagingRoot, packageName) {
  const manifestPath = path.join(stagingRoot, packageName, 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
}

test('stable semver resolves to latest dist-tag', () => {
  assert.equal(policy.determineDistTag('1.2.3'), 'latest');
  assert.equal(policy.determineDistTag('0.0.1'), 'latest');
});

test('prerelease semver resolves to next dist-tag', () => {
  assert.equal(policy.determineDistTag('1.2.3-next.0'), 'next');
  assert.equal(policy.determineDistTag('1.2.3-beta.1'), 'next');
  assert.equal(policy.determineDistTag('1.2.3-rc.0'), 'next');
});

test('publish kinds resolve deterministic versions and channel-safe dist-tags', () => {
  const stableRelease = policy.getPolicySummary({
    version: '1.2.3',
    publishKind: 'tag-release',
  });
  assert.equal(stableRelease.computedVersion, '1.2.3');
  assert.equal(stableRelease.distTag, 'latest');

  const prerelease = policy.getPolicySummary({
    version: '1.2.3-rc.1',
    publishKind: 'tag-release',
  });
  assert.equal(prerelease.computedVersion, '1.2.3-rc.1');
  assert.equal(prerelease.distTag, 'next');

  const shaBuild = policy.getPolicySummary({
    version: '1.2.3-next.0',
    publishKind: 'merged-pr-sha',
    sha: 'ABCDEF1234567890',
  });
  assert.equal(shaBuild.computedVersion, '1.2.3-sha.abcdef123456');
  assert.equal(shaBuild.distTag, 'main-sha');
  assert.notEqual(shaBuild.distTag, 'latest');
  assert.notEqual(shaBuild.distTag, 'next');

  const nightly = policy.getPolicySummary({
    version: '1.2.3-rc.1',
    publishKind: 'nightly',
    sha: 'fedcba9876543210',
    nightlyDate: '20260616',
  });
  assert.equal(nightly.computedVersion, '1.2.3-nightly.20260616.fedcba987654');
  assert.equal(nightly.distTag, 'nightly');
  assert.notEqual(nightly.distTag, 'latest');
  assert.notEqual(nightly.distTag, 'next');
});

test('manual npmjs candidates are described but not automatically allowed', () => {
  const npmCandidate = policy.getPolicySummary({
    version: '1.2.3',
    publishKind: 'manual-npmjs-candidate',
  });

  assert.equal(npmCandidate.computedVersion, '1.2.3');
  assert.equal(npmCandidate.npmJsPublishAllowed, false);
  assert.equal(npmCandidate.registry, 'npmjs-manual');
});

test('main-build version strips prerelease and appends sha', () => {
  const stable = policy.deriveMainBuildVersion('1.2.3', 'AbCdEf1234567890');
  assert.equal(stable, '1.2.3-sha.abcdef123456');

  const prerelease = policy.deriveMainBuildVersion('1.2.3-next.0', 'ABCDEF1234567890');
  assert.equal(prerelease, '1.2.3-sha.abcdef123456');
});

test('semver publish versions are converted to Python package versions', () => {
  assert.equal(policy.toPythonVersion('1.2.3'), '1.2.3');
  assert.equal(policy.toPythonVersion('1.2.3-beta.4'), '1.2.3b4');
  assert.equal(policy.toPythonVersion('1.2.3-rc.2'), '1.2.3rc2');
  assert.equal(policy.toPythonVersion('1.2.3-next.5'), '1.2.3.dev5');
  assert.equal(policy.toPythonVersion('1.2.3-sha.abcdef123456'), '1.2.3.dev0+sha.abcdef123456');
});

test('invalid versions are rejected', () => {
  assert.throws(() => policy.determineDistTag('1.2'), /Invalid semver version/);
  assert.throws(
    () => policy.deriveMainBuildVersion('bad.version', 'abc'),
    /Invalid semver version/,
  );
});

test('sha normalization lowercases and strips non-alphanumerics', () => {
  assert.equal(policy.normalizeShortSha('AB_CD-ef12GH__33', 12), 'abcdef12gh33');
  assert.throws(() => policy.normalizeShortSha('!@#$', 12), /Invalid short SHA/);
});

test('no npmjs publish is performed by design in this track', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.equal(policy.NPMJS_PUBLISH_ALLOWED, false);
  assert.equal(/npm\s+publish/.test(source), false);
});

test('script helper can write computed version to staged manifests', () => {
  const stagingRoot = createTempDirectory('verser-staged-version-policy');
  try {
    writeStagedPackage(stagingRoot, 'signicode-verser-common', '1.0.0');
    writeStagedPackage(stagingRoot, 'signicode-verser2-host', '1.0.0');

    const applyResult = policy.applyVersionToStagedPackages({
      stagingRoot,
      version: '2.5.0-sha.deadbeefcafebabe',
    });

    assert.equal(applyResult.updatedCount, 2);
    assert.equal(
      readStagedVersion(stagingRoot, 'signicode-verser-common'),
      '2.5.0-sha.deadbeefcafebabe',
    );
    assert.equal(
      readStagedVersion(stagingRoot, 'signicode-verser2-host'),
      '2.5.0-sha.deadbeefcafebabe',
    );
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('script helper rewrites staged internal dependency versions', () => {
  const stagingRoot = createTempDirectory('verser-staged-dependency-policy');
  try {
    writeNamedStagedPackage(
      stagingRoot,
      'signicode-verser-common',
      '@signicode/verser-common',
      '1.0.0',
    );
    const hostDirectory = writeNamedStagedPackage(
      stagingRoot,
      'signicode-verser2-host',
      '@signicode/verser2-host',
      '1.0.0',
    );
    const hostManifestPath = path.join(hostDirectory, 'package.json');
    const hostManifest = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'));
    hostManifest.dependencies = {
      '@signicode/verser-common': '1.0.0',
      undici: '^6.26.0',
    };
    fs.writeFileSync(hostManifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`, 'utf8');

    policy.applyVersionToStagedPackages({
      stagingRoot,
      version: '2.5.0-sha.deadbeefcafe',
    });

    const updatedManifest = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'));
    assert.equal(
      updatedManifest.dependencies['@signicode/verser-common'],
      '2.5.0-sha.deadbeefcafe',
    );
    assert.equal(updatedManifest.dependencies.undici, '^6.26.0');
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('CLI --json returns deterministic version and tag', () => {
  const command = process.execPath;
  const output = execFileSync(command, [scriptPath, '--version', '1.2.3-next.0', '--json'], {
    encoding: 'utf8',
  });
  const payload = JSON.parse(output);
  assert.equal(payload.distTag, 'next');
  assert.equal(payload.inputVersion, '1.2.3-next.0');
  assert.equal(payload.computedVersion, '1.2.3-next.0');
  assert.equal(payload.npmJsPublishAllowed, false);
});

test('CLI --json supports merged PR SHA and nightly publish kinds', () => {
  const command = process.execPath;
  const shaOutput = execFileSync(
    command,
    [
      scriptPath,
      '--version',
      '1.2.3-next.0',
      '--publish-kind',
      'merged-pr-sha',
      '--sha',
      'ABCDEF1234567890',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const shaPayload = JSON.parse(shaOutput);
  assert.equal(shaPayload.computedVersion, '1.2.3-sha.abcdef123456');
  assert.equal(shaPayload.distTag, 'main-sha');

  const nightlyOutput = execFileSync(
    command,
    [
      scriptPath,
      '--version',
      '1.2.3',
      '--publish-kind',
      'nightly',
      '--sha',
      'fedcba9876543210',
      '--nightly-date',
      '20260616',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const nightlyPayload = JSON.parse(nightlyOutput);
  assert.equal(nightlyPayload.computedVersion, '1.2.3-nightly.20260616.fedcba987654');
  assert.equal(nightlyPayload.distTag, 'nightly');
});

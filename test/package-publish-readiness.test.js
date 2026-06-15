const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');
const stagingRoot = path.join(rootDirectory, 'dist/packages');
const packageDirectories = [
  'packages/verser-common',
  'packages/verser2-guest-js-common',
  'packages/verser2-host',
  'packages/verser2-guest-node',
  'packages/verser2-guest-bun',
  'packages/verser2-guest-python',
];
const forbiddenPublishFields = ['private', 'scripts', 'devDependencies', 'workspaces'];
const runPackDryRunTests = process.env.VERSER_RUN_PACK_DRY_RUN_TESTS === '1';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getPackageName(packageDirectory) {
  return readJson(path.join(rootDirectory, packageDirectory, 'package.json')).name;
}

function getSafePackageDirectoryName(packageName) {
  return packageName.replace(/^@/, '').replaceAll('/', '-');
}

function getStagedPackageDirectory(packageName) {
  return path.join(stagingRoot, getSafePackageDirectoryName(packageName));
}

function readStagedManifest(packageName) {
  return readJson(path.join(getStagedPackageDirectory(packageName), 'package.json'));
}

function assertStagedPackageArtifacts(packageName) {
  const packageDirectory = getStagedPackageDirectory(packageName);
  assert.ok(
    fs.existsSync(packageDirectory),
    `Expected staged package directory for ${packageName} at ${packageDirectory}`,
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'dist/index.js')),
    `Expected staged JavaScript entrypoint for ${packageName}`,
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'dist/index.d.ts')),
    `Expected staged declaration entrypoint for ${packageName}`,
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'LICENSE')),
    `Expected staged license for ${packageName}`,
  );
  assert.ok(
    fs.existsSync(path.join(packageDirectory, 'README.md')),
    `Expected staged README for ${packageName}`,
  );
}

test('central staging tree contains publish-ready packages', () => {
  for (const packageDirectory of packageDirectories) {
    const packageName = getPackageName(packageDirectory);
    assertStagedPackageArtifacts(packageName);
  }
});

test('staged package READMEs use GitHub documentation links', () => {
  for (const packageDirectory of packageDirectories) {
    const packageName = getPackageName(packageDirectory);
    const stagedPackageDirectory = getStagedPackageDirectory(packageName);
    assertStagedPackageArtifacts(packageName);

    const readme = fs.readFileSync(path.join(stagedPackageDirectory, 'README.md'), 'utf8');
    assert.match(readme, /https:\/\/github\.com\/signicode\/verser2\/blob\//);
    assert.doesNotMatch(readme, /\.\.\/\.\.\/docs\//);
    assert.doesNotMatch(readme, /\.\.\/\.\.\/README\.md/);
  }
});

test('staged package manifests are publish-only consumer metadata', () => {
  for (const packageDirectory of packageDirectories) {
    const packageName = getPackageName(packageDirectory);
    const sourceManifest = readJson(path.join(rootDirectory, packageDirectory, 'package.json'));
    const stagedManifest = readStagedManifest(packageName);

    assert.equal(stagedManifest.name, sourceManifest.name);
    assert.equal(stagedManifest.version, sourceManifest.version);
    assert.equal(stagedManifest.description, sourceManifest.description);
    assert.equal(stagedManifest.license, 'MIT');
    assert.equal(stagedManifest.main, 'dist/index.js');
    assert.equal(stagedManifest.types, 'dist/index.d.ts');
    assert.equal(stagedManifest.exports['.'].require, './dist/index.js');
    assert.equal(stagedManifest.exports['.'].types, './dist/index.d.ts');
    assert.equal(stagedManifest.publishConfig.registry, 'https://npm.pkg.github.com');

    for (const field of forbiddenPublishFields) {
      assert.equal(
        Object.hasOwn(stagedManifest, field),
        false,
        `Expected ${packageName} staged manifest to omit ${field}`,
      );
    }
  }
});

test(
  'staged packages are packable with npm pack dry-run',
  {
    skip: runPackDryRunTests
      ? false
      : 'Skipping redundant pack dry-run in default source tests; run npm run test:package-tarballs for package packing validation.',
  },
  () => {
    for (const packageDirectory of packageDirectories) {
      const packageName = getPackageName(packageDirectory);
      const stagedPackageDirectory = getStagedPackageDirectory(packageName);
      assertStagedPackageArtifacts(packageName);

      const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: stagedPackageDirectory,
        encoding: 'utf8',
      });
      const [packResult] = JSON.parse(output);
      const packedFiles = packResult.files.map((file) => file.path).sort();

      assert.ok(packedFiles.includes('package.json'));
      assert.ok(packedFiles.includes('LICENSE'));
      assert.ok(packedFiles.includes('README.md'));
      assert.ok(packedFiles.includes('dist/index.js'));
      assert.ok(packedFiles.includes('dist/index.d.ts'));
      assert.equal(
        packedFiles.some((filePath) => filePath.startsWith('src/') || filePath.startsWith('test/')),
        false,
        `Expected ${packageName} pack dry-run to exclude source and tests`,
      );
    }
  },
);

test('Python Guest build emits native Python distribution artifacts', () => {
  const pythonDistDirectory = path.join(
    rootDirectory,
    'packages',
    'verser2-guest-python',
    'dist',
    'python',
  );

  assert.ok(fs.existsSync(pythonDistDirectory), 'Expected Python dist directory to exist');

  const artifacts = fs.readdirSync(pythonDistDirectory).sort();
  assert.ok(
    artifacts.some((artifact) => /^verser2_guest_python-.*\.tar\.gz$/.test(artifact)),
    'Expected Python source distribution artifact',
  );
  assert.ok(
    artifacts.some((artifact) => /^verser2_guest_python-.*-py3-none-any\.whl$/.test(artifact)),
    'Expected Python wheel artifact',
  );
});

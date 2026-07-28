const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const prepareRelease = require('../scripts/prepare-release.js');

function createPythonMetadata(version) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verser-prepare-release-'));
  const pyprojectPath = path.join(directory, 'pyproject.toml');
  const uvLockPath = path.join(directory, 'uv.lock');

  fs.writeFileSync(pyprojectPath, `[project]\nversion = "${version}"\n`, 'utf8');
  fs.writeFileSync(
    uvLockPath,
    `[[package]]\nname = "verser2-guest-python"\nversion = "${version}"\nsource = { editable = "." }\n`,
    'utf8',
  );

  return { directory, pyprojectPath, uvLockPath };
}

test('release preparation writes PEP 440 versions to Python metadata', () => {
  const metadata = createPythonMetadata('0.0.0');
  try {
    const pythonVersion = prepareRelease.toPythonVersion('0.7.1-next.0');
    assert.equal(pythonVersion, '0.7.1.dev0');
    assert.equal(prepareRelease.updatePyprojectToml(pythonVersion, metadata.pyprojectPath), true);
    assert.equal(prepareRelease.updatePythonUvLock(pythonVersion, metadata.uvLockPath), true);
    assert.match(fs.readFileSync(metadata.pyprojectPath, 'utf8'), /version = "0\.7\.1\.dev0"/);
    assert.match(fs.readFileSync(metadata.uvLockPath, 'utf8'), /version = "0\.7\.1\.dev0"/);
  } finally {
    fs.rmSync(metadata.directory, { recursive: true, force: true });
  }
});

test('release preparation keeps stable Python versions unchanged', () => {
  const metadata = createPythonMetadata('0.0.0');
  try {
    const pythonVersion = prepareRelease.toPythonVersion('0.7.1');
    assert.equal(pythonVersion, '0.7.1');
    prepareRelease.updatePyprojectToml(pythonVersion, metadata.pyprojectPath);
    prepareRelease.updatePythonUvLock(pythonVersion, metadata.uvLockPath);
    assert.match(fs.readFileSync(metadata.pyprojectPath, 'utf8'), /version = "0\.7\.1"/);
    assert.match(fs.readFileSync(metadata.uvLockPath, 'utf8'), /version = "0\.7\.1"/);
  } finally {
    fs.rmSync(metadata.directory, { recursive: true, force: true });
  }
});

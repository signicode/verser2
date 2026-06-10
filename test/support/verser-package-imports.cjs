function loadPackage(packageName, sourcePath) {
  if (process.env.VERSER_TEST_PACKAGE_MODE === 'tarball') {
    return require(packageName);
  }

  return require(sourcePath);
}

function loadVerserCommon() {
  return loadPackage('@signicode/verser-common', '../../packages/verser-common/dist/index.js');
}

function loadVerserHost() {
  return loadPackage('@signicode/verser2-host', '../../packages/verser2-host/dist/index.js');
}

function loadVerserGuestNode() {
  return loadPackage(
    '@signicode/verser2-guest-node',
    '../../packages/verser2-guest-node/dist/index.js',
  );
}

function loadVerserGuestBun() {
  return loadPackage(
    '@signicode/verser2-guest-bun',
    '../../packages/verser2-guest-bun/dist/index.js',
  );
}

module.exports = {
  loadVerserCommon,
  loadVerserGuestBun,
  loadVerserGuestNode,
  loadVerserHost,
};

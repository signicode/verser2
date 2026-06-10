const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');
const scriptPath = path.join(rootDirectory, 'scripts', 'test-package-consumers.js');
const runAuthenticatedGithubConsumers = process.env.VERSER_RUN_GITHUB_CONSUMER_TESTS === '1';
const expectedPackageCount = 6;
const expectedPackageNames = new Set([
  '@signicode/verser-common',
  '@signicode/verser2-guest-js-common',
  '@signicode/verser2-guest-bun',
  '@signicode/verser2-host',
  '@signicode/verser2-guest-node',
  '@signicode/verser2-guest-python',
]);

const expectedBunRequiredExports = new Set([
  'createVerserBunGuest',
  'createVerserBroker',
  'VERSER2_GUEST_BUN_PACKAGE_NAME',
]);

const expectedBunForbiddenExports = new Set([
  'dispatchVerserBunRequest',
  'dispatchVerserBunRequestInternal',
  '__internal',
  'routeTable',
  'RouteTable',
  'route-table',
]);

function assertPackageSet(report) {
  const packageNames = new Set(
    report.packages.map((packageReport) => packageReport.packageName || packageReport.package),
  );
  for (const expectedName of expectedPackageNames) {
    assert.ok(
      packageNames.has(expectedName),
      `Expected package validation result to include ${expectedName}`,
    );
  }
}

function assertRequiredExportsForMode(packageReport) {
  if (packageReport.packageName !== '@signicode/verser2-guest-bun') {
    return;
  }

  assert.ok(Array.isArray(packageReport.requiredExports));
  assert.equal(packageReport.requiredExports.length, expectedBunRequiredExports.size);
  for (const expectedExport of expectedBunRequiredExports) {
    assert.ok(
      packageReport.requiredExports.includes(expectedExport),
      `Expected ${packageReport.packageName} required export list to include ${expectedExport}`,
    );
  }
}

function assertForbiddenExportsForMode(packageReport) {
  if (packageReport.packageName !== '@signicode/verser2-guest-bun') {
    return;
  }

  assert.ok(Array.isArray(packageReport.forbiddenExports));
  assert.equal(packageReport.forbiddenExports.length, expectedBunForbiddenExports.size);
  for (const expectedExport of expectedBunForbiddenExports) {
    assert.ok(
      packageReport.forbiddenExports.includes(expectedExport),
      `Expected ${packageReport.packageName} forbidden export list to include ${expectedExport}`,
    );
  }
}

function runConsumerChecks(sourceMode) {
  const output = execFileSync(process.execPath, [scriptPath, `--source=${sourceMode}`, '--json'], {
    cwd: rootDirectory,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

test('consumer matrix validates cjs, esm, and typescript imports from source packages', () => {
  const report = runConsumerChecks('source');

  assert.equal(report.source, 'source');
  assert.equal(report.skipped, false);
  assert.ok(Array.isArray(report.packages), 'Expected array of package reports');
  assert.equal(report.packages.length, expectedPackageCount);
  assertPackageSet(report);

  for (const packageReport of report.packages) {
    assert.equal(packageReport.cjs, true);
    assert.equal(packageReport.mjs, true);
    assert.equal(packageReport.typescript, true);
    assertRequiredExportsForMode(packageReport);
    assertForbiddenExportsForMode(packageReport);
  }
});

test('consumer matrix validates cjs, esm, and typescript imports from staged packages', () => {
  const report = runConsumerChecks('staging');

  assert.equal(report.source, 'staging');
  assert.equal(report.skipped, false);
  assert.ok(Array.isArray(report.packages), 'Expected array of package reports');
  assert.equal(report.packages.length, expectedPackageCount);
  assertPackageSet(report);

  for (const packageReport of report.packages) {
    assert.equal(packageReport.cjs, true);
    assert.equal(packageReport.mjs, true);
    assert.equal(packageReport.typescript, true);
    assertRequiredExportsForMode(packageReport);
    assertForbiddenExportsForMode(packageReport);
  }
});

test('consumer matrix validates cjs, esm, and typescript imports from tarball packages', () => {
  const report = runConsumerChecks('tarball');

  assert.equal(report.source, 'tarball');
  assert.equal(report.skipped, false);
  assert.ok(Array.isArray(report.packages), 'Expected array of package reports');
  assert.equal(report.packages.length, expectedPackageCount);
  assertPackageSet(report);

  for (const packageReport of report.packages) {
    assert.equal(packageReport.cjs, true);
    assert.equal(packageReport.mjs, true);
    assert.equal(packageReport.typescript, true);
    assertRequiredExportsForMode(packageReport);
    assertForbiddenExportsForMode(packageReport);
  }
});

test('github mode does not fail when authentication token is absent', () => {
  const report = runConsumerChecks('github');

  assert.equal(report.source, 'github');
  if (!runAuthenticatedGithubConsumers) {
    assert.equal(report.skipped, true);
    assert.equal(report.packages.length, 0);
    assert.equal(typeof report.reason, 'string');
    return;
  }

  assert.equal(report.skipped, false);
  assert.ok(Array.isArray(report.packages), 'Expected array of package reports');
  assert.equal(report.packages.length, expectedPackageCount);
  assertPackageSet(report);

  for (const packageReport of report.packages) {
    assert.equal(packageReport.cjs, true);
    assert.equal(packageReport.mjs, true);
    assert.equal(packageReport.typescript, true);
    assertRequiredExportsForMode(packageReport);
    assertForbiddenExportsForMode(packageReport);
  }
});

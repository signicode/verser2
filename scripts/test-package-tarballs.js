#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDirectory = path.resolve(__dirname, '..');
const stagingRootDirectory = path.join(rootDirectory, 'dist', 'packages');
const behaviorTestSourcePath = path.join(
  rootDirectory,
  'test',
  'package-tarball',
  'behavior.test.cjs',
);
const reusableTestRelativePaths = [
  path.join('test', 'common-envelope.test.js'),
  path.join('test', 'common-protocol.test.js'),
  path.join('test', 'end-to-end.test.js'),
];
const supportFileRelativePaths = [
  path.join('test', 'support', 'verser-package-imports.cjs'),
  path.join('test', 'support', 'tls-fixtures.cjs'),
];
const fixtureFileRelativePaths = [];

const sourcePackages = [
  {
    name: '@signicode/verser-common',
    stagedSafeName: 'signicode-verser-common',
  },
  {
    name: '@signicode/verser2-guest-js-common',
    stagedSafeName: 'signicode-verser2-guest-js-common',
  },
  {
    name: '@signicode/verser2-host',
    stagedSafeName: 'signicode-verser2-host',
  },
  {
    name: '@signicode/verser2-guest-node',
    stagedSafeName: 'signicode-verser2-guest-node',
  },
];

const includedGroups = [
  {
    name: 'consumer-imports',
    description:
      'Installed tarball packages resolve by package name and expose public entrypoints.',
  },
  {
    name: 'existing-common-protocol-envelope',
    description: 'Existing common protocol and envelope tests run from installed tarballs.',
  },
  {
    name: 'existing-end-to-end',
    description:
      'Existing Host, Node Guest, Broker, Agent, and fetch end-to-end tests run from installed tarballs.',
  },
];

const excludedGroups = [
  {
    name: 'workflow-and-publish-metadata',
    reason: 'These tests inspect repository workflow YAML, package manifests, and staged metadata.',
  },
  {
    name: 'remaining-source-internal-and-streaming',
    reason:
      'Remaining source suites include repository metadata, workflow assertions, package staging internals, or broader timing-heavy streaming cases already covered by source tests.',
  },
];

function usage() {
  return [
    'Usage: node ./scripts/test-package-tarballs.js [--json]',
    '',
    'Build and stage packages first, then this command packs staged packages,',
    'installs the tarballs into a temporary consumer project, and runs automated',
    'behavior tests against package-name imports from node_modules.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { json: false };

  for (const arg of argv) {
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    throw new Error(`Unsupported argument: ${arg}`);
  }

  return options;
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function createTempConsumer() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verser-tarball-tests-'));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'verser-tarball-test-consumer',
        version: '0.0.0',
        private: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return projectRoot;
}

function packStagedPackages(tarballDirectory) {
  ensureDirectory(tarballDirectory);
  const tarballPaths = [];

  for (const packageInfo of sourcePackages) {
    const stagedDirectory = path.join(stagingRootDirectory, packageInfo.stagedSafeName);
    requireFile(stagedDirectory, `staged package directory for ${packageInfo.name}`);
    requireFile(
      path.join(stagedDirectory, 'package.json'),
      `staged manifest for ${packageInfo.name}`,
    );
    requireFile(
      path.join(stagedDirectory, 'dist', 'index.js'),
      `staged JavaScript for ${packageInfo.name}`,
    );
    requireFile(
      path.join(stagedDirectory, 'dist', 'index.d.ts'),
      `staged declarations for ${packageInfo.name}`,
    );

    const beforePack = fs
      .readdirSync(tarballDirectory)
      .filter((entry) => entry.endsWith('.tgz'))
      .sort();
    runCommand('npm', ['pack', '--silent', '--pack-destination', tarballDirectory], {
      cwd: stagedDirectory,
    });
    const afterPack = fs
      .readdirSync(tarballDirectory)
      .filter((entry) => entry.endsWith('.tgz'))
      .sort();
    const tarballName = afterPack.find((entry) => !beforePack.includes(entry));

    if (!tarballName) {
      throw new Error(`npm pack did not produce a tarball for ${packageInfo.name}`);
    }

    tarballPaths.push(path.join(tarballDirectory, tarballName));
  }

  return tarballPaths;
}

function installTarballs(projectRoot, tarballPaths) {
  if (tarballPaths.length !== sourcePackages.length) {
    throw new Error(
      `Expected ${sourcePackages.length} tarballs but found ${tarballPaths.length}. Build and stage all packages first.`,
    );
  }

  runCommand(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--prefer-offline',
      ...tarballPaths,
    ],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
}

function writeBehaviorTest(projectRoot) {
  const testDirectory = path.join(projectRoot, 'test');
  const supportDirectory = path.join(testDirectory, 'support');
  const testPaths = [path.join(testDirectory, 'tarball-behavior.test.cjs')];

  ensureDirectory(testDirectory);
  ensureDirectory(supportDirectory);
  requireFile(behaviorTestSourcePath, 'tarball behavior test source');
  fs.copyFileSync(behaviorTestSourcePath, testPaths[0]);

  for (const relativePath of supportFileRelativePaths) {
    const sourcePath = path.join(rootDirectory, relativePath);
    const destinationPath = path.join(projectRoot, relativePath);
    requireFile(sourcePath, `tarball test support file ${relativePath}`);
    ensureDirectory(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
  }

  for (const relativePath of fixtureFileRelativePaths) {
    const sourcePath = path.join(rootDirectory, relativePath);
    const destinationPath = path.join(projectRoot, relativePath);
    requireFile(sourcePath, `tarball test fixture file ${relativePath}`);
    ensureDirectory(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
  }

  for (const relativePath of reusableTestRelativePaths) {
    const sourcePath = path.join(rootDirectory, relativePath);
    const destinationPath = path.join(projectRoot, relativePath);
    requireFile(sourcePath, `reusable tarball test file ${relativePath}`);
    ensureDirectory(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
    testPaths.push(destinationPath);
  }

  return testPaths;
}

function runTarballTests() {
  const projectRoot = createTempConsumer();
  const tarballDirectory = path.join(projectRoot, 'tarballs');

  try {
    const tarballPaths = packStagedPackages(tarballDirectory);
    installTarballs(projectRoot, tarballPaths);
    const testPaths = writeBehaviorTest(projectRoot);
    runCommand(process.execPath, ['--test', ...testPaths], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        VERSER_TEST_PACKAGE_MODE: 'tarball',
      },
    });

    return {
      source: 'tarball',
      skipped: false,
      packages: sourcePackages.map((entry) => entry.name),
      tarballs: tarballPaths.map((tarballPath) => path.basename(tarballPath)),
      tests: testPaths.map((testPath) => path.relative(projectRoot, testPath)),
      includedGroups,
      excludedGroups,
    };
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  let report;
  try {
    report = runTarballTests();
  } catch (error) {
    if (options.json) {
      console.log(
        JSON.stringify({
          source: 'tarball',
          skipped: false,
          error: error.message,
          includedGroups,
          excludedGroups,
        }),
      );
    } else {
      console.error(`Tarball automated tests failed: ${error.message}`);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log('Tarball automated tests passed');
  console.log('Included tarball-mode test groups:');
  for (const group of includedGroups) {
    console.log(`- ${group.name}: ${group.description}`);
  }
  console.log('Excluded source-only test groups:');
  for (const group of excludedGroups) {
    console.log(`- ${group.name}: ${group.reason}`);
  }
}

main();

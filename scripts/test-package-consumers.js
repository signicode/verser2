#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDirectory = path.resolve(__dirname, '..');
const nodeModulesDirectory = path.join(rootDirectory, 'node_modules');
const stagingRootDirectory = path.join(rootDirectory, 'dist', 'packages');

const sourcePackages = [
  {
    name: '@signicode/verser-common',
    workspaceDirectory: path.join(rootDirectory, 'packages', 'verser-common'),
    stagedSafeName: 'signicode-verser-common',
  },
  {
    name: '@signicode/verser2-guest-js-common',
    workspaceDirectory: path.join(rootDirectory, 'packages', 'verser2-guest-js-common'),
    stagedSafeName: 'signicode-verser2-guest-js-common',
  },
  {
    name: '@signicode/verser2-host',
    workspaceDirectory: path.join(rootDirectory, 'packages', 'verser2-host'),
    stagedSafeName: 'signicode-verser2-host',
  },
  {
    name: '@signicode/verser2-guest-node',
    workspaceDirectory: path.join(rootDirectory, 'packages', 'verser2-guest-node'),
    stagedSafeName: 'signicode-verser2-guest-node',
  },
  {
    name: '@signicode/verser2-guest-bun',
    workspaceDirectory: path.join(rootDirectory, 'packages', 'verser2-guest-bun'),
    stagedSafeName: 'signicode-verser2-guest-bun',
  },
  {
    name: '@signicode/verser2-guest-python',
    workspaceDirectory: path.join(rootDirectory, 'packages', 'verser2-guest-python'),
    stagedSafeName: 'signicode-verser2-guest-python',
  },
];

const requiredExportsByPackage = {
  '@signicode/verser2-guest-bun': [
    'createVerserBunGuest',
    'createVerserBroker',
    'VERSER2_GUEST_BUN_PACKAGE_NAME',
  ],
};

const forbiddenExportsByPackage = {
  '@signicode/verser2-guest-bun': [
    'dispatchVerserBunRequest',
    'dispatchVerserBunRequestInternal',
    '__internal',
    'routeTable',
    'RouteTable',
    'route-table',
  ],
};

function getRequiredExports(mode, packageName) {
  return requiredExportsByPackage[packageName] || [];
}

function getForbiddenExports(mode, packageName) {
  return forbiddenExportsByPackage[packageName] || [];
}

function usage() {
  return [
    'Usage: node ./scripts/test-package-consumers.js --source=<source>',
    '',
    'Where <source> is one of: source, staging, tarball, github',
    '',
    'source  - import from workspace directories via temporary symlinks',
    'staging - import from staged package directories in dist/packages',
    'tarball - pack staged package tarballs and consume locally',
    'github  - consume from GitHub Packages (requires token)',
    '',
    'Use --json for machine-readable output.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    source: 'source',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length);
      continue;
    }

    if (arg === '--source') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --source');
      }

      options.source = next;
      index += 1;
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function createTempProject(prefix) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const packageManifest = {
    name: 'package-consumer-probe',
    version: '0.0.0',
    private: true,
    type: 'module',
  };

  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );

  return projectRoot;
}

function createPackageSymlink(projectNodeModules, packageName, targetDirectory) {
  const [scope, packageLeaf] = packageName.split('/');
  const destinationDirectory = packageLeaf
    ? path.join(projectNodeModules, scope, packageLeaf)
    : path.join(projectNodeModules, packageName);

  ensureDirectory(path.dirname(destinationDirectory));
  if (fs.existsSync(destinationDirectory)) {
    fs.rmSync(destinationDirectory, { recursive: true, force: true });
  }
  fs.symlinkSync(targetDirectory, destinationDirectory, 'dir');
}

function withWorkspaceSource(projectRoot) {
  const projectNodeModules = path.join(projectRoot, 'node_modules');
  ensureDirectory(projectNodeModules);

  for (const packageInfo of sourcePackages) {
    const sourceManifest = readJson(path.join(packageInfo.workspaceDirectory, 'package.json'));
    createPackageSymlink(projectNodeModules, sourceManifest.name, packageInfo.workspaceDirectory);
  }
}

function withStagingSource(projectRoot) {
  const projectNodeModules = path.join(projectRoot, 'node_modules');
  ensureDirectory(projectNodeModules);

  for (const packageInfo of sourcePackages) {
    const stagedDirectory = path.join(stagingRootDirectory, packageInfo.stagedSafeName);
    if (!fs.existsSync(stagedDirectory)) {
      throw new Error(`Missing staged package for ${packageInfo.name}: ${stagedDirectory}`);
    }

    const stagedManifest = readJson(path.join(stagedDirectory, 'package.json'));
    createPackageSymlink(projectNodeModules, stagedManifest.name, stagedDirectory);
  }
}

function withTarballSource(projectRoot) {
  ensureDirectory(path.join(projectRoot, 'node_modules'));

  const tarballDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'verser-staged-tarballs-'));
  const tarballPaths = [];

  try {
    for (const packageInfo of sourcePackages) {
      const stagedDirectory = path.join(stagingRootDirectory, packageInfo.stagedSafeName);
      if (!fs.existsSync(stagedDirectory)) {
        throw new Error(`Missing staged package for ${packageInfo.name}: ${stagedDirectory}`);
      }

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

      const newPack = afterPack.find((entry) => !beforePack.includes(entry));
      if (!newPack) {
        throw new Error(`No tarball was produced for ${packageInfo.name}`);
      }
      tarballPaths.push(path.join(tarballDirectory, newPack));
    }

    const installArgs = [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--prefer-offline',
      ...tarballPaths,
    ];

    runCommand('npm', installArgs, {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_PATH: `${nodeModulesDirectory}${path.delimiter}${process.env.NODE_PATH || ''}`,
      },
    });
  } finally {
    fs.rmSync(tarballDirectory, { recursive: true, force: true });
  }
}

function withGithubSource(projectRoot) {
  if (process.env.VERSER_RUN_GITHUB_CONSUMER_TESTS !== '1') {
    return {
      skipped: true,
      reason:
        'Skipping github source validation because VERSER_RUN_GITHUB_CONSUMER_TESTS is not set to 1.',
    };
  }

  const token =
    process.env.GITHUB_PACKAGES_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.NODE_AUTH_TOKEN ||
    process.env.NPM_TOKEN ||
    process.env.NPM_AUTH_TOKEN;

  if (!token) {
    return {
      skipped: true,
      reason:
        'Skipping github source validation because no token was provided. Set GITHUB_PACKAGES_TOKEN to run this mode.',
    };
  }

  const installArgs = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--prefer-offline',
    ...sourcePackages.map((entry) => getGithubPackageInstallSpec(entry.name)),
  ];

  fs.writeFileSync(
    path.join(projectRoot, '.npmrc'),
    `@signicode:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${token}\nalways-auth=true\n`,
    'utf8',
  );

  runCommand('npm', installArgs, {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_PATH: `${nodeModulesDirectory}${path.delimiter}${process.env.NODE_PATH || ''}`,
      NODE_AUTH_TOKEN: token,
    },
  });

  return { skipped: false };
}

function getGithubPackageInstallSpec(packageName) {
  const version = process.env.VERSER_GITHUB_PACKAGE_VERSION;
  if (!version) {
    return packageName;
  }

  return `${packageName}@${version}`;
}

function writeProbeScripts(projectRoot, packageName, mode) {
  const cjsPath = path.join(projectRoot, 'consumer.cjs');
  const mjsPath = path.join(projectRoot, 'consumer.mjs');
  const tsPath = path.join(projectRoot, 'consumer.ts');

  const requiredExports = getRequiredExports(mode, packageName);
  const forbiddenExports = getForbiddenExports(mode, packageName);
  const requiredExportsAssertion = requiredExports
    .map(
      (name) => `if (!Object.prototype.hasOwnProperty.call(packageExports, '${name}')) {
  throw new Error('Missing required export in ${packageName}: ${name}');
}`,
    )
    .join('\n');

  const forbiddenExportsAssertion = forbiddenExports
    .map(
      (name) => `if (Object.prototype.hasOwnProperty.call(packageExports, '${name}')) {
  throw new Error('Forbidden runtime export in ${packageName}: ${name}');
}`,
    )
    .join('\n');

  const cjs = `const packageExports = require('${packageName}');
if (packageExports === undefined || packageExports === null) {
  throw new Error('Package import was empty: ${packageName}');
}
if (typeof packageExports !== 'object' && typeof packageExports !== 'function') {
  throw new Error('Unexpected CJS import shape: ${packageName}');
}
${requiredExportsAssertion}
${forbiddenExportsAssertion}
`;

  const mjs = `import * as packageExports from '${packageName}';
if (packageExports === undefined || packageExports === null) {
  throw new Error('Package import was empty: ${packageName}');
}
if (typeof packageExports !== 'object' && typeof packageExports !== 'function') {
  throw new Error('Unexpected ESM import shape: ${packageName}');
}
${requiredExportsAssertion}
${forbiddenExportsAssertion}
`;

  const ts = `import * as packageExports from '${packageName}';
${requiredExportsAssertion}
${forbiddenExportsAssertion}
const _exports = packageExports;
if (_exports === undefined || _exports === null) {
  throw new Error('Package import was empty: ${packageName}');
}
`;

  fs.writeFileSync(cjsPath, cjs, 'utf8');
  fs.writeFileSync(mjsPath, mjs, 'utf8');
  fs.writeFileSync(tsPath, ts, 'utf8');

  return { cjsPath, mjsPath, tsPath };
}

function runConsumerChecks(projectRoot, packageName, mode) {
  const runEnv = {
    ...process.env,
    NODE_PATH: `${nodeModulesDirectory}${path.delimiter}${process.env.NODE_PATH || ''}`,
  };

  const scriptPaths = writeProbeScripts(projectRoot, packageName, mode);

  runCommand(process.execPath, [scriptPaths.cjsPath], {
    cwd: projectRoot,
    env: runEnv,
  });

  runCommand(process.execPath, [scriptPaths.mjsPath], {
    cwd: projectRoot,
    env: runEnv,
  });

  const tscPath = path.join(rootDirectory, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscPath)) {
    throw new Error('TypeScript compiler missing from repository node_modules');
  }

  runCommand(
    process.execPath,
    [
      tscPath,
      '--noEmit',
      '--strict',
      '--pretty',
      'false',
      '--module',
      'commonjs',
      '--target',
      'es2019',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
      scriptPaths.tsPath,
    ],
    {
      cwd: projectRoot,
      env: runEnv,
    },
  );
}

function buildReport(packageName, mode) {
  return {
    packageName,
    cjs: true,
    mjs: true,
    typescript: true,
    requiredExports: getRequiredExports(mode, packageName),
    forbiddenExports: getForbiddenExports(mode, packageName),
  };
}

function runSourceValidation(mode) {
  const projectRoot = createTempProject(`verser-consumer-${mode}`);

  try {
    if (mode === 'source') {
      withWorkspaceSource(projectRoot);
    } else if (mode === 'staging') {
      withStagingSource(projectRoot);
    } else if (mode === 'tarball') {
      withTarballSource(projectRoot);
    } else if (mode === 'github') {
      const sourceState = withGithubSource(projectRoot);
      if (sourceState?.skipped) {
        return {
          source: mode,
          skipped: true,
          reason: sourceState.reason,
          packages: [],
        };
      }
    } else {
      throw new Error(`Unsupported source mode: ${mode}`);
    }

    const results = [];
    const targetPackages = sourcePackages.map((entry) => entry.name);

    for (const packageName of targetPackages) {
      runConsumerChecks(projectRoot, packageName, mode);
      results.push(buildReport(packageName, mode));
    }

    return {
      source: mode,
      skipped: false,
      packages: results,
    };
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const supportedSources = new Set(['source', 'staging', 'tarball', 'github']);

  if (!supportedSources.has(options.source)) {
    console.error(`Unsupported source mode: ${options.source}`);
    process.exit(1);
  }

  let report;
  try {
    report = runSourceValidation(options.source);
  } catch (error) {
    console.error(error.message);
    if (options.json) {
      console.log(
        JSON.stringify({
          source: options.source,
          skipped: false,
          error: error.message,
        }),
      );
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(report));
    return;
  }

  if (report.skipped) {
    console.log(`Skipped ${report.source} mode: ${report.reason}`);
    return;
  }

  console.log(`Consumer import checks passed for ${report.source} mode`);
  for (const packageReport of report.packages) {
    console.log(`- ${packageReport.packageName}: cjs/mjs/typescript`);
  }
}

main();

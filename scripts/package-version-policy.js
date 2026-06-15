#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const PRESET_SHA_LENGTH = 12;
const STABLE_TAG = 'latest';
const PRERELEASE_TAG = 'next';
const NPMJS_PUBLISH_ALLOWED = false;

const semverRegex =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return [
    'Usage: node ./scripts/package-version-policy.js --version <version>',
    '',
    'Options:',
    '  --version <version>      Source package version for tag decision',
    '  --main-build             Derive a deterministic main-build version',
    '  --sha <sha>              Commit SHA used with --main-build',
    '  --apply-staged            Write computed version to dist/packages manifests',
    '  --json                   Print machine-readable output',
    '  --help                   Show this help text',
    '',
    'Examples:',
    '  node ./scripts/package-version-policy.js --version 1.2.3 --json',
    '  node ./scripts/package-version-policy.js --version 1.2.3-next.0 --json',
    '  node ./scripts/package-version-policy.js --version 1.2.3 --main-build --sha abcdef1234567890',
    '  node ./scripts/package-version-policy.js --version 1.2.3 --main-build --sha abcdef1234567890 --apply-staged',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    json: false,
    applyStaged: false,
    mainBuild: false,
    version: undefined,
    sha: undefined,
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

    if (arg === '--apply-staged') {
      options.applyStaged = true;
      continue;
    }

    if (arg === '--main-build') {
      options.mainBuild = true;
      continue;
    }

    if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
      continue;
    }

    if (arg === '--version') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --version');
      }

      options.version = next;
      index += 1;
      continue;
    }

    if (arg.startsWith('--sha=')) {
      options.sha = arg.slice('--sha='.length);
      continue;
    }

    if (arg === '--sha') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --sha');
      }

      options.sha = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isValidSemver(input) {
  return semverRegex.test(input);
}

function hasPrerelease(input) {
  const buildSplit = input.split('+', 1)[0];
  return buildSplit.includes('-');
}

function determineDistTag(version) {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return hasPrerelease(version) ? PRERELEASE_TAG : STABLE_TAG;
}

function getBaseVersion(version) {
  const buildSplit = version.split('+', 1)[0];
  const preSplitIndex = buildSplit.indexOf('-');
  if (preSplitIndex === -1) {
    return buildSplit;
  }

  return buildSplit.slice(0, preSplitIndex);
}

function sanitizePythonLocalVersion(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}

function toPythonVersion(version) {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  const [withoutBuildMetadata, buildMetadata] = version.split('+', 2);
  const baseVersion = getBaseVersion(withoutBuildMetadata);
  const prereleaseIndex = withoutBuildMetadata.indexOf('-');
  const localParts = [];

  if (buildMetadata) {
    localParts.push(buildMetadata);
  }

  if (prereleaseIndex === -1) {
    const localVersion = sanitizePythonLocalVersion(localParts.join('.'));
    return localVersion ? `${baseVersion}+${localVersion}` : baseVersion;
  }

  const prerelease = withoutBuildMetadata.slice(prereleaseIndex + 1);
  const prereleaseParts = prerelease.split('.');
  const label = prereleaseParts[0].toLowerCase();
  const numericPart = prereleaseParts.find((part) => /^\d+$/.test(part)) || '0';
  let pythonPublicVersion;

  if (label === 'alpha' || label === 'a') {
    pythonPublicVersion = `${baseVersion}a${numericPart}`;
  } else if (label === 'beta' || label === 'b') {
    pythonPublicVersion = `${baseVersion}b${numericPart}`;
  } else if (label === 'rc') {
    pythonPublicVersion = `${baseVersion}rc${numericPart}`;
  } else if (label === 'next' || label === 'dev') {
    pythonPublicVersion = `${baseVersion}.dev${numericPart}`;
  } else if (label === 'sha') {
    pythonPublicVersion = `${baseVersion}.dev0`;
    localParts.push(prerelease);
  } else {
    pythonPublicVersion = `${baseVersion}.dev${numericPart}`;
    localParts.push(prerelease);
  }

  const localVersion = sanitizePythonLocalVersion(localParts.join('.'));
  return localVersion ? `${pythonPublicVersion}+${localVersion}` : pythonPublicVersion;
}

function normalizeShortSha(sha, length = PRESET_SHA_LENGTH) {
  if (typeof sha !== 'string') {
    throw new Error('Invalid short SHA: value must be a string');
  }

  const normalized = sha
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (normalized.length === 0) {
    throw new Error('Invalid short SHA: value must contain at least one alphanumeric character');
  }

  return normalized.slice(0, length);
}

function deriveMainBuildVersion(version, sha, options = {}) {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  const baseVersion = getBaseVersion(version);
  const shortSha = normalizeShortSha(sha, options.shortShaLength || PRESET_SHA_LENGTH);
  return `${baseVersion}-sha.${shortSha}`;
}

function getStagingRootDirectory() {
  return path.resolve(__dirname, '..', 'dist', 'packages');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listStagedPackageDirectories(stagingRoot) {
  if (!fs.existsSync(stagingRoot)) {
    return [];
  }

  return fs
    .readdirSync(stagingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(stagingRoot, entry.name));
}

function applyVersionToStagedPackages({ stagingRoot = getStagingRootDirectory(), version } = {}) {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  const stagedPackageDirectories = listStagedPackageDirectories(stagingRoot);
  let updatedCount = 0;
  const internalPackageNames = new Set();
  for (const directory of stagedPackageDirectories) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      internalPackageNames.add(readJson(manifestPath).name);
    }
  }

  for (const directory of stagedPackageDirectories) {
    const manifestPath = path.join(directory, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const manifest = readJson(manifestPath);
    manifest.version = version;
    rewriteInternalDependencies(manifest, internalPackageNames, version);
    writeJson(manifestPath, manifest);
    updatedCount += 1;
  }

  return {
    updatedCount,
    stagedPackages: stagedPackageDirectories.map((directory) => path.basename(directory)),
  };
}

function rewriteInternalDependencies(manifest, internalPackageNames, version) {
  if (!manifest.dependencies) {
    return;
  }

  for (const packageName of Object.keys(manifest.dependencies)) {
    if (internalPackageNames.has(packageName)) {
      manifest.dependencies[packageName] = version;
    }
  }
}

function getPolicySummary({ version, sha, mainBuild }) {
  const summary = {
    inputVersion: version,
    distTag: determineDistTag(version),
    computedVersion: version,
    npmJsPublishAllowed: NPMJS_PUBLISH_ALLOWED,
    pythonVersion: toPythonVersion(version),
  };

  if (mainBuild) {
    const mainVersion = deriveMainBuildVersion(version, sha);
    summary.computedVersion = mainVersion;
    summary.pythonVersion = toPythonVersion(mainVersion);
  }

  return summary;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.version) {
    console.error('Missing required argument: --version');
    console.log(usage());
    process.exit(1);
  }

  if (options.mainBuild && !options.sha) {
    console.error('Missing required argument: --sha (required with --main-build)');
    process.exit(1);
  }

  try {
    const summary = getPolicySummary(options);
    let applyResult;

    if (options.applyStaged) {
      const stagingRoot = getStagingRootDirectory();
      applyResult = applyVersionToStagedPackages({
        stagingRoot,
        version: summary.computedVersion,
      });
    }

    if (options.json) {
      const payload = {
        ...summary,
      };

      if (applyResult) {
        payload.applyStaged = applyResult;
      }

      console.log(JSON.stringify(payload));
      return;
    }

    console.log(`Version ${summary.inputVersion}`);
    console.log(`Dist-tag: ${summary.distTag}`);
    if (options.mainBuild) {
      console.log(`Main-build version: ${summary.computedVersion}`);
    }
    if (!NPMJS_PUBLISH_ALLOWED) {
      console.log('npmjs publish not supported in this track');
    }

    if (applyResult) {
      console.log(
        `Applied version ${summary.computedVersion} to ${applyResult.updatedCount} staged package manifests`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  determineDistTag,
  deriveMainBuildVersion,
  normalizeShortSha,
  getPolicySummary,
  applyVersionToStagedPackages,
  rewriteInternalDependencies,
  parseArgs,
  isValidSemver,
  hasPrerelease,
  getStagingRootDirectory,
  getBaseVersion,
  toPythonVersion,
  sanitizePythonLocalVersion,
  PRESET_SHA_LENGTH,
  STABLE_TAG,
  PRERELEASE_TAG,
  NPMJS_PUBLISH_ALLOWED,
  usage,
};

if (require.main === module) {
  main();
}

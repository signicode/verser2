#!/usr/bin/env node

/**
 * Central, non-drifting definition of the complete publish artifact set that
 * staging produces and that readiness validation and the bounded runner's
 * `--skip-build-stage` preflight require.
 *
 * `scripts/stage-packages.js` iterates `STAGED_PACKAGE_REQUIRED_FILES` to
 * emit and re-verify each staged artifact (manifest, built entrypoint,
 * declarations, license, README); `test/package-publish-readiness.test.js`
 * asserts the same set through the same validators; and
 * `scripts/run-bounded-tests.js` refuses to skip build/stage unless
 * `preflightStagedArtifacts` passes. Every staged artifact and the Python
 * wheel/source distribution must be a regular, non-empty file — empty files
 * and directories never satisfy the specification.
 *
 * @internal
 */

const fs = require('node:fs');
const path = require('node:path');

/** Files every staged workspace package directory must contain. */
const STAGED_PACKAGE_REQUIRED_FILES = Object.freeze([
  'package.json',
  'dist/index.js',
  'dist/index.d.ts',
  'LICENSE',
  'README.md',
]);

/** Staged package directories live under dist/packages/<safe-package-name>. */
const STAGING_ROOT_DIRECTORY_SEGMENTS = Object.freeze(['dist', 'packages']);

/** Python distributions land here (relative to the repository root). */
const PYTHON_DISTRIBUTION_DIRECTORY = path.posix.join(
  'packages',
  'verser2-guest-python',
  'dist',
  'python',
);

/** Complete Python publish set: a real wheel and a real source distribution. */
const PYTHON_DISTRIBUTION_PATTERNS = Object.freeze({
  wheel: /^verser2_guest_python-.*-py3-none-any\.whl$/,
  'source distribution': /^verser2_guest_python-.*\.tar\.gz$/,
});

/** Mirrors the staging script's package-name-to-directory mapping. */
function safePackageName(name) {
  return name.replace(/^@/, '').replaceAll('/', '-');
}

/**
 * Validates one staged artifact path against the publish-set rules shared by
 * staging, readiness validation, and the runner preflight: it must exist, be
 * a regular file (not a directory or other special file), and be non-empty.
 * Returns `undefined` when valid, otherwise a human-readable reason.
 */
function readStagedArtifactIssue(artifactPath) {
  let stats;
  try {
    stats = fs.statSync(artifactPath);
  } catch {
    return 'missing';
  }
  if (!stats.isFile()) {
    return 'not a regular file';
  }
  if (stats.size === 0) {
    return 'empty';
  }
  return undefined;
}

/**
 * Returns the first regular non-empty file in `directory` matching `pattern`,
 * or `undefined` when no valid match exists. Directories and empty files do
 * not satisfy a distribution requirement.
 */
function findValidDistributionFile(directory, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) {
      continue;
    }
    if (readStagedArtifactIssue(path.join(directory, entry)) === undefined) {
      return entry;
    }
  }
  return undefined;
}

/** Staged directory (repo-relative, posix) for one package name. */
function stagedPackageDirectory(name) {
  return path.posix.join(...STAGING_ROOT_DIRECTORY_SEGMENTS, safePackageName(name));
}

/** Workspace package names discovered from each `packages/<dir>/package.json`. */
function readWorkspacePackageNames(rootDirectory) {
  const packagesRoot = path.join(rootDirectory, 'packages');
  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(packagesRoot, entry.name, 'package.json')))
    .map(
      (entry) =>
        JSON.parse(fs.readFileSync(path.join(packagesRoot, entry.name, 'package.json'), 'utf8'))
          .name,
    )
    .filter((name) => typeof name === 'string' && name.length > 0);
}

/**
 * Returns the missing or invalid pieces of the complete staged publish set
 * (empty when the staged output is complete): every required file in every
 * staged workspace package directory must be a regular non-empty file, and
 * the Python distributions must include an actual non-empty wheel and
 * source-distribution file (not merely a non-empty directory).
 */
function preflightStagedArtifacts(rootDirectory) {
  const missing = [];
  let packageNames;
  try {
    packageNames = readWorkspacePackageNames(rootDirectory);
  } catch (error) {
    return [`packages/ (${error.message})`];
  }

  for (const name of packageNames) {
    for (const requiredFile of STAGED_PACKAGE_REQUIRED_FILES) {
      const stagedPath = path.posix.join(stagedPackageDirectory(name), requiredFile);
      const issue = readStagedArtifactIssue(path.join(rootDirectory, stagedPath));
      if (issue !== undefined) {
        missing.push(`${stagedPath} (${issue})`);
      }
    }
  }

  const pythonDirectory = path.join(rootDirectory, ...PYTHON_DISTRIBUTION_DIRECTORY.split('/'));
  if (!fs.existsSync(pythonDirectory)) {
    missing.push(`${PYTHON_DISTRIBUTION_DIRECTORY}/ (missing)`);
  } else {
    for (const [kind, pattern] of Object.entries(PYTHON_DISTRIBUTION_PATTERNS)) {
      if (findValidDistributionFile(pythonDirectory, pattern) === undefined) {
        missing.push(`${PYTHON_DISTRIBUTION_DIRECTORY}/ missing valid ${kind} (${pattern.source})`);
      }
    }
  }

  return missing;
}

module.exports = {
  STAGED_PACKAGE_REQUIRED_FILES,
  PYTHON_DISTRIBUTION_DIRECTORY,
  PYTHON_DISTRIBUTION_PATTERNS,
  safePackageName,
  stagedPackageDirectory,
  readWorkspacePackageNames,
  readStagedArtifactIssue,
  findValidDistributionFile,
  preflightStagedArtifacts,
};

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { isValidSemver } = require('./package-version-policy.js');

const ROOT = path.resolve(__dirname, '..');

// --------------------------------------------------------------------------
// CLI argument parsing
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { json: false, version: undefined };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
      continue;
    }

    if (arg === '--version') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --version');
      }
      options.version = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.version === undefined) {
    throw new Error('Missing required argument: --version <semver>');
  }

  if (!isValidSemver(options.version)) {
    throw new Error(`Invalid semver version: ${options.version}`);
  }

  return options;
}

// --------------------------------------------------------------------------
// JSON helpers (2-space indent, trailing newline)
// --------------------------------------------------------------------------

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writePackageJson(filePath, value) {
  let content = `${JSON.stringify(value, null, 2)}\n`;
  const filesArrayPattern = /\x20\x20"files": \[\n((?:\x20{4}"[^"]+",?\n)+)\x20\x20\]/;
  content = content.replace(filesArrayPattern, (_match, filesBlock) => {
    const files = filesBlock
      .trim()
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''));

    return `  "files": [${files.join(', ')}]`;
  });
  fs.writeFileSync(filePath, content, 'utf8');
}

// --------------------------------------------------------------------------
// Discover internal @signicode package names from manifests
// --------------------------------------------------------------------------

function collectInternalNames() {
  const packagesDir = path.join(ROOT, 'packages');
  const names = new Set();

  if (!fs.existsSync(packagesDir)) return names;

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, entry.name, 'package.json');
    if (fs.existsSync(manifestPath)) {
      names.add(readJson(manifestPath).name);
    }
  }

  return names;
}

// --------------------------------------------------------------------------
// Rewrite internal dependency versions across dep categories
// --------------------------------------------------------------------------

function rewriteInternalDependencies(manifest, internalNames, version) {
  for (const key of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = manifest[key];
    if (!deps) continue;

    for (const pkg of Object.keys(deps)) {
      if (internalNames.has(pkg)) {
        deps[pkg] = version;
      }
    }
  }
}

// --------------------------------------------------------------------------
// Update package-lock.json entries
// --------------------------------------------------------------------------

function updatePackageLock(internalNames, version) {
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return [];

  const lock = readJson(lockPath);
  const packages = lock.packages;
  if (!packages) return [];

  const updatedKeys = [];

  for (const [key, entry] of Object.entries(packages)) {
    // Skip root entry ("") and non-internal entries
    const isInternalByName = entry.name && internalNames.has(entry.name);
    const isInternalByPath = key.startsWith('packages/');
    if (!isInternalByName && !isInternalByPath) continue;

    // Skip link-only entries (node_modules/@signicode/* symlinks)
    if (entry.link) continue;

    entry.version = version;
    rewriteInternalDependencies(entry, internalNames, version);
    updatedKeys.push(key);
  }

  if (updatedKeys.length > 0) {
    writeJson(lockPath, lock);
  }

  return updatedKeys;
}

// --------------------------------------------------------------------------
// Update pyproject.toml version line
// --------------------------------------------------------------------------

function updatePyprojectToml(version) {
  const pyprojectPath = path.join(ROOT, 'packages', 'verser2-guest-python', 'pyproject.toml');
  if (!fs.existsSync(pyprojectPath)) return false;

  let content = fs.readFileSync(pyprojectPath, 'utf8');
  const original = content;

  content = content.replace(/^(version\s*=\s*")[^"]+(".*)$/m, `$1${version}$2`);

  if (content === original) return false;

  fs.writeFileSync(pyprojectPath, content, 'utf8');
  return true;
}

function updatePythonUvLock(version) {
  const lockPath = path.join(ROOT, 'packages', 'verser2-guest-python', 'uv.lock');
  if (!fs.existsSync(lockPath)) return false;

  let content = fs.readFileSync(lockPath, 'utf8');
  const original = content;

  content = content.replace(
    /(\[\[package\]\]\nname = "verser2-guest-python"\nversion = ")[^"]+("\n)/,
    `$1${version}$2`,
  );

  if (content === original) return false;

  fs.writeFileSync(lockPath, content, 'utf8');
  return true;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { version, json: jsonOutput } = options;

  const internalNames = collectInternalNames();
  const changedFiles = [];

  // 1. Update every package manifest under packages/*/package.json
  const packagesDir = path.join(ROOT, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(packagesDir, entry.name, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;

      const pkg = readJson(manifestPath);
      pkg.version = version;
      rewriteInternalDependencies(pkg, internalNames, version);
      writePackageJson(manifestPath, pkg);
      changedFiles.push(manifestPath);
    }
  }

  // 2. Update pyproject.toml
  if (updatePyprojectToml(version)) {
    changedFiles.push(path.join(ROOT, 'packages', 'verser2-guest-python', 'pyproject.toml'));
  }

  if (updatePythonUvLock(version)) {
    changedFiles.push(path.join(ROOT, 'packages', 'verser2-guest-python', 'uv.lock'));
  }

  // 3. Update package locks
  const lockChanged = updatePackageLock(internalNames, version);
  if (lockChanged.length > 0) {
    const lockPath = path.join(ROOT, 'package-lock.json');
    if (!changedFiles.includes(lockPath)) {
      changedFiles.push(lockPath);
    }
  }

  // Summary output
  if (jsonOutput) {
    console.log(
      JSON.stringify({
        version,
        changed: changedFiles.map((f) => path.relative(ROOT, f)),
      }),
    );
  } else {
    console.log(`Updated ${changedFiles.length} file(s) to version ${version}:`);
    for (const f of changedFiles) {
      console.log(`  ${path.relative(ROOT, f)}`);
    }
  }
}

// --------------------------------------------------------------------------
// Execute
// --------------------------------------------------------------------------

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  collectInternalNames,
  rewriteInternalDependencies,
  updatePackageLock,
  updatePyprojectToml,
  updatePythonUvLock,
};

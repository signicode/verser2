#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');

const rootDirectory = path.resolve(__dirname, '..');
const packagesRootDirectory = path.join(rootDirectory, 'packages');
const stagingRootDirectory = path.join(rootDirectory, 'dist', 'packages');

const packageDirectories = [
  path.join(packagesRootDirectory, 'verser-common'),
  path.join(packagesRootDirectory, 'verser2-guest-js-common'),
  path.join(packagesRootDirectory, 'verser2-host'),
  path.join(packagesRootDirectory, 'verser2-guest-node'),
  path.join(packagesRootDirectory, 'verser2-guest-bun'),
  path.join(packagesRootDirectory, 'verser2-guest-python'),
];

if (process.argv.includes('--help')) {
  console.log(`Usage: npm run stage:packages

Build packages first with npm run build, then run this command to create
publish-ready package directories under dist/packages/<safe-package-name>.

Generated staged packages include built entrypoints, TypeScript declarations,
licenses, and publish-only package.json metadata for GitHub Packages.`);
  process.exit(0);
}

function safePackageName(name) {
  return name.replace(/^@/, '').replaceAll('/', '-');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file is missing: ${filePath}`);
  }
}

function buildStagedManifest(sourceManifest) {
  const stagedManifest = {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
    },
    publishConfig: {
      registry: 'https://npm.pkg.github.com',
    },
  };

  if (sourceManifest.license) {
    stagedManifest.license = sourceManifest.license;
  }

  if (sourceManifest.repository) {
    stagedManifest.repository = sourceManifest.repository;
  }

  if (sourceManifest.dependencies) {
    stagedManifest.dependencies = sourceManifest.dependencies;
  }

  return stagedManifest;
}

for (const packageDirectory of packageDirectories) {
  const sourceManifestPath = path.join(packageDirectory, 'package.json');
  const sourceDistDirectory = path.join(packageDirectory, 'dist');
  const sourceJavaScriptArtifact = path.join(sourceDistDirectory, 'index.js');
  const sourceDeclarationArtifact = path.join(sourceDistDirectory, 'index.d.ts');
  const sourceLicenseArtifact = path.join(sourceDistDirectory, 'LICENSE');

  if (!fs.existsSync(sourceManifestPath)) {
    throw new Error(`Source package manifest is missing: ${sourceManifestPath}`);
  }

  const sourceManifest = readJson(sourceManifestPath);
  const packageName = sourceManifest.name;

  if (!packageName || typeof packageName !== 'string') {
    throw new Error(`Source package manifest missing valid name: ${sourceManifestPath}`);
  }

  requireFile(sourceJavaScriptArtifact);
  requireFile(sourceDeclarationArtifact);
  requireFile(sourceLicenseArtifact);

  const stagedPackageDirectory = path.join(stagingRootDirectory, safePackageName(packageName));
  fs.rmSync(stagedPackageDirectory, { recursive: true, force: true });
  ensureDirectory(stagedPackageDirectory);
  ensureDirectory(path.join(stagedPackageDirectory, 'dist'));

  fs.copyFileSync(sourceJavaScriptArtifact, path.join(stagedPackageDirectory, 'dist', 'index.js'));
  fs.copyFileSync(
    sourceDeclarationArtifact,
    path.join(stagedPackageDirectory, 'dist', 'index.d.ts'),
  );
  fs.copyFileSync(sourceLicenseArtifact, path.join(stagedPackageDirectory, 'LICENSE'));

  const stagedManifest = buildStagedManifest(sourceManifest);
  const stagedManifestPath = path.join(stagedPackageDirectory, 'package.json');
  fs.writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8');
}

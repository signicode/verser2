#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const rootDirectory = path.resolve(__dirname, '..');
const packagesRootDirectory = path.join(rootDirectory, 'packages');
const stagingRootDirectory = path.join(rootDirectory, 'dist', 'packages');
const githubBaseUrl = 'https://github.com/signicode/verser2/blob';

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
licenses, and publish-only package.json metadata. Set VERSER_PACKAGE_REGISTRY
to override the staged publish registry for GitHub Packages previews.`);
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

function getDocumentationReference() {
  if (process.env.VERSER_PACKAGE_DOCS_REF) {
    return process.env.VERSER_PACKAGE_DOCS_REF;
  }

  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDirectory,
    encoding: 'utf8',
  }).trim();
}

function toRepositoryPath(packageDirectory, linkTarget) {
  const [targetPath, fragment = ''] = linkTarget.split('#');
  if (!targetPath || /^[a-z]+:/i.test(targetPath) || targetPath.startsWith('mailto:')) {
    return null;
  }

  const resolvedPath = path.resolve(packageDirectory, targetPath);
  if (!resolvedPath.startsWith(rootDirectory)) {
    return null;
  }

  const relativePath = path.relative(rootDirectory, resolvedPath).replaceAll(path.sep, '/');
  const suffix = fragment ? `#${fragment}` : '';
  return `${relativePath}${suffix}`;
}

function rewriteReadmeLinksForPublishedPackage(readme, packageDirectory, docsReference) {
  return readme.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, linkTarget) => {
    const repositoryPath = toRepositoryPath(packageDirectory, linkTarget);
    if (!repositoryPath) {
      return match;
    }

    return `[${label}](${githubBaseUrl}/${docsReference}/${repositoryPath})`;
  });
}

function buildStagedManifest(sourceManifest) {
  const publishConfig = {
    ...(sourceManifest.publishConfig || {}),
    registry: process.env.VERSER_PACKAGE_REGISTRY || 'https://registry.npmjs.org/',
  };

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
    publishConfig,
  };

  if (sourceManifest.license) {
    stagedManifest.license = sourceManifest.license;
  }

  if (sourceManifest.repository) {
    stagedManifest.repository = sourceManifest.repository;
  }

  if (sourceManifest.homepage) {
    stagedManifest.homepage = sourceManifest.homepage;
  }

  if (sourceManifest.bugs) {
    stagedManifest.bugs = sourceManifest.bugs;
  }

  if (sourceManifest.keywords) {
    stagedManifest.keywords = sourceManifest.keywords;
  }

  if (sourceManifest.engines) {
    stagedManifest.engines = sourceManifest.engines;
  }

  if (sourceManifest.dependencies) {
    stagedManifest.dependencies = sourceManifest.dependencies;
  }

  return stagedManifest;
}

const docsReference = getDocumentationReference();

for (const packageDirectory of packageDirectories) {
  const sourceManifestPath = path.join(packageDirectory, 'package.json');
  const sourceDistDirectory = path.join(packageDirectory, 'dist');
  const sourceJavaScriptArtifact = path.join(sourceDistDirectory, 'index.js');
  const sourceDeclarationArtifact = path.join(sourceDistDirectory, 'index.d.ts');
  const sourceLicenseArtifact = path.join(sourceDistDirectory, 'LICENSE');
  const sourceReadmePath = path.join(packageDirectory, 'README.md');

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
  requireFile(sourceReadmePath);

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
  const publishedReadme = rewriteReadmeLinksForPublishedPackage(
    fs.readFileSync(sourceReadmePath, 'utf8'),
    packageDirectory,
    docsReference,
  );
  fs.writeFileSync(path.join(stagedPackageDirectory, 'README.md'), publishedReadme, 'utf8');

  const stagedManifest = buildStagedManifest(sourceManifest);
  const stagedManifestPath = path.join(stagedPackageDirectory, 'package.json');
  fs.writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8');
}

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

// Shared, non-drifting complete staged artifact specification (also used by
// package readiness and the bounded runner's --skip-build-stage preflight).
const {
  STAGED_PACKAGE_REQUIRED_FILES,
  safePackageName,
  readStagedArtifactIssue,
} = require('./staged-artifacts.js');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
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

/**
 * Maps one shared-spec staged artifact path to its source input inside the
 * workspace package directory. The staged output set is exactly
 * STAGED_PACKAGE_REQUIRED_FILES; this only resolves inputs, so no parallel
 * output list can drift from the central specification.
 */
function sourcePathForStagedArtifact(packageDirectory, requiredFile) {
  switch (requiredFile) {
    case 'package.json':
      return path.join(packageDirectory, 'package.json');
    case 'dist/index.js':
      return path.join(packageDirectory, 'dist', 'index.js');
    case 'dist/index.d.ts':
      return path.join(packageDirectory, 'dist', 'index.d.ts');
    case 'LICENSE':
      return path.join(packageDirectory, 'dist', 'LICENSE');
    case 'README.md':
      return path.join(packageDirectory, 'README.md');
    default:
      throw new Error(`No staging source input defined for staged artifact ${requiredFile}`);
  }
}

/** Requires a source input that satisfies the shared non-empty regular-file rule. */
function requireSourceFile(filePath) {
  const issue = readStagedArtifactIssue(filePath);
  if (issue !== undefined) {
    throw new Error(`Required ${issue} source file for staging: ${filePath}`);
  }
}

/** Writes the staged form of one required artifact into the staged package. */
function stageArtifact(packageDirectory, stagedPackageDirectory, requiredFile, sourceManifest) {
  const stagedPath = path.join(stagedPackageDirectory, requiredFile);
  ensureDirectory(path.dirname(stagedPath));
  const sourcePath = sourcePathForStagedArtifact(packageDirectory, requiredFile);
  if (requiredFile === 'package.json') {
    const stagedManifest = buildStagedManifest(sourceManifest);
    fs.writeFileSync(stagedPath, `${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8');
    return;
  }
  if (requiredFile === 'README.md') {
    const publishedReadme = rewriteReadmeLinksForPublishedPackage(
      fs.readFileSync(sourcePath, 'utf8'),
      packageDirectory,
      docsReference,
    );
    fs.writeFileSync(stagedPath, publishedReadme, 'utf8');
    return;
  }
  fs.copyFileSync(sourcePath, stagedPath);
}

for (const packageDirectory of packageDirectories) {
  const sourceManifestPath = path.join(packageDirectory, 'package.json');

  if (!fs.existsSync(sourceManifestPath)) {
    throw new Error(`Source package manifest is missing: ${sourceManifestPath}`);
  }

  const sourceManifest = readJson(sourceManifestPath);
  const packageName = sourceManifest.name;

  if (!packageName || typeof packageName !== 'string') {
    throw new Error(`Source package manifest missing valid name: ${sourceManifestPath}`);
  }

  const stagedPackageDirectory = path.join(stagingRootDirectory, safePackageName(packageName));
  fs.rmSync(stagedPackageDirectory, { recursive: true, force: true });
  ensureDirectory(stagedPackageDirectory);

  // Emit and then verify every member of the shared complete staged
  // artifact specification; nothing outside the spec is staged and nothing
  // in the spec is left unasserted.
  for (const requiredFile of STAGED_PACKAGE_REQUIRED_FILES) {
    requireSourceFile(sourcePathForStagedArtifact(packageDirectory, requiredFile));
    stageArtifact(packageDirectory, stagedPackageDirectory, requiredFile, sourceManifest);
    const issue = readStagedArtifactIssue(path.join(stagedPackageDirectory, requiredFile));
    if (issue !== undefined) {
      throw new Error(
        `Staged ${requiredFile} for ${packageName} is ${issue}: ${path.join(stagedPackageDirectory, requiredFile)}`,
      );
    }
  }
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');
const workflowPath = path.join(rootDirectory, '.github', 'workflows', 'package-publish.yml');

function loadWorkflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

function assertHas(pattern, message) {
  const content = loadWorkflow();
  assert.ok(pattern.test(content), message);
}

test('package publish workflow is defined', () => {
  assert.ok(
    fs.existsSync(workflowPath),
    'Expected .github/workflows/package-publish.yml to exist.',
  );
});

test('workflow supports pull request and main/tag push triggers', () => {
  const content = loadWorkflow();
  assert.match(content, /\non:\s*\n[\s\S]*?pull_request:/);
  assert.match(content, /pull_request:\n[\s\S]*?branches:[\s\S]*?-\s*main/);
  assert.match(content, /push:\n[\s\S]*?branches:[\s\S]*?-\s*main/);
  assert.match(content, /tags:\n[\s\S]*?-\s*'v\*'/);
});

test('workflow sets required permissions for publish', () => {
  const content = loadWorkflow();
  assert.equal(/contents:\s*read/.test(content), true);
  assert.equal(/packages:\s*write/.test(content), true);
});

test('workflow configures npm for GitHub Packages registry/scope', () => {
  assertHas(
    /actions\/setup-node@v4[\s\S]*?registry-url:\s*https:\/\/npm\.pkg\.github\.com[\s\S]*?scope:\s*['"]?@signicode['"]?/,
    'Expected setup-node to use GitHub Packages registry with @signicode scope.',
  );
});

test('workflow builds, stages, packs, and validates consumers locally', () => {
  assertHas(/npm run build/, 'Expected build step to run.');
  assertHas(/npm run stage:packages/, 'Expected staging step to run.');
  assertHas(/npm pack/, 'Expected pack step to run for staged packages.');
  assertHas(
    /npm run test:package-consumers -- --source=staging/,
    'Expected staged consumer validation.',
  );
  assertHas(
    /npm run test:package-consumers -- --source=tarball/,
    'Expected tarball consumer validation.',
  );
});

test('workflow applies package version policy and publishes to GitHub Packages', () => {
  assertHas(
    /npm run package:version-policy -- --version/,
    'Expected package-version-policy to be part of publish flow.',
  );
  assertHas(
    /npm publish --access restricted --tag .* --registry https:\/\/npm\.pkg\.github\.com/,
    'Expected npm publish to target npm.pkg.github.com.',
  );
});

test('workflow never publishes packages from pull request runs', () => {
  const content = loadWorkflow();
  assert.match(
    content,
    /if:\s*github\.event_name\s*!=\s*'pull_request'\s*&&\s*github\.event_name\s*==\s*'push'/,
  );
  assert.match(content, /Confirm validation job never publishes packages/);
});

test('workflow uses NODE_AUTH_TOKEN from GitHub secret and no npmjs publish', () => {
  const content = loadWorkflow();
  assert.match(content, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.equal(/https:\/\/registry\.npmjs\.org/.test(content), false);
});

test('workflow avoids commit of generated artifacts', () => {
  const content = loadWorkflow();
  assert.equal(/git\s+add\s+dist/i.test(content), false);
  assert.equal(/git\s+commit/.test(content), false);
});

test('workflow validates GitHub Packages installs when possible', () => {
  assertHas(
    /VERSER_RUN_GITHUB_CONSUMER_TESTS:\s*1/,
    'Expected github source consumer validation to be gated by VERSER_RUN_GITHUB_CONSUMER_TESTS.',
  );
  assertHas(
    /VERSER_GITHUB_PACKAGE_VERSION:\s*\$\{\{\s*steps\.publish-metadata\.outputs\.publish_version\s*\}\}/,
    'Expected github source consumer validation to install the just-published package version.',
  );
});

test('workflow validates staged consumers after publish version is applied', () => {
  assertHas(
    /Apply publish version to staged packages[\s\S]*?Validate versioned staged and tarball consumers[\s\S]*?--source=staging[\s\S]*?--source=tarball/,
    'Expected versioned staged and tarball consumers to be validated before publish.',
  );
});

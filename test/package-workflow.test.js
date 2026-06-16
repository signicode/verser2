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

test('workflow supports broad pull request, main push, tag, nightly, and manual triggers', () => {
  const content = loadWorkflow();
  assert.match(content, /\non:\s*\n[\s\S]*?pull_request:/);
  assert.match(content, /pull_request:\n[\s\S]*?branches:[\s\S]*?-\s*main/);
  assert.match(
    content,
    /pull_request:\n[\s\S]*?types:[\s\S]*?-\s*opened[\s\S]*?-\s*synchronize[\s\S]*?-\s*reopened/,
  );
  assert.match(content, /push:\n[\s\S]*?branches:[\s\S]*?-\s*main/);
  assert.match(content, /tags:\n[\s\S]*?-\s*'v\*'/);
  assert.match(content, /schedule:\n[\s\S]*?-\s*cron:/);
  assert.match(content, /workflow_dispatch:/);
  assert.match(content, /publish_npmjs:/);
  assert.match(content, /npmjs_version:/);
  assert.equal(/pull_request:[\s\S]*?paths:/.test(content), false);
  assert.equal(/push:[\s\S]*?paths:/.test(content), false);
});

test('workflow detects package-affecting changes before validation or SHA publishing', () => {
  const content = loadWorkflow();
  assert.match(content, /detect-package-changes:/);
  assert.match(content, /package-affecting/);
  assert.match(content, /release-docs/);
  assert.match(content, /conductor-only/);
  assert.match(content, /docs-only/);
  assert.match(content, /github\.event\.before/);
  assert.match(content, /workflow_dispatch/);
  assert.match(content, /git diff --name-only "\$BASE_SHA"/);
  assert.match(content, /docs\/release-procedure\.md/);
  assert.match(content, /docs\/package-publishing\.md/);
  assert.match(content, /docs\/\*\)[\s\S]*?should_publish_sha=false/);
  assert.match(
    content,
    /package-validation:[\s\S]*?if:\s*\$\{\{[\s\S]*?needs\.detect-package-changes\.outputs\.should_validate\s*==\s*'true'/,
  );
  assert.match(
    content,
    /package-publish:[\s\S]*?needs\.detect-package-changes\.outputs\.should_publish_sha\s*==\s*'true'/,
  );
});

test('workflow sets required permissions for publish', () => {
  const content = loadWorkflow();
  assert.equal(/contents:\s*read/.test(content), true);
  assert.equal(/packages:\s*write/.test(content), true);
});

test('workflow configures npm for GitHub Packages registry/scope', () => {
  assertHas(
    /actions\/setup-node@v6[\s\S]*?registry-url:\s*https:\/\/npm\.pkg\.github\.com[\s\S]*?scope:\s*['"]?@signicode['"]?/,
    'Expected setup-node to use GitHub Packages registry with @signicode scope.',
  );
});

test('workflow reuses validation build output in publish job', () => {
  const content = loadWorkflow();
  assert.match(content, /actions\/upload-artifact@v7[\s\S]*?name:\s*package-build-output/);
  assert.match(content, /actions\/download-artifact@v4[\s\S]*?name:\s*package-build-output/);
  assert.match(content, /packages\/verser2-guest-python\/dist\/python/);
  assert.equal(
    /package-publish:[\s\S]*?name:\s*Build and stage packages[\s\S]*?npm run build/.test(content),
    false,
  );
});

test('workflow builds, stages, and validates consumers locally', () => {
  assertHas(/npm run build/, 'Expected build step to run.');
  assertHas(/npm run stage:packages/, 'Expected staging step to run.');
  assertHas(
    /npm run test:package-consumers -- --source=staging/,
    'Expected staged consumer validation.',
  );
  assertHas(
    /npm run test:package-consumers -- --source=tarball/,
    'Expected tarball consumer validation.',
  );
  assertHas(
    /npm run test:package-tarballs/,
    'Expected tarball behavior validation to pack staged packages internally.',
  );
  assert.equal(/Pack staged packages/.test(loadWorkflow()), false);
});

test('workflow reuses existing build outputs for source tests and lint in validation job', () => {
  assertHas(
    /package-validation:[\s\S]*?node --test test\/\*\.test\.js[\s\S]*?npm run lint[\s\S]*?Confirm validation job never publishes packages/,
    'Expected validation job to run source tests without re-running npm test build/stage work.',
  );
});

test('workflow applies package version policy and preserves GitHub Packages publishing', () => {
  assertHas(
    /npm run package:version-policy -- --version/,
    'Expected package-version-policy to be part of publish flow.',
  );
  assertHas(
    /npm publish --access public --tag .* --registry https:\/\/npm\.pkg\.github\.com/,
    'Expected npm publish to target npm.pkg.github.com with public access.',
  );
});

test('workflow supports maintainer-gated npmjs publishing', () => {
  const content = loadWorkflow();
  assert.match(content, /npmjs-publish:/);
  assert.match(content, /environment:\s*npmjs-release/);
  assert.match(content, /github\.event_name\s*==\s*'workflow_dispatch'/);
  assert.match(content, /inputs\.publish_npmjs\s*==\s*true/);
  assert.match(content, /github\.event_name\s*==\s*'push'/);
  assert.match(content, /github\.ref_type\s*==\s*'tag'/);
  assert.match(content, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(content, /publishKind:\s*'manual-npmjs-candidate'/);
  assert.match(content, /id-token:\s*write/);
  assert.match(content, /Setup Node for npmjs\.org[\s\S]*?node-version:\s*22/);
  assert.match(content, /npm install --global npm@latest/);
  assert.doesNotMatch(content, /secrets\.NPM_TOKEN/);
  assert.match(content, /npmjs publishing is not allowed for SHA build versions/);
  assert.match(
    content,
    /npm publish --access public --tag .* --registry https:\/\/registry\.npmjs\.org\//,
  );
  assert.match(content, /--provenance/);
});

test('workflow resolves publish kind for tag, merged PR SHA, and nightly publication', () => {
  const content = loadWorkflow();
  assert.match(content, /publish_kind=tag-release/);
  assert.match(content, /publish_kind=merged-pr-sha/);
  assert.match(content, /publish_kind=nightly/);
  assert.match(content, /--publish-kind "\$\{publishKind\}"/);
  assert.match(content, /dist_tag=\$\{summary\.distTag\}/);
  assert.match(content, /cron:/);
  assert.match(content, /--tag "\$\{\{ steps\.publish-metadata\.outputs\.dist_tag \}\}"/);
});

test('workflow publishes Python distributions through GitHub artifacts and releases', () => {
  const content = loadWorkflow();
  assert.match(content, /Apply publish version to Python project/);
  assert.match(
    content,
    /uv build --project packages\/verser2-guest-python --out-dir packages\/verser2-guest-python\/dist\/python/,
  );
  assert.match(
    content,
    /name:\s*verser2-guest-python-\$\{\{\s*steps\.publish-metadata\.outputs\.publish_version\s*\}\}[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.whl[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.tar\.gz/,
  );
  assert.match(content, /python_version=\$\{policy\.toPythonVersion\(publishVersion\)\}/);
  assert.match(
    content,
    /PUBLISH_VERSION:\s*\$\{\{\s*steps\.publish-metadata\.outputs\.python_version\s*\}\}/,
  );
  assert.match(content, /softprops\/action-gh-release@v2/);
  assert.match(
    content,
    /files:[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.whl[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.tar\.gz/,
  );
  assert.match(content, /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test('workflow never publishes packages from pull request runs', () => {
  const content = loadWorkflow();
  assert.match(content, /if:\s*\$\{\{[\s\S]*?github\.event_name\s*!=\s*'pull_request'/);
  assert.match(content, /Confirm validation job never publishes packages/);
});

test('workflow scopes package publishing credentials by registry', () => {
  const content = loadWorkflow();
  assert.match(content, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.match(content, /npmjs-publish:[\s\S]*?id-token:\s*write/);
  assert.doesNotMatch(content, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
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

test('workflow runs tarball automated tests during pull request validation', () => {
  assertHas(
    /package-validation:[\s\S]*?npm run test:package-tarballs[\s\S]*?Confirm validation job never publishes packages/,
    'Expected pull request validation job to run tarball automated tests before the no-publish confirmation.',
  );
});

test('workflow runs tarball automated tests after publish versioning and before publishing', () => {
  assertHas(
    /Apply publish version to staged packages[\s\S]*?npm run test:package-tarballs[\s\S]*?npm publish --access public/,
    'Expected publish flow to run tarball automated tests after version mutation and before npm publish.',
  );
});

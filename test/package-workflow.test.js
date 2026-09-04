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

function jobSection(content, jobId) {
  const start = content.indexOf(`\n  ${jobId}:`);
  assert.notEqual(start, -1, `Expected job ${jobId} in the workflow.`);
  const remainder = content.slice(start + 1);
  const nextMatch = /\n {2}[a-z][a-z0-9-]+:/.exec(remainder);
  return nextMatch === null ? remainder : remainder.slice(0, nextMatch.index);
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

test('workflow detects package-affecting changes before validation or preview publishing', () => {
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
    /github-packages-preview:[\s\S]*?needs\.detect-package-changes\.outputs\.should_publish_sha\s*==\s*'true'/,
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

test('workflow reuses validation build output in publish jobs', () => {
  const content = loadWorkflow();
  assert.match(content, /actions\/upload-artifact@v7[\s\S]*?name:\s*package-build-output/);
  assert.match(content, /actions\/download-artifact@v4[\s\S]*?name:\s*package-build-output/);
  assert.match(content, /packages\/verser2-guest-python\/dist\/python/);
  assert.equal(
    /github-packages-preview:[\s\S]*?name:\s*Build and stage packages[\s\S]*?npm run build/.test(
      content,
    ),
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
    /package-validation:[\s\S]*?npm run test:bounded:staged[\s\S]*?npm run lint[\s\S]*?Confirm validation job never publishes packages/,
    'Expected validation job to run source tests via the staged bounded runner without re-running build/stage.',
  );
  assert.equal(
    /node --test test\/\*\.test\.js/.test(loadWorkflow()),
    false,
    'Expected no raw node --test suite invocation in the workflow.',
  );
});

test('workflow applies package version policy and publishes previews to GitHub Packages', () => {
  assertHas(
    /npm run package:version-policy -- --version/,
    'Expected package-version-policy to be part of publish flow.',
  );
  assertHas(
    /npm publish --access public --tag .* --registry https:\/\/npm\.pkg\.github\.com/,
    'Expected GitHub Packages preview publish to target npm.pkg.github.com with public access.',
  );
});

test('GitHub Packages preview job runs only for main merges and nightly schedules, never tags', () => {
  const content = loadWorkflow();
  const preview = jobSection(content, 'github-packages-preview');
  assert.match(preview, /github\.event_name == 'schedule'/);
  assert.match(preview, /github\.ref == 'refs\/heads\/main'/);
  assert.match(preview, /needs\.detect-package-changes\.outputs\.should_publish_sha == 'true'/);
  assert.equal(
    /refs\/tags\/v/.test(preview),
    false,
    'Expected the GitHub Packages preview job condition to never match tag refs.',
  );
  assert.equal(
    /tag-release/.test(preview),
    false,
    'Expected no tag-release publish kind in the GitHub Packages preview job.',
  );
});

test('stable and prerelease tags never publish JavaScript to GitHub Packages', () => {
  const content = loadWorkflow();
  const npmjs = jobSection(content, 'npmjs-publish');
  assert.equal(
    /npm\.pkg\.github\.com/.test(npmjs),
    false,
    'Expected the npmjs publish job to never touch the GitHub Packages registry.',
  );
  assert.equal(
    /package-publish:/.test(content),
    false,
    'Expected the old combined tag-publishing job to be gone.',
  );
});

test('tag runs fail closed unless the tag version matches every workspace, pyproject, and uv.lock version', () => {
  const content = loadWorkflow();
  const check = jobSection(content, 'tag-version-check');
  assert.match(check, /readdirSync\('packages'/);
  assert.match(check, /does not match tag/);
  assert.match(check, /pyproject\.toml/);
  assert.ok(
    check.includes('name = "verser2-guest-python"') && check.includes('uv.lock'),
    'Expected the tag check to verify the Python uv.lock package entry version.',
  );
  assert.match(check, /uv\.lock package version .* does not match tag PEP 440 version/);
  assert.match(check, /toPythonVersion/);
  assert.match(check, /fail closed/);
});

test('npmjs-publish condition is skip-safe for manual dispatch and gated for tags', () => {
  const content = loadWorkflow();
  const npmjs = jobSection(content, 'npmjs-publish');
  const condition = npmjs.match(/\n {4}if: (.*)/)[1];
  assert.match(
    condition,
    /always\(\)/,
    'Expected explicit always() so a skipped tag check is evaluable.',
  );
  assert.match(
    condition,
    /needs\.package-validation\.result == 'success'/,
    'Expected package-validation success to be required.',
  );
  assert.match(
    condition,
    /\(github\.event_name == 'workflow_dispatch' && inputs\.publish_npmjs == true\)/,
    'Expected the manual dispatch branch to publish when publish_npmjs is true despite the skipped tag check.',
  );
  assert.match(
    condition,
    /\(github\.ref_type == 'tag' && needs\.tag-version-check\.result == 'success'\)/,
    'Expected tag releases to publish only when tag-version-check succeeded.',
  );
  assert.equal(
    /pull_request/.test(condition),
    false,
    'Expected the npmjs-publish condition to never match pull request events.',
  );
});

test('npmjs publishing uses direct OIDC npm publish behind the single npmjs-release gate', () => {
  const content = loadWorkflow();
  const npmjs = jobSection(content, 'npmjs-publish');
  assert.match(npmjs, /environment:\s*npmjs-release/);
  assert.equal(
    (content.match(/environment:\s*npmjs-release/g) ?? []).length,
    1,
    'Expected exactly one npmjs-release environment gate.',
  );
  assert.match(npmjs, /github\.event_name == 'workflow_dispatch'/);
  assert.match(npmjs, /inputs\.publish_npmjs == true/);
  assert.match(npmjs, /id-token:\s*write/);
  assert.match(npmjs, /node-version:\s*22/);
  assert.match(npmjs, /npm install --global npm@latest/);
  assert.match(npmjs, /npmjs publishing is not allowed for SHA build versions/);
  assert.match(
    npmjs,
    /npm publish --access public --tag "\$\{DIST_TAG\}" --registry https:\/\/registry\.npmjs\.org\//,
  );
  assert.equal(
    /npm stage publish/.test(content),
    false,
    'Expected no npm staging publish path under the direct publish policy.',
  );
  assert.doesNotMatch(npmjs, /--provenance/);
  assert.doesNotMatch(content, /secrets\.NPM_TOKEN/);
});

test('manual dry-run invokes npm publish --dry-run while tag runs publish directly', () => {
  const content = loadWorkflow();
  const npmjs = jobSection(content, 'npmjs-publish');
  assert.match(
    npmjs,
    /NPMJS_DRY_RUN:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.npmjs_dry_run \}\}/,
  );
  assert.match(
    npmjs,
    /npm publish --dry-run --tag "\$\{DIST_TAG\}" --registry https:\/\/registry\.npmjs\.org\//,
  );
  assert.match(npmjs, /npmjs_dry_run is true; running npm publish --dry-run/);
});

test('workflow resolves publish kind for merged PR SHA and nightly previews and tag releases for npmjs', () => {
  const content = loadWorkflow();
  const preview = jobSection(content, 'github-packages-preview');
  assert.match(preview, /publishKind="nightly"/);
  assert.match(preview, /publishKind="merged-pr-sha"/);
  assert.match(preview, /publish_kind=\$\{publishKind\}/);
  assert.match(preview, /dist_tag=\$\{summary\.distTag\}/);
  assert.match(preview, /--tag "\$\{\{ steps\.publish-metadata\.outputs\.dist_tag \}\}"/);
  assert.match(content, /publishKind: 'tag-release'/);
  assert.match(content, /publishKind: 'manual-npmjs-candidate'/);
  assert.match(content, /cron:/);
});

test('Python release assets are a separate tag-only job without any JS publish', () => {
  const content = loadWorkflow();
  const python = jobSection(content, 'python-release-assets');
  assert.match(python, /needs\.tag-version-check\.result == 'success'/);
  assert.match(python, /Apply PEP 440 tag version to Python project/);
  assert.match(
    python,
    /PUBLISH_VERSION:\s*\$\{\{\s*needs\.tag-version-check\.outputs\.python_version\s*\}\}/,
  );
  assert.match(
    python,
    /uv build --project packages\/verser2-guest-python --out-dir packages\/verser2-guest-python\/dist\/python/,
  );
  assert.match(python, /preflightStagedArtifacts/);
  assert.match(python, /Release artifact validation failed \(fail closed\)/);
  assert.match(
    python,
    /name:\s*verser2-guest-python-\$\{\{\s*needs\.tag-version-check\.outputs\.tag_version\s*\}\}[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.whl[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.tar\.gz/,
  );
  assert.match(python, /softprops\/action-gh-release@v2/);
  assert.match(
    python,
    /files:[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.whl[\s\S]*?packages\/verser2-guest-python\/dist\/python\/\*\.tar\.gz/,
  );
  assert.equal(
    /npm publish/.test(python),
    false,
    'Expected the Python release asset job to never publish JavaScript packages.',
  );
});

test('workflow publishes Python preview distributions through GitHub artifacts on main and nightly', () => {
  const content = loadWorkflow();
  const preview = jobSection(content, 'github-packages-preview');
  assert.match(preview, /Apply publish version to Python project/);
  assert.match(
    preview,
    /PUBLISH_VERSION:\s*\$\{\{\s*steps\.publish-metadata\.outputs\.python_version\s*\}\}/,
  );
  assert.match(preview, /python_version=\$\{policy\.toPythonVersion\(summary\.computedVersion\)\}/);
  assert.match(
    preview,
    /name:\s*verser2-guest-python-\$\{\{\s*steps\.publish-metadata\.outputs\.publish_version\s*\}\}/,
  );
});

test('workflow never publishes packages from pull request runs', () => {
  const content = loadWorkflow();
  for (const jobId of ['github-packages-preview', 'npmjs-publish', 'python-release-assets']) {
    const section = jobSection(content, jobId);
    const condition = section.match(/\n {4}if: (.*)/);
    assert.ok(condition, `Expected an explicit if condition on ${jobId}.`);
    assert.equal(
      /pull_request/.test(condition[1]),
      false,
      `Expected the ${jobId} job condition to never match pull request events.`,
    );
  }
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
    /Apply publish version to staged packages[\s\S]*?npm run test:package-tarballs[\s\S]*?npm publish --access public --tag/,
    'Expected publish flow to run tarball automated tests after version mutation and before direct npm publish.',
  );
});

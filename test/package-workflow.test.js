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

test('workflow sets required permissions for publish and scopes PR permissions to the post-release job', () => {
  const content = loadWorkflow();
  assert.equal(/contents:\s*read/.test(content), true);
  assert.equal(/packages:\s*write/.test(content), true);
  assert.equal(
    (content.match(/pull-requests:\s*write/g) ?? []).length,
    1,
    'Expected pull-requests: write on exactly one job.',
  );
  const postRelease = jobSection(content, 'post-release-next-pr');
  assert.match(postRelease, /contents:\s*write/);
  assert.match(postRelease, /pull-requests:\s*write/);
  for (const jobId of [
    'detect-package-changes',
    'package-validation',
    'tag-version-check',
    'github-packages-preview',
    'npmjs-publish',
    'github-packages-tag-prerelease',
    'python-release-assets',
  ]) {
    assert.equal(
      /pull-requests:/.test(jobSection(content, jobId)),
      false,
      `Expected ${jobId} to never request pull-requests permissions.`,
    );
  }
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

test('tag-version-check classifies the release channel and derives the next prerelease via the canonical policy helper', () => {
  const content = loadWorkflow();
  const check = jobSection(content, 'tag-version-check');
  assert.ok(
    check.includes('release_channel: ${{ steps.consistency.outputs.release_channel }}'),
    'Expected a release_channel job output from the tag check.',
  );
  assert.ok(
    check.includes('next_version: ${{ steps.consistency.outputs.next_version }}'),
    'Expected a next_version job output from the tag check.',
  );
  assert.ok(
    check.includes('release_channel=${summary.releaseChannel}'),
    'Expected the canonical policy summary to classify stable/prerelease.',
  );
  assert.ok(
    check.includes("publishKind: 'tag-release'"),
    'Expected the tag check to classify through the tag-release publish kind.',
  );
  assert.ok(
    check.includes("next_version=${summary.nextVersion ?? ''}"),
    'Expected the next prerelease version to come from the policy helper, not inline arithmetic.',
  );
});

test('npmjs-publish condition is skip-safe for manual dispatch and gated to stable tags', () => {
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
    /\(github\.ref_type == 'tag' && needs\.tag-version-check\.result == 'success' && needs\.tag-version-check\.outputs\.release_channel == 'stable'\)/,
    'Expected tag releases to publish to npmjs.org only for stable tags whose fail-closed check succeeded.',
  );
  assert.equal(
    /pull_request/.test(condition),
    false,
    'Expected the npmjs-publish condition to never match pull request events.',
  );
});

test('stable tags publish JavaScript only to npmjs.org and never to GitHub Packages', () => {
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
  const preview = jobSection(content, 'github-packages-preview');
  assert.equal(
    /refs\/tags\/v/.test(preview),
    false,
    'Expected the main-sha/nightly GitHub Packages preview job to never match tag refs.',
  );
  assert.equal(
    /tag-release/.test(preview),
    false,
    'Expected no tag-release publish kind in the GitHub Packages preview job.',
  );
});

test('prerelease tags publish JavaScript only to GitHub Packages with next and never to npmjs.org', () => {
  const content = loadWorkflow();
  const prerelease = jobSection(content, 'github-packages-tag-prerelease');
  const condition = prerelease.match(/\n {4}if: (.*)/)[1];
  assert.match(
    condition,
    /github\.ref_type == 'tag'/,
    'Expected the GitHub Packages tag publish job to run only for tag refs.',
  );
  assert.match(
    condition,
    /needs\.tag-version-check\.outputs\.release_channel == 'prerelease'/,
    'Expected the job to require the fail-closed check to classify the tag as prerelease.',
  );
  assert.match(
    condition,
    /needs\.tag-version-check\.result == 'success'/,
    'Expected the prerelease publish to require tag-version-check success.',
  );
  assert.equal(
    /registry\.npmjs\.org/.test(prerelease),
    false,
    'Expected prerelease tags to never touch the npmjs.org registry.',
  );
  assert.match(
    prerelease,
    /npm publish --access public --tag "\$\{DIST_TAG\}" --registry https:\/\/npm\.pkg\.github\.com/,
    'Expected prerelease tags to publish with public access to GitHub Packages.',
  );
  assert.ok(
    prerelease.includes('DIST_TAG: ${{ needs.tag-version-check.outputs.dist_tag }}'),
    'Expected the prerelease dist-tag to come from the canonical tag check (next for prereleases).',
  );
  assert.ok(
    prerelease.includes('PUBLISH_VERSION: ${{ needs.tag-version-check.outputs.tag_version }}'),
    'Expected the prerelease publish version to be the exact tag version.',
  );
  assert.match(prerelease, /packages: write/);
  assert.match(
    prerelease,
    /group: github-packages-tag-prerelease-\$\{\{ github\.ref_name \}\}/,
    'Expected job-level concurrency keyed by the release tag.',
  );
  // The npmjs job can never see a prerelease tag: its condition requires the
  // stable channel, and its metadata step re-checks the policy.
  const npmjs = jobSection(content, 'npmjs-publish');
  assert.match(npmjs, /summary\.releaseChannel !== policy\.RELEASE_CHANNEL_STABLE/);
  assert.match(
    npmjs,
    /prerelease tags publish JavaScript to GitHub Packages only, never npmjs\.org/,
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
  for (const jobId of [
    'github-packages-preview',
    'npmjs-publish',
    'github-packages-tag-prerelease',
    'python-release-assets',
    'post-release-next-pr',
  ]) {
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

test('registry publishes are rerun-safe and skip versions already present', () => {
  const content = loadWorkflow();
  const npmjs = jobSection(content, 'npmjs-publish');
  assert.match(
    npmjs,
    /npm view "\$\{packageName\}@\$\{PUBLISH_VERSION\}" version --registry https:\/\/registry\.npmjs\.org\//,
  );
  assert.match(npmjs, /already exists on npmjs\.org; skipping this package \(rerun-safe\)/);
  const prerelease = jobSection(content, 'github-packages-tag-prerelease');
  assert.match(
    prerelease,
    /npm view "\$\{packageName\}@\$\{PUBLISH_VERSION\}" version --registry https:\/\/npm\.pkg\.github\.com/,
  );
  assert.match(
    prerelease,
    /already exists in GitHub Packages; skipping this package \(rerun-safe\)/,
  );
  const preview = jobSection(content, 'github-packages-preview');
  assert.match(
    preview,
    /npm view "\$\{packageName\}@\$\{PUBLISH_VERSION\}" version --registry https:\/\/npm\.pkg\.github\.com/,
  );
  assert.match(preview, /already exists in GitHub Packages; skipping this package \(rerun-safe\)/);
  assert.ok(
    preview.includes('PUBLISH_VERSION: ${{ steps.publish-metadata.outputs.publish_version }}'),
    'Expected the preview rerun check to use the exact generated SHA/nightly version.',
  );
});

test('workflow never pushes directly to main and never force-pushes', () => {
  const content = loadWorkflow();
  assert.equal(
    /git push[^\n]*(refs\/heads\/)?main/.test(content),
    false,
    'Expected no git push targeting main.',
  );
  assert.equal(
    /git push[^\n]*--force/.test(content),
    false,
    'Expected no force push anywhere in the workflow.',
  );
  assert.equal(
    /git push[^\n]*-f\b/.test(content),
    false,
    'Expected no shorthand force push anywhere in the workflow.',
  );
  assert.equal(
    /git\s+add\s+dist/i.test(content),
    false,
    'Expected dist output to never be staged.',
  );
});

test('post-release PR job runs only for stable tags after both release jobs succeed', () => {
  const content = loadWorkflow();
  const postRelease = jobSection(content, 'post-release-next-pr');
  const condition = postRelease.match(/\n {4}if: (.*)/)[1];
  assert.match(condition, /needs\.tag-version-check\.outputs\.release_channel == 'stable'/);
  assert.match(condition, /needs\.npmjs-publish\.result == 'success'/);
  assert.match(condition, /needs\.python-release-assets\.result == 'success'/);
  assert.ok(
    postRelease.includes('needs: [tag-version-check, npmjs-publish, python-release-assets]'),
    'Expected the post-release job to depend on both release jobs and the tag check.',
  );
  assert.match(postRelease, /group: post-release-next-\$\{\{ github\.ref_name \}\}/);
  assert.match(postRelease, /cancel-in-progress: false/);
  // Prerelease tags must not produce a post-release PR.
  assert.equal(
    /release_channel == 'prerelease'/.test(condition),
    false,
    'Expected no prerelease routing into the post-release PR job.',
  );
});

test('post-release PR job is rerun-safe, branches from verified origin/main, and commits metadata only', () => {
  const content = loadWorkflow();
  const postRelease = jobSection(content, 'post-release-next-pr');
  assert.match(postRelease, /BRANCH="release\/post-\$\{RELEASE_TAG\}"/);
  assert.match(postRelease, /git fetch origin main/);
  assert.match(postRelease, /git merge-base --is-ancestor "\$TAG_SHA" origin\/main/);
  assert.match(postRelease, /refusing to branch/);
  assert.match(
    postRelease,
    /gh pr list --repo "\$GITHUB_REPOSITORY" --head "\$BRANCH" --base main --state open/,
  );
  assert.match(postRelease, /reusing it/);
  assert.match(postRelease, /git switch --create "\$BRANCH" origin\/main/);
  assert.match(postRelease, /git config user\.name "github-actions\[bot\]"/);
  assert.match(postRelease, /41898282\+github-actions\[bot\]@users\.noreply\.github\.com/);
  assert.match(postRelease, /npm run package:prepare-release -- --version "\$NEXT_VERSION"/);
  assert.match(
    postRelease,
    /NEXT_VERSION: \$\{\{ needs\.tag-version-check\.outputs\.next_version \}\}/,
  );
  assert.match(postRelease, /failing closed/);
  // Metadata-only commit allowlist with a fail-closed rejection for anything else.
  assert.match(
    postRelease,
    /git add packages\/\*\/package\.json package-lock\.json packages\/verser2-guest-python\/pyproject\.toml packages\/verser2-guest-python\/uv\.lock/,
  );
  assert.match(postRelease, /Refusing to commit non-metadata file/);
  // PR targets main through the normal protected flow; push is plain (no force).
  assert.match(postRelease, /gh pr create[\s\S]*?--base main[\s\S]*?--head "\$BRANCH"/);
  assert.match(postRelease, /git push --set-upstream origin "\$BRANCH"/);
  // Only the post-release job commits or pushes.
  for (const jobId of [
    'detect-package-changes',
    'package-validation',
    'tag-version-check',
    'github-packages-preview',
    'npmjs-publish',
    'github-packages-tag-prerelease',
    'python-release-assets',
  ]) {
    const section = jobSection(content, jobId);
    assert.equal(
      /git commit|git push/.test(section),
      false,
      `Expected ${jobId} to never commit or push.`,
    );
  }
});

test('post-release PR job fails closed when a reused branch carries non-metadata commits', () => {
  const content = loadWorkflow();
  const postRelease = jobSection(content, 'post-release-next-pr');

  const branchDiffGuardIndex = postRelease.indexOf(
    'for branchFile in $(git diff --name-only --no-renames origin/main...HEAD); do',
  );
  const openPrReuseIndex = postRelease.indexOf(
    'gh pr list --repo "$GITHUB_REPOSITORY" --head "$BRANCH" --base main --state open --json number --limit 1',
  );
  assert.ok(branchDiffGuardIndex >= 0, 'Expected the complete branch-diff guard block.');
  assert.ok(openPrReuseIndex >= 0, 'Expected the open-PR reuse check.');
  assert.ok(
    openPrReuseIndex > branchDiffGuardIndex,
    'Expected the branch-diff guard to run before any open-PR reuse exit.',
  );

  // The COMPLETE committed branch diff relative to origin/main is inspected
  // before package:prepare-release runs, so a pre-existing deterministic branch
  // reused from a prior partial run (or an unexpected push) cannot smuggle
  // non-metadata changes into the release PR. --no-renames keeps a rename
  // visible as a delete of the disallowed source path.
  assert.match(
    postRelease,
    /git diff --name-only --no-renames origin\/main\.\.\.HEAD/,
    'Expected a complete branch diff check against origin/main.',
  );

  // The branch diff guard allows only the approved source-version metadata.
  assert.match(
    postRelease,
    /for branchFile in \$\(git diff --name-only --no-renames origin\/main\.\.\.HEAD\); do[\s\S]*?packages\/\*\/package\.json\|package-lock\.json\|packages\/verser2-guest-python\/pyproject\.toml\|packages\/verser2-guest-python\/uv\.lock\)/,
    'Expected the branch diff guard to allow only approved metadata paths.',
  );

  // A clear, distinct fail-closed error for non-metadata branch diffs.
  assert.match(
    postRelease,
    /Refusing to prepare a release: branch \$\{BRANCH\} differs from origin\/main by non-metadata file: \$\{branchFile\}/,
    'Expected a clear fail-closed error naming the offending branch file.',
  );

  // Ordering: the guard runs after switching to the deterministic branch and
  // before package:prepare-release mutates anything.
  assert.match(
    postRelease,
    /git switch[\s\S]*?git diff --name-only --no-renames origin\/main\.\.\.HEAD[\s\S]*?npm run package:prepare-release/,
    'Expected the branch diff guard to run after the branch switch and before package:prepare-release.',
  );

  // The existing staged-diff allowlist is preserved as a second, independent
  // guard on what package:prepare-release stages.
  assert.match(
    postRelease,
    /for stagedFile in \$\(git diff --cached --name-only\); do/,
    'Expected the staged-diff allowlist to be preserved.',
  );
  assert.match(postRelease, /Refusing to commit non-metadata file/);
});

test('post-release automation identity is DCO-exempt in the signoff workflow', () => {
  const content = loadWorkflow();
  const postRelease = jobSection(content, 'post-release-next-pr');
  // The post-release job commits under the github-actions[bot] identity.
  assert.match(postRelease, /git config user\.name "github-actions\[bot\]"/);
  assert.match(postRelease, /41898282\+github-actions\[bot\]@users\.noreply\.github\.com/);

  // That same identity must be DCO-exempt, or the automated commit fails the
  // required DCO check on the post-release pull request.
  const signoffPath = path.join(rootDirectory, '.github', 'workflows', 'signoff.yml');
  const signoff = fs.readFileSync(signoffPath, 'utf8');
  assert.match(
    signoff,
    /DCO_EXEMPT_USERS:[^\n]*github-actions\[bot\]/,
    'Expected github-actions[bot] to be listed in the signoff DCO exemption.',
  );
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

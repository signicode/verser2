#!/usr/bin/env node

const { execFileSync } = require('node:child_process');

function readEnvironment(name, fallback = '') {
  return process.env[name] || fallback;
}

function splitCsv(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function getCommitMessages(baseRef, headRef) {
  const range = `${baseRef}..${headRef}`;
  const output = run('git', ['log', '--format=%H%x00%B%x00END_COMMIT%x00', range]);
  if (!output) {
    return [];
  }

  return output
    .split('\0END_COMMIT\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, ...messageParts] = entry.split('\0');
      return { sha, message: messageParts.join('\0') };
    });
}

function hasSignedOffBy(message) {
  return /^Signed-off-by:\s+.+\s+<[^<>@\s]+@[^<>\s]+>\s*$/imu.test(message);
}

function main() {
  const prAuthor = readEnvironment('PR_AUTHOR');
  const baseRef = readEnvironment('BASE_REF', 'origin/main');
  const headRef = readEnvironment('HEAD_REF', 'HEAD');
  const exemptUsers = splitCsv(readEnvironment('DCO_EXEMPT_USERS'));
  const teamExempt = readEnvironment('DCO_TEAM_EXEMPT', 'false') === 'true';

  if (exemptUsers.includes(prAuthor) || teamExempt) {
    console.log(`Skipping signoff check for trusted contributor: ${prAuthor}`);
    return;
  }

  const commits = getCommitMessages(baseRef, headRef);
  const unsignedCommits = commits.filter((commit) => !hasSignedOffBy(commit.message));

  if (unsignedCommits.length > 0) {
    console.error('External contributions must include a DCO-style Signed-off-by trailer.');
    console.error('Add it with `git commit --signoff` or `git commit -s`.');
    for (const commit of unsignedCommits) {
      console.error(`Missing Signed-off-by: ${commit.sha}`);
    }
    process.exit(1);
  }

  console.log(`All ${commits.length} commit(s) include Signed-off-by trailers.`);
}

main();

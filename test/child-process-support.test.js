const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  collectChildProcessResult,
  createBoundedTextCollector,
} = require('./support/child-process.cjs');

test('bounded child-process output collector truncates retained output', () => {
  const collector = createBoundedTextCollector(5);

  collector.write(Buffer.from('abc'));
  collector.write(Buffer.from('defgh'));

  const result = collector.result();

  assert.equal(result.text, 'abcde');
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, 8);
});

test('child process result collection kills timed-out subprocesses with bounded output', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30_000);']);

  const result = await collectChildProcessResult(child, {
    timeoutMs: 100,
    maxOutputBytes: 16,
  });

  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, '');
  assert.equal(result.stdoutTruncated, false);
});

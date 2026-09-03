#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Shared, non-drifting publish artifact requirements (also used by staging,
// package readiness, and this runner's --skip-build-stage preflight).
const { preflightStagedArtifacts, safePackageName } = require('./staged-artifacts.js');

const DEFAULT_OLD_SPACE_SIZE_MB = 512;
const DEFAULT_SEMI_SPACE_SIZE_MB = 16;
const DEFAULT_MEMORY_LEAK_BYTES = 1024 * 1024;
const DEFAULT_TEST_CONCURRENCY = 1;
const TEST_TIMEOUT_MS = 10_000;

function usage() {
  return [
    'Usage: node ./scripts/run-bounded-tests.js [options] [-- <test-file>...]',
    '',
    'Builds packages, stages package artifacts, then runs two deterministic node --test partitions with bounded V8 heap settings.',
    '',
    'Options:',
    '  --coverage                 Enable Node test coverage.',
    '  --old-space-size <mb>      Set V8 old-space heap limit. Default: 512.',
    '  --semi-space-size <mb>     Set V8 semi-space size. Default: 16.',
    '  --memory-leak-bytes <n>    Per-test post-GC memory growth limit for guarded tests. Default: 1048576.',
    '  --test-concurrency <n>     node --test concurrency. Default: 1.',
    '  --skip-build-stage         Skip the build and staging steps. Allowed only when the',
    '                             preflight confirms the complete staged publish set exists:',
    '                             per staged package package.json, dist/index.js,',
    '                             dist/index.d.ts, LICENSE, README.md, plus real Python',
    '                             wheel and source-distribution files.',
    '  --live-timestamps          Stream each test child process stdout/stderr with monotonic',
    '                             relative timestamps and stream/partition labels instead of',
    '                             inheriting raw TAP output. Partial lines are buffered and',
    '                             final partial output is flushed; child exit/signal semantics',
    '                             are preserved.',
    '  --help                     Show this help text.',
    '',
    'Examples:',
    '  npm run test:bounded',
    '  npm run test:bounded -- -- test/broker-routing.test.js',
    '  npm run test:bounded:staged',
  ].join('\n');
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

function parseArgs(argv) {
  const options = {
    coverage: false,
    oldSpaceSizeMb: DEFAULT_OLD_SPACE_SIZE_MB,
    semiSpaceSizeMb: DEFAULT_SEMI_SPACE_SIZE_MB,
    memoryLeakBytes: DEFAULT_MEMORY_LEAK_BYTES,
    testConcurrency: DEFAULT_TEST_CONCURRENCY,
    skipBuildStage: false,
    liveTimestamps: false,
    testFiles: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--coverage') {
      options.coverage = true;
      continue;
    }

    if (arg === '--skip-build-stage') {
      options.skipBuildStage = true;
      continue;
    }

    if (arg === '--live-timestamps') {
      options.liveTimestamps = true;
      continue;
    }

    if (arg === '--') {
      const explicitFiles = argv.slice(index + 1);
      if (explicitFiles.some((file) => file.startsWith('-'))) {
        throw new Error('Test file paths must not begin with a hyphen');
      }
      options.testFiles.push(...explicitFiles);
      break;
    }

    if (arg === '--old-space-size') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --old-space-size');
      }
      options.oldSpaceSizeMb = parsePositiveInteger(next, '--old-space-size');
      index += 1;
      continue;
    }

    if (arg.startsWith('--old-space-size=')) {
      options.oldSpaceSizeMb = parsePositiveInteger(
        arg.slice('--old-space-size='.length),
        '--old-space-size',
      );
      continue;
    }

    if (arg === '--semi-space-size') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --semi-space-size');
      }
      options.semiSpaceSizeMb = parsePositiveInteger(next, '--semi-space-size');
      index += 1;
      continue;
    }

    if (arg === '--memory-leak-bytes') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --memory-leak-bytes');
      }
      options.memoryLeakBytes = parsePositiveInteger(next, '--memory-leak-bytes');
      index += 1;
      continue;
    }

    if (arg.startsWith('--memory-leak-bytes=')) {
      options.memoryLeakBytes = parsePositiveInteger(
        arg.slice('--memory-leak-bytes='.length),
        '--memory-leak-bytes',
      );
      continue;
    }

    if (arg.startsWith('--semi-space-size=')) {
      options.semiSpaceSizeMb = parsePositiveInteger(
        arg.slice('--semi-space-size='.length),
        '--semi-space-size',
      );
      continue;
    }

    if (arg === '--test-concurrency') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --test-concurrency');
      }
      options.testConcurrency = parsePositiveInteger(next, '--test-concurrency');
      index += 1;
      continue;
    }

    if (arg.startsWith('--test-concurrency=')) {
      options.testConcurrency = parsePositiveInteger(
        arg.slice('--test-concurrency='.length),
        '--test-concurrency',
      );
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unsupported argument: ${arg}; timeout bypasses are not supported`);
    }

    options.testFiles.push(arg);
  }

  return options;
}

/** Formats a monotonic relative timestamp for live-timestamp streaming. */
function formatLiveTimestamp(startHrtime, nowHrtime) {
  const elapsedMs = Number(nowHrtime - startHrtime) / 1e6;
  return `[t+${elapsedMs.toFixed(1)}ms]`;
}

/**
 * Pipes one child stream through a line buffer that emits complete lines
 * (and one final partial line at end) to `writeLine`. Partial lines are never
 * emitted early; a trailing newline-less remainder is flushed as a final
 * line when the stream ends or closes.
 */
function pipeStreamWithLineBuffering(source, writeLine) {
  let pending = '';
  let flushed = false;
  const flushRemainder = () => {
    if (flushed) {
      return;
    }
    flushed = true;
    if (pending.length > 0) {
      writeLine(pending);
      pending = '';
    }
  };
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    pending += chunk;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      writeLine(line);
      newlineIndex = pending.indexOf('\n');
    }
  });
  source.on('end', flushRemainder);
  source.on('close', flushRemainder);
}

/**
 * Runs one command with piped stdout/stderr, prefixing every completed child
 * line with a monotonic relative timestamp and a `[label:stream]` marker.
 * Resolves with the child exit code/signal, mirroring `runCommand` semantics.
 */
function runCommandWithLiveTimestamps(
  command,
  args,
  { env, label, cwd, startHrtime, stdout, stderr },
) {
  const stdoutTarget = stdout ?? process.stdout;
  const stderrTarget = stderr ?? process.stderr;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env,
      cwd,
    });
    const emit = (streamLabel, target) => (line) => {
      target.write(
        `${formatLiveTimestamp(startHrtime, process.hrtime.bigint())}[${streamLabel}] ${line}\n`,
      );
    };
    pipeStreamWithLineBuffering(child.stdout, emit(`${label}:stdout`, stdoutTarget));
    pipeStreamWithLineBuffering(child.stderr, emit(`${label}:stderr`, stderrTarget));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

function mergeNodeOptions(existingNodeOptions, { oldSpaceSizeMb, semiSpaceSizeMb }) {
  return [
    existingNodeOptions,
    `--max-old-space-size=${oldSpaceSizeMb}`,
    `--max-semi-space-size=${semiSpaceSizeMb}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function exitForChildOutcome({ code, signal }) {
  // Preserve the synchronous path's semantics: non-zero status exits with it,
  // and signal termination (status null) exits 1.
  if (code === 0) {
    return;
  }
  if (signal) {
    console.error(`Command terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
}

function resolveTestFiles(explicitFiles) {
  if (explicitFiles.length > 0) {
    return [...explicitFiles].sort();
  }
  return fs
    .readdirSync(path.resolve(__dirname, '..', 'test'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.posix.join('test', entry.name))
    .sort();
}

function partitionTestFiles(testFiles) {
  const midpoint = Math.ceil(testFiles.length / 2);
  return [testFiles.slice(0, midpoint), testFiles.slice(midpoint)];
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const rootDirectory = path.resolve(__dirname, '..');
  if (options.skipBuildStage) {
    const missing = preflightStagedArtifacts(rootDirectory);
    if (missing.length > 0) {
      console.error(
        `--skip-build-stage requires staged package artifacts; missing:\n${missing
          .map((item) => `  - ${item}`)
          .join('\n')}`,
      );
      process.exit(1);
    }
  }

  const testFiles = resolveTestFiles(options.testFiles);
  const partitions = partitionTestFiles(testFiles).filter((partition) => partition.length > 0);

  const runEnv = {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS || '', options),
    VERSER_TEST_MEMORY_GUARD: '1',
    VERSER_TEST_MEMORY_LEAK_BYTES: String(options.memoryLeakBytes),
  };

  const startHrtime = process.hrtime.bigint();
  const logStatus = (line) => {
    if (options.liveTimestamps) {
      for (const physicalLine of line.split('\n')) {
        process.stdout.write(
          `${formatLiveTimestamp(startHrtime, process.hrtime.bigint())}[runner:stdout] ${physicalLine}\n`,
        );
      }
      return;
    }
    console.log(line);
  };

  logStatus(
    `Running bounded tests in ${partitions.length} deterministic partitions with --max-old-space-size=${options.oldSpaceSizeMb}, --max-semi-space-size=${options.semiSpaceSizeMb}, --test-concurrency=${options.testConcurrency}, --test-timeout=${TEST_TIMEOUT_MS}, and guarded per-test memory growth <= ${options.memoryLeakBytes} bytes`,
  );

  const testArgs = ['--expose-gc', '--test', `--test-concurrency=${options.testConcurrency}`];
  if (options.coverage) {
    testArgs.push('--experimental-test-coverage');
  }
  testArgs.push(`--test-timeout=${TEST_TIMEOUT_MS}`);

  const runOne = options.liveTimestamps
    ? async (command, args, label) => {
        exitForChildOutcome(
          await runCommandWithLiveTimestamps(command, args, {
            env: runEnv,
            label,
            cwd: rootDirectory,
            startHrtime,
          }),
        );
      }
    : async (command, args, label) => {
        runCommand(command, args, { env: runEnv, cwd: rootDirectory });
      };

  try {
    if (!options.skipBuildStage) {
      await runOne(npmCommand(), ['run', 'build'], 'build');
      await runOne(npmCommand(), ['run', 'stage:packages'], 'stage');
    }
    for (const [index, partition] of partitions.entries()) {
      const partitionArgs = [...testArgs, '--', ...partition];
      logStatus(
        `\n=== bounded test partition ${index + 1}/${partitions.length} (${partition.join(', ')}) ===`,
      );
      const startedAt = Date.now();
      await runOne(process.execPath, partitionArgs, `p${index + 1}`);
      logStatus(`=== partition ${index + 1} completed in ${Date.now() - startedAt} ms ===`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  parseArgs,
  partitionTestFiles,
  resolveTestFiles,
  preflightStagedArtifacts,
  safePackageName,
  formatLiveTimestamp,
  pipeStreamWithLineBuffering,
  runCommandWithLiveTimestamps,
};

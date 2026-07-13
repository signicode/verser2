#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OLD_SPACE_SIZE_MB = 512;
const DEFAULT_SEMI_SPACE_SIZE_MB = 16;
const DEFAULT_MEMORY_LEAK_BYTES = 1024 * 1024;
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
    '  --help                     Show this help text.',
    '',
    'Examples:',
    '  npm run test:bounded',
    '  npm run test:bounded -- -- test/broker-routing.test.js',
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

    if (arg.startsWith('-')) {
      throw new Error(`Unsupported argument: ${arg}; timeout bypasses are not supported`);
    }

    options.testFiles.push(arg);
  }

  return options;
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

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const testFiles = resolveTestFiles(options.testFiles);
  const partitions = partitionTestFiles(testFiles).filter((partition) => partition.length > 0);

  const runEnv = {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS || '', options),
    VERSER_TEST_MEMORY_GUARD: '1',
    VERSER_TEST_MEMORY_LEAK_BYTES: String(options.memoryLeakBytes),
  };

  console.log(
    `Running bounded tests in ${partitions.length} deterministic partitions with --max-old-space-size=${options.oldSpaceSizeMb}, --max-semi-space-size=${options.semiSpaceSizeMb}, --test-concurrency=1, --test-timeout=${TEST_TIMEOUT_MS}, and guarded per-test memory growth <= ${options.memoryLeakBytes} bytes`,
  );

  runCommand(npmCommand(), ['run', 'build'], { env: runEnv });
  runCommand(npmCommand(), ['run', 'stage:packages'], { env: runEnv });
  partitions.forEach((partition, index) => {
    const testArgs = [
      '--expose-gc',
      '--test',
      '--test-concurrency=1',
      `--test-timeout=${TEST_TIMEOUT_MS}`,
    ];
    if (options.coverage) {
      testArgs.push('--experimental-test-coverage');
    }
    testArgs.push('--', ...partition);
    const startedAt = Date.now();
    console.log(
      `\n=== bounded test partition ${index + 1}/${partitions.length} (${partition.join(', ')}) ===`,
    );
    runCommand(process.execPath, testArgs, { env: runEnv });
    console.log(`=== partition ${index + 1} completed in ${Date.now() - startedAt} ms ===`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, partitionTestFiles, resolveTestFiles };

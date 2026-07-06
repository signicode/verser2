#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const DEFAULT_OLD_SPACE_SIZE_MB = 512;
const DEFAULT_SEMI_SPACE_SIZE_MB = 16;
const DEFAULT_MEMORY_LEAK_BYTES = 64 * 1024;
const DEFAULT_TEST_FILES = ['test/*.test.js'];

function usage() {
  return [
    'Usage: node ./scripts/run-bounded-tests.js [options] [-- <test-file>...]',
    '',
    'Builds packages, stages package artifacts, then runs node --test with bounded V8 heap settings.',
    '',
    'Options:',
    '  --coverage                 Enable Node test coverage.',
    '  --old-space-size <mb>      Set V8 old-space heap limit. Default: 512.',
    '  --semi-space-size <mb>     Set V8 semi-space size. Default: 16.',
    '  --memory-leak-bytes <n>    Per-test post-GC memory growth limit for guarded tests. Default: 65536.',
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
      options.testFiles.push(...argv.slice(index + 1));
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
      throw new Error(`Unsupported argument: ${arg}`);
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

  const testFiles = options.testFiles.length > 0 ? options.testFiles : DEFAULT_TEST_FILES;
  const testArgs = ['--expose-gc', '--test', '--test-concurrency=1'];
  if (options.coverage) {
    testArgs.push('--experimental-test-coverage');
  }
  testArgs.push(...testFiles);

  const runEnv = {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS || '', options),
    VERSER_TEST_MEMORY_GUARD: '1',
    VERSER_TEST_MEMORY_LEAK_BYTES: String(options.memoryLeakBytes),
  };

  console.log(
    `Running bounded tests with --max-old-space-size=${options.oldSpaceSizeMb}, --max-semi-space-size=${options.semiSpaceSizeMb}, --test-concurrency=1, and guarded per-test memory growth <= ${options.memoryLeakBytes} bytes`,
  );

  runCommand(npmCommand(), ['run', 'build'], { env: runEnv });
  runCommand(npmCommand(), ['run', 'stage:packages'], { env: runEnv });
  runCommand(process.execPath, testArgs, { env: runEnv });
}

main();

const nodeTest = require('node:test');

const DEFAULT_MEMORY_LEAK_BYTES = 1024 * 1024;

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `VERSER_TEST_MEMORY_LEAK_BYTES must be a non-negative integer, received: ${value}`,
    );
  }
  return parsed;
}

function guardEnabled() {
  return process.env.VERSER_TEST_MEMORY_GUARD === '1';
}

function measuredBytes() {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external + usage.arrayBuffers;
}

function collect() {
  if (typeof global.gc !== 'function') {
    throw new Error(
      'VERSER_TEST_MEMORY_GUARD requires Node to run with --expose-gc so post-test leaks are measured after garbage collection.',
    );
  }
  global.gc();
  global.gc();
}

function wrapTestBody(name, body, memoryLeakBytes) {
  if (!guardEnabled() || typeof body !== 'function') {
    return body;
  }

  const leakLimit = parseNonNegativeInteger(
    memoryLeakBytes ?? process.env.VERSER_TEST_MEMORY_LEAK_BYTES,
    DEFAULT_MEMORY_LEAK_BYTES,
  );

  return async function guardedTestBody(...args) {
    collect();
    const before = measuredBytes();
    let result;
    let bodyError;
    try {
      result = await body(...args);
    } catch (error) {
      bodyError = error;
    }

    collect();
    const after = measuredBytes();
    const delta = after - before;
    if (delta > leakLimit) {
      throw new Error(
        `Post-test memory growth ${delta} bytes exceeds ${leakLimit} bytes in ${name}. Streaming tests must consume bodies incrementally, must not retain generated bodies for inspection, and must destroy all streams in finally blocks.`,
      );
    }

    if (bodyError !== undefined) {
      throw bodyError;
    }

    return result;
  };
}

function guardedTest(name, options, body) {
  if (typeof options === 'function' || options === undefined) {
    return nodeTest.test(name, wrapTestBody(String(name), options));
  }

  const { memoryLeakBytes, ...nodeTestOptions } = options;
  return nodeTest.test(name, nodeTestOptions, wrapTestBody(String(name), body, memoryLeakBytes));
}

guardedTest.skip = nodeTest.test.skip;
guardedTest.todo = nodeTest.test.todo;
guardedTest.only = nodeTest.test.only;

module.exports = guardedTest;
module.exports.test = guardedTest;
module.exports.describe = nodeTest.describe;
module.exports.it = nodeTest.it;
module.exports.before = nodeTest.before;
module.exports.after = nodeTest.after;
module.exports.beforeEach = nodeTest.beforeEach;
module.exports.afterEach = nodeTest.afterEach;

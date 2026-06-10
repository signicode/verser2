const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserBroker } = loadVerserGuestNode();
const { createVerserHost } = loadVerserHost();

const rootDirectory = path.resolve(__dirname, '..');
const bunGuestExamplePath = path.join(
  rootDirectory,
  'packages',
  'verser2-guest-bun',
  'examples',
  'runtime_guest.ts',
);

function createHost(options = {}) {
  return createVerserHost({
    ...options,
    tls: {
      cert: trusted.certificate,
      key: trusted.key,
      ...options.tls,
    },
  });
}

function createBroker(options) {
  return createVerserBroker({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

async function readBody(stream) {
  if (stream == null) {
    return Buffer.alloc(0);
  }

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function withTimeout(promise, label, timeoutMs = 30_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs),
    ),
  ]);
}

function waitForProcessOutput(process, pattern, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    process.stdout.on('data', (chunk) => {
      if (pattern.test(chunk.toString('utf8'))) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on('data', (chunk) => {
      const output = chunk.toString('utf8');
      if (/Traceback|Error|Exception/.test(output)) {
        clearTimeout(timeout);
        reject(new Error(output));
      }
    });
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`${label} exited before ready: code=${code} signal=${signal}`));
    });
  });
}

function terminateChildProcess(
  childProcess,
  { timeoutMs = 10_000, terminationSignal = 'SIGTERM', killSignal = 'SIGKILL' } = {},
) {
  if (!childProcess || childProcess.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let terminated = false;

    const finalize = () => {
      if (terminated) {
        return;
      }

      terminated = true;
      clearTimeout(terminationTimeoutId);
      clearTimeout(forceKillTimeoutId);
      childProcess.off('exit', onExit);
      resolve();
    };

    const onExit = () => {
      finalize();
    };

    const forceKillTimeoutId = setTimeout(() => {
      if (!terminated && childProcess.exitCode === null) {
        try {
          childProcess.kill(killSignal);
        } catch {
          // Ignore and allow final timeout to resolve cleanup.
        }
      }
    }, timeoutMs / 2);

    const terminationTimeoutId = setTimeout(() => {
      finalize();
    }, timeoutMs);

    childProcess.once('exit', onExit);
    if (childProcess.exitCode !== null) {
      finalize();
      return;
    }

    try {
      childProcess.kill(terminationSignal);
    } catch {
      finalize();
    }
  });
}

function closeWithTimeout(closeable, label, timeoutMs = 5_000) {
  return Promise.resolve()
    .then(() => withTimeout(closeable.close('test-complete'), label, timeoutMs))
    .catch(() => {});
}

function hasBun() {
  const result = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

test(
  'Bun runtime Guest spawned via bun receives Broker-routed requests',
  {
    skip: hasBun() ? false : 'Skipping Bun Guest integration because bun is not installed.',
    timeout: 60_000,
  },
  async () => {
    const host = createHost({ port: 0 });
    await host.start();
    const hostUrl = `https://127.0.0.1:${host.address.port}`;
    const broker = createBroker({
      hostUrl,
      brokerId: 'broker-bun-runtime',
    });

    const guestProcess = spawn('bun', [bunGuestExamplePath], {
      cwd: rootDirectory,
      env: {
        ...process.env,
        VERSER_HOST_URL: hostUrl,
        VERSER_TLS_CA_FILE: trusted.certificatePath,
        VERSER_GUEST_ID: 'guest-bun-runtime',
        VERSER_GUEST_DOMAIN: 'bun-runtime.local.test',
      },
    });
    const guestReady = waitForProcessOutput(
      guestProcess,
      /bun guest ready/i,
      'Bun runtime guest startup',
    );
    const streamUpload = new PassThrough();

    try {
      await withTimeout(broker.connect(), 'Bun broker connect', 5_000);
      await withTimeout(guestReady, 'Bun runtime guest startup');
      await withTimeout(
        broker.waitForRoute('bun-runtime.local.test'),
        'Bun guest route advertisement',
      );

      const basicResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'POST',
          path: '/from-broker?x=1',
          headers: { 'x-input': 'abc' },
          body: [Buffer.from('payload')],
        }),
        'Bun runtime basic request',
      );
      assert.equal(basicResponse.statusCode, 214);
      assert.equal(
        (await readBody(basicResponse.body)).toString('utf8'),
        'POST /from-broker abc payload',
      );

      const chunkedRequestResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'POST',
          path: '/from-broker?x=2',
          headers: { 'x-input': 'chunked' },
          body: [Buffer.from('one'), Buffer.from('two')],
        }),
        'Bun runtime chunked request',
      );
      assert.equal(chunkedRequestResponse.statusCode, 214);
      assert.equal(
        (await readBody(chunkedRequestResponse.body)).toString('utf8'),
        'POST /from-broker chunked onetwo',
      );

      streamUpload.write(Buffer.from('stream-marker'));
      const streamedResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'POST',
          path: '/stream-response',
          headers: { 'x-input': 'stream' },
          body: streamUpload,
        }),
        'Bun runtime streamed response',
      );
      streamUpload.end();
      assert.equal(streamedResponse.statusCode, 217);
      assert.deepEqual(await readBody(streamedResponse.body), Buffer.from('onetwo'));

      const binaryPayload = Buffer.from([0, 1, 2, 3, 255, 254, 253, 252]);
      const binaryResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'POST',
          path: '/binary',
          headers: { 'x-input': 'bin' },
          body: [binaryPayload],
        }),
        'Bun runtime binary response',
      );
      const binaryBody = await readBody(binaryResponse.body);
      const expectedBinary = Buffer.concat([
        Buffer.from([0, 1, 2, 255]),
        Buffer.from('|bin|'),
        binaryPayload,
      ]);
      assert.equal(binaryResponse.statusCode, 218);
      assert.equal(binaryResponse.headers['x-binary'], 'true');
      assert.deepEqual(binaryBody, expectedBinary);

      const upgradeResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/upgrade',
        }),
        'Bun runtime upgrade check',
      );
      assert.equal(upgradeResponse.statusCode, 200);
      assert.deepEqual(await readBody(upgradeResponse.body), Buffer.from('false'));

      assert.deepEqual(broker.getRoutes(), [
        { targetId: 'guest-bun-runtime', domain: 'bun-runtime.local.test' },
      ]);
    } finally {
      streamUpload.end();
      await withTimeout(terminateChildProcess(guestProcess), 'Bun guest terminate');
      await closeWithTimeout(broker, 'Bun broker close');
      await closeWithTimeout(host, 'Bun host close');
    }
  },
);

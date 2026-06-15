const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient } = require('./support/tls-fixtures.cjs');
const { terminateChildProcess } = require('./support/child-process.cjs');

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
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
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
      /bun broker self-check ready/i,
      'Bun runtime guest startup',
    );
    const streamUpload = new PassThrough();
    const streamRequestUpload = new PassThrough();

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

      const repeatedStatusFirst = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/status',
          headers: { 'x-input': 'ignored' },
        }),
        'Bun runtime static route first hit',
      );
      assert.equal(repeatedStatusFirst.statusCode, 200);
      assert.deepEqual(await readBody(repeatedStatusFirst.body), Buffer.from('ok'));

      const repeatedStatusSecond = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/status',
        }),
        'Bun runtime static route second hit',
      );
      assert.equal(repeatedStatusSecond.statusCode, 200);
      assert.deepEqual(await readBody(repeatedStatusSecond.body), Buffer.from('ok'));

      const paramResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/users/abc-123',
        }),
        'Bun runtime param route',
      );
      assert.equal(paramResponse.statusCode, 200);
      assert.deepEqual(await readBody(paramResponse.body), Buffer.from('user:abc-123'));

      const wildcardResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/files/prefix/tree.txt',
        }),
        'Bun runtime wildcard route',
      );
      assert.equal(wildcardResponse.statusCode, 200);
      assert.deepEqual(await readBody(wildcardResponse.body), Buffer.from('wildcard'));

      const itemsGetResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/items',
        }),
        'Bun runtime method route GET',
      );
      assert.equal(itemsGetResponse.statusCode, 200);
      assert.deepEqual(await readBody(itemsGetResponse.body), Buffer.from('read'));

      const itemsPostResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'POST',
          path: '/items',
        }),
        'Bun runtime method route POST',
      );
      assert.equal(itemsPostResponse.statusCode, 201);
      assert.deepEqual(await readBody(itemsPostResponse.body), Buffer.from('create'));

      const fallbackResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/fallback',
        }),
        'Bun runtime fetch fallback',
      );
      assert.equal(fallbackResponse.statusCode, 214);
      assert.deepEqual(await readBody(fallbackResponse.body), Buffer.from('GET /fallback  '));

      streamRequestUpload.write(Buffer.from('stream-'));
      streamRequestUpload.write(Buffer.from('body'));
      streamRequestUpload.end();
      const requestEchoResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'PUT',
          path: '/request-echo?x=streamed&mode=check',
          headers: { 'x-input': 'header-value' },
          body: streamRequestUpload,
        }),
        'Bun runtime request echo',
      );
      assert.equal(requestEchoResponse.statusCode, 222);
      const requestEchoBody = (await readBody(requestEchoResponse.body)).toString('utf8');
      const requestEchoJson = JSON.parse(requestEchoBody);
      assert.equal(requestEchoJson.method, 'PUT');
      assert.equal(requestEchoJson.path, '/request-echo');
      assert.equal(requestEchoJson.query, '?x=streamed&mode=check');
      assert.equal(requestEchoJson.header, 'header-value');
      assert.equal(requestEchoJson.body, 'stream-body');

      const jsonResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/response-json',
        }),
        'Bun runtime response json',
      );
      assert.equal(jsonResponse.statusCode, 200);
      assert.equal(
        (jsonResponse.headers['content-type'] ?? '').startsWith('application/json'),
        true,
      );
      const jsonBody = JSON.parse((await readBody(jsonResponse.body)).toString('utf8'));
      assert.equal(jsonBody.ok, true);

      const iterableResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/response-iterable',
        }),
        'Bun runtime response iterable',
      );
      assert.equal(iterableResponse.statusCode, 219);
      assert.equal(iterableResponse.headers['content-type'], 'text/plain');
      assert.deepEqual(await readBody(iterableResponse.body), Buffer.from('onetwo'));

      const readableResponse = await withTimeout(
        broker.request({
          targetId: 'guest-bun-runtime',
          method: 'GET',
          path: '/response-node-readable',
        }),
        'Bun runtime response readable',
      );
      assert.equal(readableResponse.statusCode, 220);
      assert.equal(readableResponse.headers['content-type'], 'text/plain');
      assert.deepEqual(await readBody(readableResponse.body), Buffer.from('node-readable'));

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
      await withTimeout(
        terminateChildProcess(guestProcess, { timeoutMs: 1_000 }),
        'Bun guest terminate',
        2_000,
      );
      await closeWithTimeout(broker, 'Bun broker close');
      await closeWithTimeout(host, 'Bun host close');
    }
  },
);

test(
  'Bun runtime Guest and Bun package Broker connect through mTLS Host',
  {
    skip: hasBun() ? false : 'Skipping Bun Guest mTLS integration because bun is not installed.',
    timeout: 60_000,
  },
  async () => {
    const host = createHost({
      port: 0,
      tls: {
        clientAuth: { ca: clientCa.certificate },
      },
    });
    await host.start();
    const hostUrl = `https://127.0.0.1:${host.address.port}`;
    const guestProcess = spawn('bun', [bunGuestExamplePath], {
      cwd: rootDirectory,
      env: {
        ...process.env,
        VERSER_HOST_URL: hostUrl,
        VERSER_TLS_CA_FILE: trusted.certificatePath,
        VERSER_TLS_CERT_FILE: trustedClient.certificatePath,
        VERSER_TLS_KEY_FILE: trustedClient.keyPath,
        VERSER_GUEST_ID: 'guest-bun-mtls-runtime',
        VERSER_GUEST_DOMAIN: 'bun-mtls-runtime.local.test',
      },
    });

    try {
      await withTimeout(
        waitForProcessOutput(
          guestProcess,
          /bun broker self-check ready/i,
          'Bun mTLS runtime guest startup',
        ),
        'Bun mTLS runtime guest startup',
      );
    } finally {
      await withTimeout(
        terminateChildProcess(guestProcess, { timeoutMs: 1_000 }),
        'Bun mTLS Guest termination',
        2_000,
      );
      await closeWithTimeout(host, 'Bun mTLS Host close');
    }
  },
);

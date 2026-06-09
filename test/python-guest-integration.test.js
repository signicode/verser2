const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker } = loadVerserGuestNode();

const rootDirectory = path.resolve(__dirname, '..');
const pythonPackageDirectory = path.join(rootDirectory, 'packages', 'verser2-guest-python');
const pythonSourceDirectory = path.join(pythonPackageDirectory, 'src');
const pythonExamplePath = path.join(pythonPackageDirectory, 'examples', 'basic_guest.py');

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function waitForProcessOutput(process, pattern, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
    process.stdout.on('data', (chunk) => {
      if (pattern.test(chunk.toString('utf8'))) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on('data', (chunk) => {
      if (/Traceback|Error|Exception/.test(chunk.toString('utf8'))) {
        clearTimeout(timeout);
        reject(new Error(chunk.toString('utf8')));
      }
    });
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`${label} exited before ready: code=${code} signal=${signal}`));
    });
  });
}

test('Python ASGI Guest connects to Host and handles a basic routed Broker request', async () => {
  const host = createVerserHost({ port: 0, tls: { cert: trusted.certificate, key: trusted.key } });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createVerserBroker({
    hostUrl,
    brokerId: 'broker-python-basic',
    tls: { ca: trusted.certificate },
  });
  const guestProcess = spawn(
    'uv',
    ['run', '--project', pythonPackageDirectory, 'python', pythonExamplePath],
    {
      cwd: rootDirectory,
      env: {
        ...process.env,
        PYTHONPATH: pythonSourceDirectory,
        VERSER_HOST_URL: hostUrl,
        VERSER_TLS_CA_FILE: trusted.certificatePath,
        VERSER_GUEST_ID: 'python-guest-basic',
        VERSER_GUEST_DOMAIN: 'python-basic.local.test',
      },
    },
  );

  try {
    await broker.connect();
    await waitForProcessOutput(guestProcess, /python guest ready/, 'Python Guest');
    await broker.waitForRoute('python-basic.local.test');

    const response = await broker.request({
      targetId: 'python-guest-basic',
      method: 'POST',
      path: '/from-broker?x=1',
      headers: { 'x-input': 'abc' },
      body: [Buffer.from('payload')],
    });

    assert.equal(response.statusCode, 214);
    assert.equal(response.headers['x-guest'], 'python');
    assert.equal(
      (await readBody(response.body)).toString('utf8'),
      'POST /from-broker x=1 abc payload',
    );

    const chunkedResponse = await broker.request({
      targetId: 'python-guest-basic',
      method: 'POST',
      path: '/from-broker?x=2',
      headers: { 'x-input': 'chunks' },
      body: [Buffer.from('one'), Buffer.from('two')],
    });

    assert.equal(chunkedResponse.statusCode, 214);
    assert.equal(
      (await readBody(chunkedResponse.body)).toString('utf8'),
      'POST /from-broker x=2 chunks onetwo',
    );
  } finally {
    guestProcess.kill('SIGTERM');
    await broker.close('test-complete');
    await host.close('test-complete');
  }
});

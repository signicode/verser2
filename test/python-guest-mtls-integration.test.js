const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient, untrustedClient } = require('./support/tls-fixtures.cjs');
const { terminateChildProcess } = require('./support/child-process.cjs');

const { createVerserHost } = loadVerserHost();

const rootDirectory = path.resolve(__dirname, '..');
const pythonPackageDirectory = path.join(rootDirectory, 'packages', 'verser2-guest-python');
const pythonSourceDirectory = path.join(pythonPackageDirectory, 'src');
const pythonExamplePath = path.join(pythonPackageDirectory, 'examples', 'basic_guest.py');

function hasUv() {
  const result = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function withTimeout(promise, label, timeoutMs = 30_000) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function waitForProcessOutput(process, pattern, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    let stderr = '';
    process.stdout.on('data', (chunk) => {
      if (pattern.test(chunk.toString('utf8'))) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (/Traceback|Error|Exception/.test(stderr)) {
        clearTimeout(timeout);
        reject(new Error(stderr));
      }
    });
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(`${label} exited before ready: code=${code} signal=${signal} stderr=${stderr}`),
      );
    });
  });
}

async function withMtlsHost(authorizeRegistration) {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert: trusted.certificate,
      key: trusted.key,
      clientAuth: {
        ca: clientCa.certificate,
        ...(authorizeRegistration ? { authorizeRegistration } : {}),
      },
    },
  });
  await host.start();
  return host;
}

function spawnPythonGuest(host, env) {
  return spawn('uv', ['run', '--project', pythonPackageDirectory, 'python', pythonExamplePath], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      PYTHONPATH: pythonSourceDirectory,
      VERSER_HOST_URL: `https://127.0.0.1:${host.address.port}`,
      VERSER_TLS_CA_FILE: trusted.certificatePath,
      VERSER_GUEST_DOMAIN: 'python-mtls.local.test',
      ...env,
    },
  });
}

test(
  'Python Guest connects to mTLS Host with trusted PEM client identity',
  {
    skip: hasUv() ? false : 'Skipping Python Guest mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    let authorizationContext;
    const host = await withMtlsHost((context) => {
      authorizationContext = context;
      return { action: 'allow' };
    });
    const guestProcess = spawnPythonGuest(host, {
      VERSER_GUEST_ID: 'python-guest-mtls-pem',
      VERSER_TLS_CERT_FILE: trustedClient.certificatePath,
      VERSER_TLS_KEY_FILE: trustedClient.keyPath,
    });

    try {
      await waitForProcessOutput(guestProcess, /python guest ready/, 'Python Guest mTLS PEM');
      assert.equal(authorizationContext.peerId, 'python-guest-mtls-pem');
      assert.equal(authorizationContext.role, 'guest');
      assert.equal(authorizationContext.certificate.commonName, 'trusted-client');
    } finally {
      await withTimeout(terminateChildProcess(guestProcess), 'Python Guest termination');
      await host.close('test-complete');
    }
  },
);

test(
  'Python Guest connects to mTLS Host with trusted PFX client identity',
  {
    skip: hasUv() ? false : 'Skipping Python Guest mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    const host = await withMtlsHost();
    const guestProcess = spawnPythonGuest(host, {
      VERSER_GUEST_ID: 'python-guest-mtls-pfx',
      VERSER_TLS_PFX_FILE: trustedClient.pfxPath,
      VERSER_TLS_PFX_PASSWORD: trustedClient.pfxPassphrase,
    });

    try {
      await waitForProcessOutput(guestProcess, /python guest ready/, 'Python Guest mTLS PFX');
    } finally {
      await withTimeout(terminateChildProcess(guestProcess), 'Python Guest termination');
      await host.close('test-complete');
    }
  },
);

test(
  'Python Guest with untrusted client identity is rejected by mTLS Host',
  {
    skip: hasUv() ? false : 'Skipping Python Guest mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    const host = await withMtlsHost();
    const guestProcess = spawnPythonGuest(host, {
      VERSER_GUEST_ID: 'python-guest-mtls-untrusted-cert',
      VERSER_TLS_CERT_FILE: untrustedClient.certificatePath,
      VERSER_TLS_KEY_FILE: untrustedClient.keyPath,
    });

    try {
      await assert.rejects(
        waitForProcessOutput(guestProcess, /python guest ready/, 'Python Guest untrusted mTLS'),
        /tls|handshake|certificate|alert|socket/i,
      );
    } finally {
      await withTimeout(terminateChildProcess(guestProcess), 'Python Guest termination');
      await host.close('test-complete');
    }
  },
);

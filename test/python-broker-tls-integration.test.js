const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient, untrustedClient } = require('./support/tls-fixtures.cjs');

const { createVerserHost } = loadVerserHost();

const rootDirectory = path.resolve(__dirname, '..');
const pythonPackageDirectory = path.join(rootDirectory, 'packages', 'verser2-guest-python');
const pythonSourceDirectory = path.join(pythonPackageDirectory, 'src');

function hasUv() {
  const result = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function runPythonBroker(options) {
  const script = `
import asyncio
import os
from verser2_guest_python import create_verser_broker

async def main():
    opts = {
        "host_url": os.environ["VERSER_HOST_URL"],
        "broker_id": os.environ.get("VERSER_BROKER_ID", "python-broker-mtls"),
        "tls_ca_file": os.environ["VERSER_TLS_CA_FILE"],
    }
    optional = {
        "tls_cert_file": "VERSER_TLS_CERT_FILE",
        "tls_key_file": "VERSER_TLS_KEY_FILE",
        "tls_key_password": "VERSER_TLS_KEY_PASSWORD",
        "tls_pfx_file": "VERSER_TLS_PFX_FILE",
        "tls_pfx_password": "VERSER_TLS_PFX_PASSWORD",
    }
    for option_name, env_name in optional.items():
        if os.environ.get(env_name):
            opts[option_name] = os.environ[env_name]
    broker = create_verser_broker(**opts)
    await broker.connect()
    print("python broker connected", flush=True)
    await broker.close()

asyncio.run(main())
`;

  return new Promise((resolve) => {
    const child = spawn(
      'uv',
      ['run', '--project', pythonPackageDirectory, 'python', '-c', script],
      {
        cwd: rootDirectory,
        env: {
          ...process.env,
          PYTHONPATH: pythonSourceDirectory,
          ...options.env,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeout ?? 20_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
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

test(
  'Python Broker connects to mTLS Host with trusted PEM client identity',
  {
    skip: hasUv() ? false : 'Skipping Python Broker mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    let authorizationContext;
    const host = await withMtlsHost((context) => {
      authorizationContext = context;
      return { action: 'allow' };
    });

    try {
      const result = await runPythonBroker({
        env: {
          VERSER_HOST_URL: `https://127.0.0.1:${host.address.port}`,
          VERSER_TLS_CA_FILE: trusted.certificatePath,
          VERSER_TLS_CERT_FILE: trustedClient.certificatePath,
          VERSER_TLS_KEY_FILE: trustedClient.keyPath,
          VERSER_BROKER_ID: 'python-broker-mtls-pem',
        },
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /python broker connected/);
      assert.equal(authorizationContext.peerId, 'python-broker-mtls-pem');
      assert.equal(authorizationContext.role, 'broker');
      assert.equal(authorizationContext.certificate.commonName, 'trusted-client');
    } finally {
      await host.close('test-complete');
    }
  },
);

test(
  'Python Broker connects to mTLS Host with trusted PFX client identity',
  {
    skip: hasUv() ? false : 'Skipping Python Broker mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    const host = await withMtlsHost();

    try {
      const result = await runPythonBroker({
        env: {
          VERSER_HOST_URL: `https://127.0.0.1:${host.address.port}`,
          VERSER_TLS_CA_FILE: trusted.certificatePath,
          VERSER_TLS_PFX_FILE: trustedClient.pfxPath,
          VERSER_TLS_PFX_PASSWORD: trustedClient.pfxPassphrase,
          VERSER_BROKER_ID: 'python-broker-mtls-pfx',
        },
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /python broker connected/);
    } finally {
      await host.close('test-complete');
    }
  },
);

test(
  'Python Broker without client identity is rejected by mTLS Host',
  {
    skip: hasUv() ? false : 'Skipping Python Broker mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    const host = await withMtlsHost();

    try {
      const result = await runPythonBroker({
        env: {
          VERSER_HOST_URL: `https://127.0.0.1:${host.address.port}`,
          VERSER_TLS_CA_FILE: trusted.certificatePath,
          VERSER_BROKER_ID: 'python-broker-mtls-missing-cert',
        },
      });

      assert.notEqual(result.code, 0, result.stdout);
      assert.match(result.stderr, /tls|handshake|certificate|alert|socket/i);
    } finally {
      await host.close('test-complete');
    }
  },
);

test(
  'Python Broker with untrusted client identity is rejected by mTLS Host',
  {
    skip: hasUv() ? false : 'Skipping Python Broker mTLS integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    const host = await withMtlsHost();

    try {
      const result = await runPythonBroker({
        env: {
          VERSER_HOST_URL: `https://127.0.0.1:${host.address.port}`,
          VERSER_TLS_CA_FILE: trusted.certificatePath,
          VERSER_TLS_CERT_FILE: untrustedClient.certificatePath,
          VERSER_TLS_KEY_FILE: untrustedClient.keyPath,
          VERSER_BROKER_ID: 'python-broker-mtls-untrusted-cert',
        },
      });

      assert.notEqual(result.code, 0, result.stdout);
      assert.match(result.stderr, /tls|handshake|certificate|alert|socket/i);
    } finally {
      await host.close('test-complete');
    }
  },
);

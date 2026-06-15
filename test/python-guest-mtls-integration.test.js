const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted, clientCa, trustedClient, untrustedClient } = require('./support/tls-fixtures.cjs');
const { collectChildProcessResult } = require('./support/child-process.cjs');

const { createVerserHost } = loadVerserHost();

const rootDirectory = path.resolve(__dirname, '..');
const pythonPackageDirectory = path.join(rootDirectory, 'packages', 'verser2-guest-python');
const pythonSourceDirectory = path.join(pythonPackageDirectory, 'src');

function hasUv() {
  const result = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
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

function runPythonGuest(host, env) {
  const script = `
import asyncio
import os
import sys
from verser2_guest_python import create_verser_guest

async def app(scope, receive, send):
    await send({"type": "http.response.start", "status": 204, "headers": []})
    await send({"type": "http.response.body", "body": b""})

async def main():
    connect_timeout = float(os.environ.get("VERSER_CONNECT_TIMEOUT", "10"))
    opts = {
        "host_url": os.environ["VERSER_HOST_URL"],
        "guest_id": os.environ.get("VERSER_GUEST_ID", "python-guest-mtls"),
        "app": app,
        "routed_domains": [os.environ.get("VERSER_GUEST_DOMAIN", "python-mtls.local.test")],
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
    guest = create_verser_guest(**opts)
    try:
        await asyncio.wait_for(guest.connect(), timeout=connect_timeout)
        print("python guest connected", flush=True)
    finally:
        try:
            await guest.close()
        except Exception as exc:
            print(f"python guest close warning: {exc}", file=sys.stderr, flush=True)

try:
    asyncio.run(main())
except Exception as exc:
    print(f"TLS handshake failed for python guest: {exc}", file=sys.stderr, flush=True)
    raise
`;

  const child = spawn('uv', ['run', '--project', pythonPackageDirectory, 'python', '-c', script], {
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
  return collectChildProcessResult(child, {
    timeoutMs: Number(env.VERSER_PROCESS_TIMEOUT_MS || 20_000),
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

    try {
      const result = await runPythonGuest(host, {
        VERSER_GUEST_ID: 'python-guest-mtls-pem',
        VERSER_TLS_CERT_FILE: trustedClient.certificatePath,
        VERSER_TLS_KEY_FILE: trustedClient.keyPath,
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /python guest connected/);
      assert.equal(authorizationContext.peerId, 'python-guest-mtls-pem');
      assert.equal(authorizationContext.role, 'guest');
      assert.equal(authorizationContext.certificate.commonName, 'trusted-client');
    } finally {
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

    try {
      const result = await runPythonGuest(host, {
        VERSER_GUEST_ID: 'python-guest-mtls-pfx',
        VERSER_TLS_PFX_FILE: trustedClient.pfxPath,
        VERSER_TLS_PFX_PASSWORD: trustedClient.pfxPassphrase,
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /python guest connected/);
    } finally {
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

    try {
      const result = await runPythonGuest(host, {
        VERSER_GUEST_ID: 'python-guest-mtls-untrusted-cert',
        VERSER_CONNECT_TIMEOUT: '2',
        VERSER_PROCESS_TIMEOUT_MS: '5000',
        VERSER_TLS_CERT_FILE: untrustedClient.certificatePath,
        VERSER_TLS_KEY_FILE: untrustedClient.keyPath,
      });

      assert.notEqual(result.code, 0, result.stdout);
      assert.match(result.stderr, /tls|handshake|certificate|alert|socket|timed out/i);
    } finally {
      await host.close('test-complete');
    }
  },
);

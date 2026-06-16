const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { text } = require('node:stream/consumers');
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

function runPythonBroker(options) {
  const script = `
import asyncio
import os
from verser2_guest_python import create_verser_broker

async def main():
    connect_timeout = float(os.environ.get("VERSER_CONNECT_TIMEOUT", "10"))
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
    await asyncio.wait_for(broker.connect(), timeout=connect_timeout)
    print("python broker connected", flush=True)
    await broker.close()

asyncio.run(main())
`;

  const child = spawn('uv', ['run', '--project', pythonPackageDirectory, 'python', '-c', script], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      PYTHONPATH: pythonSourceDirectory,
      ...options.env,
    },
  });
  return collectChildProcessResult(child, {
    timeoutMs: Number(options.env?.VERSER_PROCESS_TIMEOUT_MS || options.timeout || 20_000),
  });
}

function assertPythonBrokerTlsRejected(result) {
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /tls|handshake|certificate|alert|socket|Broker connection closed/i);
}

function runPythonBrokerRequest(options) {
  const script = `
import asyncio
import os
from verser2_guest_python import create_verser_broker

async def main():
    broker = create_verser_broker(
        host_url=os.environ["VERSER_HOST_URL"],
        broker_id=os.environ.get("VERSER_BROKER_ID", "python-broker-upstream"),
        tls_ca_file=os.environ["VERSER_TLS_CA_FILE"],
    )
    await asyncio.wait_for(broker.connect(), timeout=10)
    await asyncio.wait_for(broker.wait_for_route(os.environ["VERSER_ROUTE_DOMAIN"]), timeout=10)
    response = await broker.post(
        os.environ["VERSER_REQUEST_URL"],
        text="python-upstream-body",
        headers={"x-python-broker": "yes"},
    )
    print(f"status={response.status}", flush=True)
    print(f"x-upstream-python={response.headers.get('x-upstream-python')}", flush=True)
    print(await response.text(), flush=True)
    await broker.close()

asyncio.run(main())
`;

  const child = spawn('uv', ['run', '--project', pythonPackageDirectory, 'python', '-c', script], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      PYTHONPATH: pythonSourceDirectory,
      ...options.env,
    },
  });
  return collectChildProcessResult(child, {
    timeoutMs: Number(options.env?.VERSER_PROCESS_TIMEOUT_MS || options.timeout || 20_000),
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
          VERSER_CONNECT_TIMEOUT: '2',
          VERSER_PROCESS_TIMEOUT_MS: '5000',
          VERSER_BROKER_ID: 'python-broker-mtls-missing-cert',
        },
      });

      assertPythonBrokerTlsRejected(result);
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
          VERSER_CONNECT_TIMEOUT: '2',
          VERSER_PROCESS_TIMEOUT_MS: '5000',
          VERSER_TLS_CERT_FILE: untrustedClient.certificatePath,
          VERSER_TLS_KEY_FILE: untrustedClient.keyPath,
          VERSER_BROKER_ID: 'python-broker-mtls-untrusted-cert',
        },
      });

      assertPythonBrokerTlsRejected(result);
    } finally {
      await host.close('test-complete');
    }
  },
);

test(
  'Python Broker reaches imported upstream route through downstream Host federation',
  {
    skip: hasUv()
      ? false
      : 'Skipping Python Broker upstream integration because uv is not installed.',
    timeout: 45_000,
  },
  async () => {
    const manager = createVerserHost({
      hostId: 'host-manager',
      tls: { cert: trusted.certificate, key: trusted.key },
    });
    const runner = createVerserHost({
      hostId: 'host-runner',
      tls: { cert: trusted.certificate, key: trusted.key },
    });
    await manager.start();

    try {
      await manager.attachLocalGuest({
        guestId: 'guest-manager-python',
        routedDomains: ['manager-python.verser.test'],
        listener: async (request, response) => {
          const body = await text(request);
          response.writeHead(203, { 'x-upstream-python': request.headers['x-python-broker'] });
          response.end(`${request.method}:${request.url}:${body}`);
        },
      });
      await runner.start();
      await runner.connectUpstream({
        upstreamId: 'manager',
        url: `https://localhost:${manager.address.port}`,
        tls: { ca: trusted.certificate },
      });

      const result = await runPythonBrokerRequest({
        env: {
          VERSER_HOST_URL: `https://127.0.0.1:${runner.address.port}`,
          VERSER_TLS_CA_FILE: trusted.certificatePath,
          VERSER_BROKER_ID: 'python-broker-upstream-route',
          VERSER_ROUTE_DOMAIN: 'manager-python.verser.test',
          VERSER_REQUEST_URL: 'http://manager-python.verser.test/from-python?via=upstream',
        },
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /status=203/);
      assert.match(result.stdout, /x-upstream-python=yes/);
      assert.match(result.stdout, /POST:\/from-python\?via=upstream:python-upstream-body/);
    } finally {
      await runner.close('test-complete');
      await manager.close('test-complete');
    }
  },
);

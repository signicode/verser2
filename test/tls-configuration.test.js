const assert = require('node:assert/strict');
const fs = require('node:fs');
const http2 = require('node:http2');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');
const {
  trusted,
  untrusted,
  mismatched,
  encrypted,
  clientCa,
  trustedClient,
  untrustedClient,
} = require('./support/tls-fixtures.cjs');

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

const cert = trusted.certificate;
const key = trusted.key;
const certFile = trusted.certificatePath;
const keyFile = trusted.keyPath;
const trustedPfx = trusted.pfx;
const trustedPfxPassphrase = trusted.pfxPassphrase;
const untrustedCert = untrusted.certificate;
const untrustedKey = untrusted.key;
const mismatchedCertPath = mismatched.certificatePath;
const mismatchedKeyPath = mismatched.keyPath;
const encryptedCert = encrypted.certificate;
const encryptedKey = encrypted.key;
const encryptedPassphrase = encrypted.passphrase;
const clientCaCert = clientCa.certificate;
const trustedClientCert = trustedClient.certificate;
const trustedClientKey = trustedClient.key;
const trustedClientPfx = trustedClient.pfx;
const trustedClientPfxPassphrase = trustedClient.pfxPassphrase;
const untrustedClientCert = untrustedClient.certificate;
const untrustedClientKey = untrustedClient.key;

async function connectSecureHttp2(url, options) {
  const session = http2.connect(url, options);
  try {
    await once(session, 'connect');
    return session;
  } catch (error) {
    session.destroy();
    throw error;
  }
}

function destroyClientSession(owner) {
  if (owner.session !== undefined) {
    owner.session.destroy();
  }
}

async function createSecureFixtureServer(serverCert = cert, serverKey = key) {
  const server = http2.createSecureServer({ cert: serverCert, key: serverKey });
  const sessions = new Set();

  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });

  server.on('stream', (stream, headers) => {
    const routePath = String(headers[':path'] ?? '');

    if (routePath === '/verser/register') {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ status: 'registered', routes: [] }));
      return;
    }

    if (routePath === '/verser/guest/control') {
      stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
      return;
    }

    if (routePath === '/verser/guest/lease') {
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
      return;
    }

    if (routePath === '/verser/request') {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (routePath === '/verser/ready') {
      stream.respond({ ':status': 200, 'content-type': 'text/plain' });
      stream.end('ready');
      return;
    }

    stream.respond({ ':status': 404 });
    stream.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    port: address.port,
    url: `https://127.0.0.1:${address.port}`,
    server,
    async close() {
      for (const session of sessions) {
        session.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function createUntrustedGuestServer() {
  const host = await createSecureFixtureServer(untrustedCert, untrustedKey);
  return {
    ...host,
    url: `https://127.0.0.1:${host.port}`,
  };
}

async function createUntrustedBrokerServer() {
  const server = http2.createSecureServer({
    cert: untrustedCert,
    key: untrustedKey,
  });
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const routePath = String(headers[':path'] ?? '');
    if (routePath === '/verser/register') {
      registerRoutesFrameStreamResponse(stream);
      return;
    }
    stream.respond({ ':status': 404 });
    stream.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    url: `https://127.0.0.1:${address.port}`,
    async close() {
      await closeSecureServer(server, sessions);
    },
  };
}

async function closeSecureServer(server, sessions) {
  for (const session of sessions) {
    session.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
}

async function safeCloseHost(host) {
  if (host.running) {
    await host.close('test-complete');
  }
}

function registerRoutesFrameStreamResponse(stream, routes = []) {
  stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
  stream.end(`${JSON.stringify({ type: 'routes', routes })}\n`);
}

test('Host supports direct PEM TLS config and accepts TLS clients', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
    },
  });

  try {
    await host.start();
    assert.equal(host.running, true);

    const session = await connectSecureHttp2(`https://127.0.0.1:${host.address.port}`, {
      ca: cert,
    });
    assert.equal(session.closed, false);

    session.close();
    await once(session, 'close');
  } finally {
    await host.close('test-complete');
  }
});

test('Host supports TLS config using file paths', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      certFile,
      keyFile,
    },
  });

  try {
    await host.start();
    assert.equal(host.running, true);

    const session = await connectSecureHttp2(`https://127.0.0.1:${host.address.port}`, {
      ca: cert,
    });

    session.close();
    await once(session, 'close');
  } finally {
    await host.close('test-complete');
  }
});

test('Host supports PFX TLS config', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      pfx: trustedPfx,
      passphrase: trustedPfxPassphrase,
    },
  });

  try {
    await host.start();
    assert.equal(host.running, true);

    const session = await connectSecureHttp2(`https://127.0.0.1:${host.address.port}`, {
      ca: cert,
    });

    session.close();
    await once(session, 'close');
  } finally {
    await safeCloseHost(host);
  }
});

test('Host startup rejects a file key with insecure mode', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verser2-tls-'));
  const tmpKeyFile = path.join(tmpDir, 'insecure-host-key.pem');
  fs.writeFileSync(tmpKeyFile, key, 'utf8');
  fs.chmodSync(tmpKeyFile, 0o644);

  const host = createVerserHost({
    port: 0,
    tls: {
      certFile,
      keyFile: tmpKeyFile,
    },
  });

  try {
    await assert.rejects(() => host.start(), /mode 0644/);
  } finally {
    await safeCloseHost(host);
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test('Host startup accepts a file key with 0600 mode', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verser2-tls-'));
  const tmpKeyFile = path.join(tmpDir, 'secure-host-key.pem');
  const tmpCertFile = path.join(tmpDir, 'secure-host-cert.pem');
  fs.writeFileSync(tmpKeyFile, key, 'utf8');
  fs.chmodSync(tmpKeyFile, 0o600);
  fs.writeFileSync(tmpCertFile, cert, 'utf8');

  const host = createVerserHost({
    port: 0,
    tls: {
      certFile: tmpCertFile,
      keyFile: tmpKeyFile,
    },
  });

  try {
    await host.start();
    assert.equal(host.running, true);
  } finally {
    await host.close('test-complete');
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test('Host supports passphrased PEM key in direct config', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert: encryptedCert,
      key: encryptedKey,
      passphrase: encryptedPassphrase,
    },
  });

  try {
    await host.start();
    assert.equal(host.running, true);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host rejects passphrase protected private key without passphrase', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert: encryptedCert,
      key: encryptedKey,
    },
  });

  try {
    await assert.rejects(() => host.start(), /passphrase|decrypt|PEM routines/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host rejects passphrase protected private key with wrong passphrase', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert: encryptedCert,
      key: encryptedKey,
      passphrase: 'wrong-passphrase',
    },
  });

  try {
    await assert.rejects(() => host.start(), /passphrase|decrypt|PEM routines/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host startup fails with mismatched certificate and key pair', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      certFile: mismatchedCertPath,
      keyFile: mismatchedKeyPath,
    },
  });

  try {
    await assert.rejects(() => host.start(), /cert|key|PEM|error/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host reloadTlsCertificate replaces in-use TLS material', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verser2-tls-'));
  const reloadCertFile = path.join(tmpDir, 'host-cert.pem');
  const reloadKeyFile = path.join(tmpDir, 'host-key.pem');

  fs.writeFileSync(reloadCertFile, untrustedCert, 'utf8');
  fs.writeFileSync(reloadKeyFile, untrustedKey, 'utf8');
  fs.chmodSync(reloadKeyFile, 0o600);

  const host = createVerserHost({
    port: 0,
    tls: {
      certFile: reloadCertFile,
      keyFile: reloadKeyFile,
    },
  });

  let guest;

  try {
    await host.start();
    const url = `https://127.0.0.1:${host.address.port}`;

    guest = createVerserNodeGuest({
      hostUrl: url,
      guestId: 'tls-reload-fail',
      minWaitingStreams: 0,
      tls: { ca: cert },
    });

    await assert.rejects(() => guest.connect(), /certificate|self/i);

    fs.writeFileSync(reloadCertFile, cert, 'utf8');
    fs.writeFileSync(reloadKeyFile, key, 'utf8');
    fs.chmodSync(reloadKeyFile, 0o600);

    host.reloadTlsCertificate();

    await guest.connect();
    assert.equal(guest.connected, true);
  } finally {
    if (guest !== undefined) {
      if (guest.connected) {
        await guest.close('test-complete');
      } else {
        destroyClientSession(guest);
      }
    }

    await safeCloseHost(host);
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test('Host startup fails when tls key is missing for certificate', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
    },
  });

  try {
    await assert.rejects(() => host.start(), /key/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host startup fails when tls config is missing', async () => {
  const host = createVerserHost({
    port: 0,
  });

  try {
    await assert.rejects(() => host.start(), /tls/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host startup fails when key is missing from file-based TLS config', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      certFile,
    },
  });

  try {
    await assert.rejects(() => host.start(), /key/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host startup fails when cert is missing from file-based TLS config', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      keyFile,
    },
  });

  try {
    await assert.rejects(() => host.start(), /cert/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Node Guest supports TLS config with direct CA', async () => {
  const host = await createSecureFixtureServer();
  const guest = createVerserNodeGuest({
    hostUrl: host.url,
    guestId: 'tls-guest-direct',
    minWaitingStreams: 0,
    tls: { ca: cert },
  });

  try {
    await guest.connect();
    assert.equal(guest.connected, true);
  } finally {
    if (guest.connected) {
      await guest.close('test-complete');
    } else {
      destroyClientSession(guest);
    }
    await host.close();
  }
});

test('Node Guest supports TLS config with CA file path', async () => {
  const host = await createSecureFixtureServer();
  const guest = createVerserNodeGuest({
    hostUrl: host.url,
    guestId: 'tls-guest-file',
    minWaitingStreams: 0,
    tls: { caFile: certFile },
  });

  try {
    await guest.connect();
    assert.equal(guest.connected, true);
  } finally {
    if (guest.connected) {
      await guest.close('test-complete');
    } else {
      destroyClientSession(guest);
    }
    await host.close();
  }
});

test('Node Broker supports TLS config with direct CA', async () => {
  const server = http2.createSecureServer({ cert, key });
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const routePath = String(headers[':path'] ?? '');
    if (routePath === '/verser/register') {
      registerRoutesFrameStreamResponse(stream);
      return;
    }
    stream.respond({ ':status': 404 });
    stream.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const broker = createVerserBroker({
    hostUrl: `https://127.0.0.1:${address.port}`,
    brokerId: 'tls-broker-direct',
    tls: {
      ca: cert,
    },
  });
  let connected = false;

  try {
    await broker.connect();
    connected = true;
    assert.deepEqual(broker.getRoutes(), []);
  } finally {
    if (connected) {
      await broker.close('test-complete');
    } else {
      destroyClientSession(broker);
    }
    await closeSecureServer(server, sessions);
  }
});

test('Node Broker supports TLS config with CA file path', async () => {
  const server = http2.createSecureServer({ cert, key });
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const routePath = String(headers[':path'] ?? '');
    if (routePath === '/verser/register') {
      registerRoutesFrameStreamResponse(stream);
      return;
    }
    stream.respond({ ':status': 404 });
    stream.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const broker = createVerserBroker({
    hostUrl: `https://127.0.0.1:${address.port}`,
    brokerId: 'tls-broker-file',
    tls: {
      caFile: certFile,
    },
  });
  let connected = false;

  try {
    await broker.connect();
    connected = true;
    assert.deepEqual(broker.getRoutes(), []);
  } finally {
    if (connected) {
      await broker.close('test-complete');
    } else {
      destroyClientSession(broker);
    }
    await closeSecureServer(server, sessions);
  }
});

test('Node Guest dispatches through plain HTTP/1 attachment without HTTPS setup', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(202, { 'x-server': 'attached' });
    response.end(request.url);
  });

  const guest = createVerserNodeGuest({
    hostUrl: 'https://localhost:1',
    guestId: 'tls-guest-http1',
  });
  guest.attach(server);

  const result = await guest.dispatchRoutedRequest({
    requestId: 'tls-guest-http1-dispatch',
    sourceId: 'broker-1',
    targetId: 'tls-guest-http1',
    method: 'GET',
    path: '/http1',
    headers: {},
    body: [],
  });

  assert.equal(server.listening, false);
  assert.equal(result.statusCode, 202);
  assert.equal(result.headers['x-server'], 'attached');
  assert.deepEqual(result.body, Buffer.from('/http1'));
});

test('Node Guest rejects untrusted certificate when no CA is provided', async () => {
  const host = await createUntrustedGuestServer();
  const guest = createVerserNodeGuest({
    hostUrl: host.url,
    guestId: 'tls-guest-untrusted-no-ca',
    minWaitingStreams: 0,
  });

  try {
    await assert.rejects(() => guest.connect(), /certificate|self/i);
  } finally {
    if (guest.connected) {
      await guest.close('test-complete');
    } else {
      destroyClientSession(guest);
    }
    await host.close();
  }
});

test('Node Broker rejects untrusted certificate when no CA is provided', async () => {
  const host = await createUntrustedBrokerServer();
  const broker = createVerserBroker({
    hostUrl: host.url,
    brokerId: 'tls-broker-untrusted-no-ca',
  });

  try {
    await assert.rejects(() => broker.connect(), /certificate|self/i);
    assert.equal(broker.sessionCount, 0);
  } finally {
    if (broker.connected) {
      await broker.close('test-complete');
    } else {
      destroyClientSession(broker);
    }
    await host.close();
  }
});

test('Host configured with client CA rejects Guest without client certificate', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-missing-cert',
      minWaitingStreams: 0,
      tls: { ca: cert },
    });

    await assert.rejects(() => guest.connect(), /certificate|alert|tls|socket/i);
  } finally {
    if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Host configured with client CA rejects Broker without client certificate', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  let broker;

  try {
    await host.start();
    broker = createVerserBroker({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      brokerId: 'mtls-broker-missing-cert',
      tls: { ca: cert },
    });

    await assert.rejects(() => broker.connect(), /certificate|alert|tls|socket/i);
  } finally {
    if (broker !== undefined) {
      destroyClientSession(broker);
    }
    await safeCloseHost(host);
  }
});

test('Host configured with client CA rejects untrusted Guest client certificate', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-untrusted-cert',
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        cert: untrustedClientCert,
        key: untrustedClientKey,
      },
    });

    await assert.rejects(() => guest.connect(), /certificate|alert|tls|socket/i);
  } finally {
    if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Guest connects and registers with trusted client certificate', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  const guestId = 'mtls-guest-trusted-cert';
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId,
      routedDomains: ['mtls-guest.verser.test'],
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await guest.connect();
    assert.equal(guest.connected, true);
    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: guestId, domain: 'mtls-guest.verser.test' },
    ]);
  } finally {
    if (guest?.connected) {
      await guest.close('test-complete');
    } else if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Broker connects and registers with trusted client certificate', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  let broker;

  try {
    await host.start();
    broker = createVerserBroker({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      brokerId: 'mtls-broker-trusted-cert',
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await broker.connect();
    assert.deepEqual(broker.getRoutes(), []);
    assert.equal(broker.sessionCount, 1);
  } finally {
    if (broker?.connected) {
      await broker.close('test-complete');
    } else if (broker !== undefined) {
      destroyClientSession(broker);
    }
    await safeCloseHost(host);
  }
});

test('Guest and Broker can register with trusted PFX client identities', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  let guest;
  let broker;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-trusted-pfx',
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        pfx: trustedClientPfx,
        passphrase: trustedClientPfxPassphrase,
      },
    });
    broker = createVerserBroker({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      brokerId: 'mtls-broker-trusted-pfx',
      tls: {
        ca: cert,
        pfx: trustedClientPfx,
        passphrase: trustedClientPfxPassphrase,
      },
    });

    await guest.connect();
    await broker.connect();
    assert.equal(guest.connected, true);
    assert.equal(broker.sessionCount, 1);
  } finally {
    if (broker !== undefined) {
      await broker.close('test-complete');
    }
    if (guest?.connected) {
      await guest.close('test-complete');
    } else if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Host without clientAuth preserves Guest compatibility when client cert is configured', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
    },
  });
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-compat-cert-ignored',
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await guest.connect();
    assert.equal(guest.connected, true);
  } finally {
    if (guest?.connected) {
      await guest.close('test-complete');
    } else if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Host clientAuth authorizeRegistration receives Guest routed domains and certificate identity', async () => {
  const contexts = [];
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        authorizeRegistration(context) {
          contexts.push(context);
          return { action: 'allow' };
        },
      },
    },
  });
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-authorized-context',
      routedDomains: ['authorized.verser.test'],
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await guest.connect();

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].peerId, 'mtls-guest-authorized-context');
    assert.equal(contexts[0].role, 'guest');
    assert.deepEqual(contexts[0].routedDomains, ['authorized.verser.test']);
    assert.equal(contexts[0].certificate.commonName, 'trusted-client');
    assert.deepEqual(contexts[0].certificate.dnsNames, ['trusted-client']);
    assert.deepEqual(contexts[0].certificate.uriNames, ['urn:verser:client:trusted-client']);
    assert.match(contexts[0].certificate.fingerprint256, /^sha256:[a-f0-9]{64}$/);
  } finally {
    if (guest?.connected) {
      await guest.close('test-complete');
    } else if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Host clientAuth authorizeRegistration receives Broker identity-only context', async () => {
  const contexts = [];
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        authorizeRegistration(context) {
          contexts.push(context);
          return { action: 'allow' };
        },
      },
    },
  });
  let broker;

  try {
    await host.start();
    broker = createVerserBroker({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      brokerId: 'mtls-broker-authorized-context',
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await broker.connect();

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].peerId, 'mtls-broker-authorized-context');
    assert.equal(contexts[0].role, 'broker');
    assert.deepEqual(contexts[0].routedDomains, []);
    assert.equal(contexts[0].certificate.commonName, 'trusted-client');
  } finally {
    if (broker !== undefined) {
      await broker.close('test-complete');
    }
    await safeCloseHost(host);
  }
});

test('Host clientAuth authorizeRegistration close action rejects registration', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        authorizeRegistration() {
          return { action: 'close', reason: 'not allowed in test' };
        },
      },
    },
  });
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-rejected-context',
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await assert.rejects(() => guest.connect(), /registration|closed|invalid|JSON/i);
    assert.equal(host.getRoutedDomains().length, 0);
  } finally {
    if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

test('Host clientAuth default allows valid client certificate registration without callback', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: { ca: clientCaCert },
    },
  });
  let guest;

  try {
    await host.start();
    guest = createVerserNodeGuest({
      hostUrl: `https://127.0.0.1:${host.address.port}`,
      guestId: 'mtls-guest-default-authorized',
      routedDomains: ['default-authorized.verser.test'],
      minWaitingStreams: 0,
      tls: {
        ca: cert,
        cert: trustedClientCert,
        key: trustedClientKey,
      },
    });

    await guest.connect();
    assert.deepEqual(host.getRoutedDomains(), [
      { targetId: 'mtls-guest-default-authorized', domain: 'default-authorized.verser.test' },
    ]);
  } finally {
    if (guest?.connected) {
      await guest.close('test-complete');
    } else if (guest !== undefined) {
      destroyClientSession(guest);
    }
    await safeCloseHost(host);
  }
});

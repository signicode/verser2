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

function withTimeout(promise, label, timeoutMs = 1000) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function waitForSessionClose(session) {
  if (session.closed || session.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => session.once('close', resolve));
}

function destroyHttp2Session(session) {
  if (session !== undefined && !session.closed && !session.destroyed) {
    session.destroy();
  }
}

async function connectUnauthorizedClient(port, identity = {}) {
  const session = await connectSecureHttp2(`https://127.0.0.1:${port}`, {
    ca: cert,
    ...identity,
  });
  // Expected gate refusals can surface as session errors after the close event.
  session.on('error', () => {});
  return session;
}

function readHttp2Response(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let responseHeaders;

    stream.once('response', (headers) => {
      responseHeaders = headers;
    });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('end', () => {
      resolve({ headers: responseHeaders, body: Buffer.concat(chunks) });
    });
    stream.once('error', reject);
    stream.once('aborted', () => reject(new Error('HTTP/2 stream was aborted')));
  });
}

function sendHttp2Request(session, headers, body = Buffer.alloc(0)) {
  const stream = session.request(headers);
  const response = readHttp2Response(stream);
  stream.end(body);
  return response;
}

async function expectSilentSessionRefusal(session, headers, body, label) {
  const closed = waitForSessionClose(session);
  const stream = session.request(headers);
  let responseHeaders;
  stream.once('response', (receivedHeaders) => {
    responseHeaders = receivedHeaders;
    stream.resume();
  });
  stream.on('error', () => {});
  stream.end(body);

  await withTimeout(closed, `${label} session close`);
  assert.equal(responseHeaders, undefined, `${label} must not receive an HTTP response`);
}

async function expectRefusedStream(session, headers, body, label) {
  let stream;
  try {
    stream = session.request(headers);
  } catch {
    return;
  }

  const outcome = await withTimeout(
    new Promise((resolve) => {
      stream.once('response', (responseHeaders) => {
        stream.resume();
        resolve({ responseHeaders });
      });
      stream.once('close', () => resolve({}));
      stream.once('aborted', () => resolve({}));
      stream.once('error', () => resolve({}));
      stream.end(body);
    }),
    `${label} stream refusal`,
  );

  assert.equal(outcome.responseHeaders, undefined, `${label} must not receive an HTTP response`);
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
    assert.equal(request.url, '/http1');
    response.writeHead(202, { 'x-server': 'attached' });
    response.end('/http1');
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

test('Host rejects unauthorized-client handler configuration without client trust material', async () => {
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        unauthorizedClientHandler: async () => undefined,
      },
    },
  });

  try {
    await assert.rejects(() => host.start(), /unauthorized.*client.*handler.*(ca|trust)/i);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host gives missing and untrusted client certificates one bounded handler response', async () => {
  const contexts = [];
  const requestBody = Buffer.from([0, 1, 255, 10]);
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        unauthorizedClientHandler(context) {
          contexts.push({
            method: context.method,
            path: context.path,
            headers: context.headers,
            body: Buffer.from(context.body),
          });
          return {
            statusCode: 201,
            headers: { 'x-unauthorized-handler': 'handled' },
            body: Buffer.from(context.body),
          };
        },
      },
    },
  });

  try {
    await host.start();

    for (const [label, identity] of [
      ['missing certificate', {}],
      ['untrusted certificate', { cert: untrustedClientCert, key: untrustedClientKey }],
    ]) {
      const session = await connectUnauthorizedClient(host.address.port, identity);
      try {
        const closed = waitForSessionClose(session);
        const response = await sendHttp2Request(
          session,
          {
            ':method': 'POST',
            ':path': '/client-enrollment',
            'content-type': 'application/octet-stream',
            'x-client-fixture': label,
          },
          requestBody,
        );

        assert.equal(response.headers[':status'], 201);
        assert.equal(response.headers['x-unauthorized-handler'], 'handled');
        assert.deepEqual(response.body, requestBody);
        await withTimeout(closed, `${label} session close`);
      } finally {
        destroyHttp2Session(session);
      }
    }

    assert.equal(contexts.length, 2);
    for (const [index, context] of contexts.entries()) {
      assert.equal(context.method, 'POST');
      assert.equal(context.path, '/client-enrollment');
      assert.equal(
        context.headers['x-client-fixture'],
        ['missing certificate', 'untrusted certificate'][index],
      );
      assert.equal(context.headers[':path'], undefined);
      assert.deepEqual(context.body, requestBody);
    }
  } finally {
    await safeCloseHost(host);
  }
});

test('Host closes an unauthorized session when its handler returns no response', async () => {
  let calls = 0;
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        unauthorizedClientHandler() {
          calls += 1;
          return undefined;
        },
      },
    },
  });
  let session;

  try {
    await host.start();
    session = await connectUnauthorizedClient(host.address.port);
    await expectSilentSessionRefusal(
      session,
      { ':method': 'POST', ':path': '/client-enrollment' },
      'no-response',
      'no-response unauthorized handler',
    );
    assert.equal(calls, 1);
  } finally {
    destroyHttp2Session(session);
    await safeCloseHost(host);
  }
});

test('Host treats malformed unauthorized handler headers as generic failure and closes session', async () => {
  const malformedHeaders = [
    { label: 'null', value: null },
    { label: 'string', value: 'not-an-object' },
    { label: 'buffer', value: Buffer.from('not-an-object') },
    { label: 'array', value: ['x-foo', 'y-bar'] },
  ];

  let calls = 0;
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        unauthorizedClientHandler() {
          const { value } = malformedHeaders[calls];
          calls += 1;
          return {
            statusCode: 200,
            headers: value,
            body: 'unexpected',
          };
        },
      },
    },
  });

  try {
    await host.start();

    for (const { label, value } of malformedHeaders) {
      const session = await connectUnauthorizedClient(host.address.port);
      try {
        const closed = waitForSessionClose(session);
        const response = await sendHttp2Request(
          session,
          { ':method': 'POST', ':path': '/client-enrollment' },
          value === null ? '' : Buffer.from(String(value)),
        );

        assert.equal(response.headers[':status'], 500, `${label}: expected generic failure status`);
        assert.equal(response.body.length, 0);
        await withTimeout(closed, `${label}: session close`);
      } finally {
        destroyHttp2Session(session);
      }
    }

    assert.equal(calls, malformedHeaders.length);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host silently closes unauthorized reserved first streams without normal callbacks or lifecycle', async () => {
  const lifecycle = [];
  const registrations = [];
  const federations = [];
  const handlerCalls = [];
  const host = createVerserHost({
    hostId: 'unauthorized-reserved-host',
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        authorizeRegistration(context) {
          registrations.push(context);
          return { action: 'allow' };
        },
        authorizeFederation(context) {
          federations.push(context);
          return { action: 'allow' };
        },
        unauthorizedClientHandler(context) {
          handlerCalls.push(context);
          return { statusCode: 200, body: 'must not run' };
        },
      },
    },
  });
  host.onLifecycle((event) => lifecycle.push(event));

  try {
    await host.start();

    const reservedRequests = [
      {
        headers: { ':method': 'POST', ':path': '/verser/register' },
        body: JSON.stringify({ peerId: 'unauthorized-guest', role: 'guest' }),
        label: 'registration',
      },
      {
        headers: { ':method': 'POST', ':path': '/verser/host/federation' },
        body: JSON.stringify({
          hostId: 'unauthorized-federation',
          protocolVersion: 1,
          importRoutes: true,
          exportRoutes: true,
        }),
        label: 'federation',
      },
    ];

    for (const request of reservedRequests) {
      const session = await connectUnauthorizedClient(host.address.port);
      try {
        await expectSilentSessionRefusal(session, request.headers, request.body, request.label);
      } finally {
        destroyHttp2Session(session);
      }
    }

    assert.deepEqual(handlerCalls, []);
    assert.deepEqual(registrations, []);
    assert.deepEqual(federations, []);
    assert.deepEqual(lifecycle, []);
    assert.deepEqual(host.getRoutedDomains(), []);
  } finally {
    await safeCloseHost(host);
  }
});

test('Host invokes an unauthorized handler once and refuses concurrent and later streams', async () => {
  let calls = 0;
  let releaseHandler;
  let handlerStarted;
  const handlerStartedPromise = new Promise((resolve) => {
    handlerStarted = resolve;
  });
  const handlerResultPromise = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const host = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        unauthorizedClientHandler() {
          calls += 1;
          handlerStarted();
          return handlerResultPromise.then(() => ({ statusCode: 202, body: 'accepted' }));
        },
      },
    },
  });
  let session;

  try {
    await host.start();
    session = await connectUnauthorizedClient(host.address.port);
    const closed = waitForSessionClose(session);
    const first = session.request({ ':method': 'POST', ':path': '/client-enrollment' });
    const firstResponse = readHttp2Response(first);
    first.end('first');

    await withTimeout(handlerStartedPromise, 'unauthorized handler invocation');
    await expectRefusedStream(
      session,
      { ':method': 'POST', ':path': '/client-enrollment/concurrent' },
      'concurrent',
      'concurrent unauthorized request',
    );
    assert.equal(calls, 1);

    releaseHandler();
    const response = await firstResponse;
    assert.equal(response.headers[':status'], 202);
    assert.equal(response.body.toString('utf8'), 'accepted');
    await withTimeout(closed, 'handled unauthorized session close');

    await expectRefusedStream(
      session,
      { ':method': 'POST', ':path': '/client-enrollment/later' },
      'later',
      'later unauthorized request',
    );
    assert.equal(calls, 1);
  } finally {
    if (releaseHandler !== undefined) {
      releaseHandler();
    }
    destroyHttp2Session(session);
    await safeCloseHost(host);
  }
});

test('Host bounds unauthorized request and response bodies before callback output', async () => {
  const requestHandlerCalls = [];
  const requestHost = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        unauthorizedClientMaxRequestBodyBytes: 3,
        unauthorizedClientHandler(context) {
          requestHandlerCalls.push(context);
          return { statusCode: 200, body: 'unexpected' };
        },
      },
    },
  });
  let requestSession;
  let responseSession;

  try {
    await requestHost.start();
    requestSession = await connectUnauthorizedClient(requestHost.address.port);
    const requestClosed = waitForSessionClose(requestSession);
    const requestResponse = await sendHttp2Request(
      requestSession,
      { ':method': 'POST', ':path': '/client-enrollment' },
      Buffer.from('four'),
    );
    assert.ok(Number(requestResponse.headers[':status']) >= 400);
    assert.deepEqual(requestHandlerCalls, []);
    await withTimeout(requestClosed, 'oversized unauthorized request close');
    await safeCloseHost(requestHost);

    const responseHandlerCalls = [];
    const responseHost = createVerserHost({
      port: 0,
      tls: {
        cert,
        key,
        clientAuth: {
          ca: clientCaCert,
          unauthorizedClientMaxResponseBodyBytes: 3,
          unauthorizedClientHandler(context) {
            responseHandlerCalls.push(context);
            return { statusCode: 200, body: 'four' };
          },
        },
      },
    });
    try {
      await responseHost.start();
      responseSession = await connectUnauthorizedClient(responseHost.address.port);
      const responseClosed = waitForSessionClose(responseSession);
      const response = await sendHttp2Request(responseSession, {
        ':method': 'POST',
        ':path': '/client-enrollment',
      });
      assert.ok(Number(response.headers[':status']) >= 400);
      assert.equal(responseHandlerCalls.length, 1);
      await withTimeout(responseClosed, 'oversized unauthorized response close');
    } finally {
      destroyHttp2Session(responseSession);
      await safeCloseHost(responseHost);
    }
  } finally {
    destroyHttp2Session(requestSession);
    await safeCloseHost(requestHost);
  }
});

test('Host times out incomplete unauthorized requests and stalled handlers', async () => {
  const incompleteHandlerCalls = [];
  const incompleteHost = createVerserHost({
    port: 0,
    tls: {
      cert,
      key,
      clientAuth: {
        ca: clientCaCert,
        unauthorizedClientRequestTimeoutMs: 25,
        unauthorizedClientHandler(context) {
          incompleteHandlerCalls.push(context);
          return { statusCode: 200, body: 'unexpected' };
        },
      },
    },
  });
  let incompleteSession;
  let stalledSession;

  try {
    await incompleteHost.start();
    incompleteSession = await connectUnauthorizedClient(incompleteHost.address.port);
    const incompleteClosed = waitForSessionClose(incompleteSession);
    const incompleteStream = incompleteSession.request({
      ':method': 'POST',
      ':path': '/client-enrollment',
    });
    incompleteStream.on('error', () => {});
    incompleteStream.write('partial');
    await withTimeout(incompleteClosed, 'incomplete unauthorized request close', 500);
    assert.deepEqual(incompleteHandlerCalls, []);
    await safeCloseHost(incompleteHost);

    let handlerSignal;
    let handlerStarted;
    const handlerStartedPromise = new Promise((resolve) => {
      handlerStarted = resolve;
    });
    const stalledHost = createVerserHost({
      port: 0,
      tls: {
        cert,
        key,
        clientAuth: {
          ca: clientCaCert,
          unauthorizedClientHandlerTimeoutMs: 25,
          unauthorizedClientHandler(context) {
            handlerSignal = context.signal;
            handlerStarted();
            return new Promise(() => {});
          },
        },
      },
    });
    try {
      await stalledHost.start();
      stalledSession = await connectUnauthorizedClient(stalledHost.address.port);
      const stalledClosed = waitForSessionClose(stalledSession);
      const stalledStream = stalledSession.request({
        ':method': 'POST',
        ':path': '/client-enrollment',
      });
      stalledStream.on('error', () => {});
      stalledStream.end();
      await withTimeout(handlerStartedPromise, 'stalled unauthorized handler invocation');
      await withTimeout(stalledClosed, 'stalled unauthorized handler close', 500);
      assert.equal(handlerSignal.aborted, true);
    } finally {
      destroyHttp2Session(stalledSession);
      await safeCloseHost(stalledHost);
    }
  } finally {
    destroyHttp2Session(incompleteSession);
    await safeCloseHost(incompleteHost);
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

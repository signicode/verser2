const assert = require('node:assert/strict');
const fs = require('node:fs');
const http2 = require('node:http2');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const { createVerserBroker, createVerserNodeGuest } = require('../packages/verser2-guest-node/dist/index.js');

function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, resolve);
    emitter.once('error', reject);
  });
}

const fixturesDirectory = path.join(__dirname, 'fixtures', 'tls');
const cert = fs.readFileSync(path.join(fixturesDirectory, 'localhost-cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(fixturesDirectory, 'localhost-key.pem'), 'utf8');
const legacyDevelopmentCert = fs.readFileSync(
  path.join(fixturesDirectory, 'legacy-development-cert.pem'),
  'utf8',
);
const legacyDevelopmentKey = fs.readFileSync(
  path.join(fixturesDirectory, 'legacy-development-key.pem'),
  'utf8',
);

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

async function createLegacyDevelopmentGuestServer() {
  const host = await createSecureFixtureServer(legacyDevelopmentCert, legacyDevelopmentKey);
  return {
    ...host,
    url: `https://localhost:${host.port}`,
  };
}

async function createLegacyDevelopmentBrokerServer() {
  const server = http2.createSecureServer({
    cert: legacyDevelopmentCert,
    key: legacyDevelopmentKey,
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
    url: `https://localhost:${address.port}`,
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
  const certFile = path.join(fixturesDirectory, 'localhost-cert.pem');
  const keyFile = path.join(fixturesDirectory, 'localhost-key.pem');
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
      certFile: path.join(fixturesDirectory, 'localhost-cert.pem'),
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
      keyFile: path.join(fixturesDirectory, 'localhost-key.pem'),
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
    tls: { caFile: path.join(fixturesDirectory, 'localhost-cert.pem') },
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
      caFile: path.join(fixturesDirectory, 'localhost-cert.pem'),
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
    hostUrl: 'https://127.0.0.1:1',
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

test('Node Guest rejects legacy development certificate when no CA is provided', async () => {
  const host = await createLegacyDevelopmentGuestServer();
  const guest = createVerserNodeGuest({
    hostUrl: host.url,
    guestId: 'tls-guest-legacy-no-ca',
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

test('Node Broker rejects legacy development certificate when no CA is provided', async () => {
  const host = await createLegacyDevelopmentBrokerServer();
  const broker = createVerserBroker({
    hostUrl: host.url,
    brokerId: 'tls-broker-legacy-no-ca',
  });

  try {
    await assert.rejects(() => broker.connect(), /certificate|self/i);
  } finally {
    if (broker.connected) {
      await broker.close('test-complete');
    } else {
      destroyClientSession(broker);
    }
    await host.close();
  }
});

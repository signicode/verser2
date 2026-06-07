const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function requestWithAgent(url, options) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function withTimeout(promise, label, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs),
    ),
  ]);
}

test('Host, Node Guest, Broker, route advertisements, and Agent routing work end-to-end', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-e2e' });
  const guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-e2e' });
  const localServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`Handled ${request.method} ${request.url}`);
  });
  let agent;

  try {
    guest.attach(localServer, 'e2e.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('e2e.local.test');

    const brokerResponse = await broker.request({
      targetId: 'guest-e2e',
      method: 'GET',
      path: '/broker',
    });
    assert.equal(brokerResponse.statusCode, 200);
    assert.deepEqual(await readBody(brokerResponse.body), Buffer.from('Handled GET /broker'));

    agent = broker.createAgent();
    const agentResponse = await requestWithAgent('http://e2e.local.test/agent', { agent });
    assert.equal(agentResponse.statusCode, 200);
    assert.equal(agentResponse.headers['content-type'], 'text/plain');
    assert.deepEqual(agentResponse.body, Buffer.from('Handled GET /agent'));
    assert.equal(localServer.listening, false);
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('leased routing preserves binary Broker bodies and Agent compatibility end-to-end', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-e2e-binary' });
  const guest = createVerserNodeGuest({
    hostUrl,
    guestId: 'guest-e2e-binary',
    minWaitingStreams: 2,
    maxOpenStreams: 4,
  });
  const localServer = http.createServer((request, response) => {
    if (request.url === '/agent') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('agent-ok');
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.concat([Buffer.from([0, 255]), ...chunks, Buffer.from([128, 0])]));
    });
  });
  let agent;

  try {
    guest.attach(localServer, 'binary-e2e.local.test');
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('binary-e2e.local.test');

    const payload = Buffer.from([0, 1, 255, 2, 128, 3]);
    const brokerResponse = await broker.request({
      targetId: 'guest-e2e-binary',
      method: 'POST',
      path: '/binary',
      headers: { 'content-type': 'application/octet-stream' },
      body: [payload],
    });

    assert.equal(brokerResponse.statusCode, 201);
    assert.equal(brokerResponse.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(
      await readBody(brokerResponse.body),
      Buffer.concat([Buffer.from([0, 255]), payload, Buffer.from([128, 0])]),
    );

    agent = broker.createAgent();
    const agentResponse = await requestWithAgent('http://binary-e2e.local.test/agent', { agent });
    assert.equal(agentResponse.statusCode, 200);
    assert.deepEqual(agentResponse.body, Buffer.from('agent-ok'));
    assert.equal(localServer.listening, false);
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('leased routing supports out-of-order concurrent end-to-end responses', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-e2e-concurrent' });
  const guest = createVerserNodeGuest({
    hostUrl,
    guestId: 'guest-e2e-concurrent',
    minWaitingStreams: 3,
    maxOpenStreams: 3,
  });
  guest.attach((request, response) => {
    const body = `handled ${request.url}`;
    setTimeout(
      () => {
        response.writeHead(200, { 'x-e2e-path': request.url ?? '' });
        response.end(body);
      },
      request.url === '/slow' ? 60 : 5,
    );
  }, 'concurrent-e2e.local.test');

  try {
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('concurrent-e2e.local.test');

    const completions = [];
    const slow = broker
      .request({ targetId: 'guest-e2e-concurrent', method: 'GET', path: '/slow' })
      .then(async (response) => {
        completions.push('/slow');
        return readBody(response.body);
      });
    const fast = broker
      .request({ targetId: 'guest-e2e-concurrent', method: 'GET', path: '/fast' })
      .then(async (response) => {
        completions.push('/fast');
        return readBody(response.body);
      });

    assert.deepEqual(await Promise.all([slow, fast]), [
      Buffer.from('handled /slow'),
      Buffer.from('handled /fast'),
    ]);
    assert.deepEqual(completions, ['/fast', '/slow']);
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

test('leased routing fails active end-to-end requests when the Guest disconnects', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-e2e-disconnect' });
  const guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-e2e-disconnect' });
  let dispatchStartedResolve;
  const dispatchStarted = new Promise((resolve) => {
    dispatchStartedResolve = resolve;
  });
  guest.attach((request) => {
    request.resume();
    dispatchStartedResolve();
  }, 'disconnect-e2e.local.test');

  try {
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('disconnect-e2e.local.test');

    const body = new PassThrough();
    const requestPromise = broker.request({
      targetId: 'guest-e2e-disconnect',
      method: 'POST',
      path: '/disconnect',
      body,
    });
    const failure = assert.rejects(requestPromise, (error) => {
      assert.match(error.message, /closed|disconnect|metadata/i);
      return true;
    });
    body.write(Buffer.from('start'));

    await withTimeout(dispatchStarted, 'e2e disconnect dispatch');
    await guest.close('e2e-disconnect-test');
    body.end();

    await failure;
  } finally {
    await broker.close('test-complete');
    await guest.close('test-complete');
    await host.close('test-complete');
  }
});

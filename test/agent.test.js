const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');

function requestWithAgent(url, options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      const chunks = [];
      clearTimeout(timeout);
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.on('error', reject);
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error(`test request timeout for ${url}`));
    }, 5000);
    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    if (body !== undefined) {
      request.end(body);
      return;
    }
    request.end();
  });
}

function withTimeout(promise, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5000);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

test('Broker exposes an Agent that routes matching hostnames through Verser2', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-agent-1' });
  const guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-agent-1' });
  let agent;
  guest.attach((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      response.writeHead(207, { 'x-agent': 'verser' });
      response.end(`${request.method} ${request.url} ${Buffer.concat(chunks).toString('utf8')}`);
    });
  }, 'agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-1 connect');
    await withTimeout(broker.waitForRoute('agent.local.test'), 'agent.local.test route');

    agent = broker.createAgent();
    assert.equal(agent.protocol, 'http:');

    const response = await requestWithAgent(
      'http://agent.local.test/agent-path',
      { agent, method: 'POST', headers: { 'x-input': 'agent' } },
      'payload',
    );

    assert.equal(response.statusCode, 207);
    assert.equal(response.headers['x-agent'], 'verser');
    assert.deepEqual(response.body, Buffer.from('POST /agent-path payload'));
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-1 close');
  }
});

test('Broker Agent routes advertised domains without DNS resolution and rejects non-matching hosts', async () => {
  const host = createVerserHost({ port: 0 });
  await host.start();
  const hostUrl = `https://localhost:${host.address.port}`;
  const broker = createVerserBroker({ hostUrl, brokerId: 'broker-agent-2' });
  const guest = createVerserNodeGuest({ hostUrl, guestId: 'guest-agent-2' });
  let agent;
  guest.attach((_request, response) => response.end('routed'), 'no-dns.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-2 connect');
    await withTimeout(guest.connect(), 'guest-agent-2 connect');
    await withTimeout(broker.waitForRoute('no-dns.local.test'), 'no-dns.local.test route');

    agent = broker.createAgent();
    const routed = await withTimeout(
      requestWithAgent('http://no-dns.local.test/no-dns', { agent }),
      'no-dns Agent request',
    );
    assert.deepEqual(routed.body, Buffer.from('routed'));

    await assert.rejects(
      () => requestWithAgent('http://not-advertised.local.test/', { agent }),
      /No Verser route advertised/,
    );
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-2 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-2 close');
    await withTimeout(host.close('test-complete'), 'host-agent-2 close');
  }
});

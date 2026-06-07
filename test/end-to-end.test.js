const assert = require('node:assert/strict');
const http = require('node:http');
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

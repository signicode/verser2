const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createVerserHost } = require('../packages/verser2-host/dist/index.js');
const {
  createVerserBroker,
  createVerserNodeGuest,
} = require('../packages/verser2-guest-node/dist/index.js');
const { trusted } = require('./support/tls-fixtures.cjs');

function createHost(options = {}) {
  return createVerserHost({
    ...options,
    tls: {
      cert: trusted.certificate,
      key: trusted.key,
      ...options.tls,
    },
  });
}

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
    if (Array.isArray(body)) {
      for (const chunk of body) {
        request.write(chunk);
      }
      request.end();
      return;
    }
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

function createBroker(options) {
  return createVerserBroker({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

function createGuest(options) {
  return createVerserNodeGuest({
    ...options,
    tls: {
      ca: trusted.certificate,
      ...options.tls,
    },
  });
}

test('Broker exposes an Agent that routes matching hostnames through Verser2', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-1' });
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
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-2' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-2' });
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

test('Broker Agent forwards chunked request bodies through leased routing', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-chunked-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-chunked-1' });
  let agent;
  guest.attach((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => response.end(Buffer.concat(chunks)));
  }, 'chunked-agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-chunked-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-chunked-1 connect');
    await withTimeout(
      broker.waitForRoute('chunked-agent.local.test'),
      'chunked-agent.local.test route',
    );

    agent = broker.createAgent();
    const response = await requestWithAgent(
      'http://chunked-agent.local.test/chunked',
      { agent, method: 'POST' },
      [Buffer.from('one'), Buffer.from('two')],
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, Buffer.from('onetwo'));
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-chunked-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-chunked-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-chunked-1 close');
  }
});

test('Broker Agent streams request body before the client request ends', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-streaming-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-streaming-1' });
  let agent;
  guest.attach((request, response) => {
    request.once('data', (chunk) => {
      response.end(Buffer.from(chunk));
    });
  }, 'streaming-agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-streaming-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-streaming-1 connect');
    await withTimeout(
      broker.waitForRoute('streaming-agent.local.test'),
      'streaming-agent.local.test route',
    );

    agent = broker.createAgent();
    let request;
    const responsePromise = new Promise((resolve, reject) => {
      request = http.request(
        'http://streaming-agent.local.test/streaming',
        { agent, method: 'POST' },
        (incoming) => {
          const chunks = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () => resolve(Buffer.concat(chunks)));
          incoming.on('error', reject);
        },
      );
      request.on('error', reject);
      request.write(Buffer.from('first'));
    });
    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Agent request body was not streamed')), 50),
      ),
    ]);
    request.end(Buffer.from('second'));
    request.destroy();

    assert.deepEqual(response, Buffer.from('first'));
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-streaming-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-streaming-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-streaming-1 close');
  }
});

test('Broker Agent resumes streamed responses after client-side backpressure', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-backpressure-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-backpressure-1' });
  const expectedBody = Buffer.alloc(256 * 1024, 'a');
  let agent;
  guest.attach((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(expectedBody);
  }, 'backpressure-agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-backpressure-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-backpressure-1 connect');
    await withTimeout(
      broker.waitForRoute('backpressure-agent.local.test'),
      'backpressure-agent.local.test route',
    );

    agent = broker.createAgent();
    const response = await withTimeout(
      new Promise((resolve, reject) => {
        const request = http.request('http://backpressure-agent.local.test/large', { agent });
        request.on('response', (incoming) => {
          const chunks = [];
          incoming.pause();
          setTimeout(() => incoming.resume(), 25);
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () => resolve(Buffer.concat(chunks)));
          incoming.on('error', reject);
        });
        request.on('error', reject);
        request.end();
      }),
      'backpressure Agent response',
    );

    assert.equal(response.length, expectedBody.length);
    assert.deepEqual(response, expectedBody);
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-backpressure-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-backpressure-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-backpressure-1 close');
  }
});

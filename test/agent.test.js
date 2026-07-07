const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('./support/guarded-test.cjs');

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
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        clearTimeout(timeout);
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
        // Destroy request and response to trigger socket and stream cleanup
        response.destroy();
        request.destroy();
      });
      response.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
        response.destroy();
        request.destroy();
      });
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error(`test request timeout for ${url}`));
    }, 5000);
    // Clear timeout on first response data to prevent dangling timer
    request.on('response', (response) => {
      response.once('data', () => clearTimeout(timeout));
    });
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

// Warm up TLS/HTTP2 infrastructure so individual tests don't pay the one-time
// initialization cost of TLS contexts, HTTP/2 session state, and OpenSSL caches.
test.before(async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'warmup-broker' });
  const guest = createGuest({ hostUrl, guestId: 'warmup-guest' });
  try {
    await broker.connect();
    await guest.connect();
  } finally {
    await broker.close('warmup');
    await guest.close('warmup');
    await host.close('warmup');
  }
});

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
    // Flush pending process.nextTick callbacks (e.g., sink final destroy)
    await new Promise((resolve) => process.nextTick(resolve));
  }
});

test('Broker Agent follows internal redirects for advertised route targets', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-redirect' });
  const redirectGuest = createGuest({ hostUrl, guestId: 'guest-agent-redirect-a' });
  const targetGuest = createGuest({ hostUrl, guestId: 'guest-agent-redirect-b' });
  let agent;
  redirectGuest.attach((_request, response) => {
    response.writeHead(308, { location: 'http://agent-target.local.test/final' });
    response.end('redirecting');
  }, 'agent-redirect.local.test');
  targetGuest.attach((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      response.writeHead(212, { 'x-agent-redirect': request.url });
      response.end(`${request.method}:${Buffer.concat(chunks).toString('utf8')}`);
    });
  }, 'agent-target.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-redirect connect');
    await withTimeout(redirectGuest.connect(), 'guest-agent-redirect-a connect');
    await withTimeout(targetGuest.connect(), 'guest-agent-redirect-b connect');
    await withTimeout(broker.waitForRoute('agent-redirect.local.test'), 'agent redirect route');
    await withTimeout(broker.waitForRoute('agent-target.local.test'), 'agent target route');

    agent = broker.createAgent();
    const response = await requestWithAgent(
      'http://agent-redirect.local.test/start',
      { agent, method: 'PUT' },
      'payload',
    );

    assert.equal(response.statusCode, 212);
    assert.equal(response.headers['x-agent-redirect'], '/final');
    assert.deepEqual(response.body, Buffer.from('PUT:payload'));
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-redirect close');
    await withTimeout(redirectGuest.close('test-complete'), 'guest-agent-redirect-a close');
    await withTimeout(targetGuest.close('test-complete'), 'guest-agent-redirect-b close');
    await withTimeout(host.close('test-complete'), 'host-agent-redirect close');
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

test('Broker Agent rejects oversized request headers before routing', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({
    hostUrl,
    brokerId: 'broker-agent-header-limit-1',
    maxRequestHeaderBytes: 48,
  });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-header-limit-1' });
  let agent;
  guest.attach((_request, response) => response.end('should-not-route'), 'header-limit.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-header-limit-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-header-limit-1 connect');
    await withTimeout(
      broker.waitForRoute('header-limit.local.test'),
      'header-limit.local.test route',
    );

    agent = broker.createAgent();
    await assert.rejects(
      () =>
        requestWithAgent('http://header-limit.local.test/oversized-header', {
          agent,
          headers: { 'x-large-header': 'x'.repeat(128) },
        }),
      /request header bytes exceed limit/i,
    );
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-header-limit-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-header-limit-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-header-limit-1 close');
  }
});

test('Broker Agent cleans up when client aborts during body upload', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-abort-upload-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-abort-upload-1' });
  let agent;
  let requestReceived = false;
  guest.attach((request, response) => {
    requestReceived = true;
    request.on('data', () => {});
    request.on('end', () => response.end('ok'));
  }, 'abort-upload-agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-abort-upload-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-abort-upload-1 connect');
    await withTimeout(
      broker.waitForRoute('abort-upload-agent.local.test'),
      'abort-upload-agent.local.test route',
    );

    agent = broker.createAgent();
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const request = http.request(
            'http://abort-upload-agent.local.test/abort-upload',
            { agent, method: 'POST' },
            (response) => {
              const chunks = [];
              response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              response.on('end', () => resolve(Buffer.concat(chunks)));
              response.on('error', reject);
            },
          );
          request.on('error', reject);
          // Write some body data, then destroy before completing
          request.write(Buffer.from('partial-body-data'));
          process.nextTick(() => {
            request.destroy(new Error('client-abort'));
          });
        }),
      /client-abort/,
    );
    // The guest handler should not have received the complete request
    // (since the abort happened mid-stream), but may or may not have
    // started receiving data — that's a timing aspect, not a leak concern.
    // The main assertion is that no process crash or hang occurs.
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-abort-upload-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-abort-upload-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-abort-upload-1 close');
  }
});

test('Broker Agent cleans up when client aborts during response streaming', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-abort-response-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-abort-response-1' });
  let agent;
  guest.attach((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    // Stream generated body with write/drain flow control — no buffer retention
    const totalSize = 512 * 1024;
    const chunkSize = 64 * 1024;
    let written = 0;
    function writeNext() {
      if (written >= totalSize) {
        response.end();
        return;
      }
      const chunk = Buffer.alloc(chunkSize, 'b');
      written += chunkSize;
      if (!response.write(chunk)) {
        response.once('drain', writeNext);
      } else {
        setImmediate(writeNext);
      }
    }
    writeNext();
  }, 'abort-response-agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-abort-response-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-abort-response-1 connect');
    await withTimeout(
      broker.waitForRoute('abort-response-agent.local.test'),
      'abort-response-agent.local.test route',
    );

    agent = broker.createAgent();
    // Start reading the response, then abort before fully consuming it
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('abort-during-response timed out')),
            5000,
          );
          const request = http.request('http://abort-response-agent.local.test/large', { agent });
          request.on('response', (incoming) => {
            incoming.once('data', () => {
              clearTimeout(timeout);
              // Abort after receiving the first chunk
              request.destroy(new Error('abort-during-response'));
            });
            incoming.on('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            // Consume rest silently to avoid unhandled error
            incoming.on('data', () => {});
          });
          request.on('error', (error) => {
            clearTimeout(timeout);
            // The request error is expected
            reject(error);
          });
          request.end();
        }),
      /abort-during-response/,
    );
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-abort-response-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-abort-response-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-abort-response-1 close');
  }
});

test('Broker Agent streams large request bodies through leased routing', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({ hostUrl, brokerId: 'broker-agent-large-body-1' });
  const guest = createGuest({ hostUrl, guestId: 'guest-agent-large-body-1' });
  const largeBody = Buffer.alloc(256 * 1024, 'x');
  let agent;
  let receivedSize = 0;
  guest.attach((request, response) => {
    request.on('data', (chunk) => {
      receivedSize += Buffer.from(chunk).length;
    });
    request.on('end', () => {
      response.end(String(receivedSize));
    });
  }, 'large-body-agent.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-large-body-1 connect');
    await withTimeout(guest.connect(), 'guest-agent-large-body-1 connect');
    await withTimeout(
      broker.waitForRoute('large-body-agent.local.test'),
      'large-body-agent.local.test route',
    );

    agent = broker.createAgent();
    // Send as a single contiguous buffer — avoids chunked transfer encoding
    // which would hit the 64KB default chunk-decoder pending limit for
    // 128KB+ write sizes.
    const response = await requestWithAgent(
      'http://large-body-agent.local.test/large-body',
      { agent, method: 'POST' },
      largeBody,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(Number(response.body.toString('utf8')), largeBody.length);
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-large-body-1 close');
    await withTimeout(guest.close('test-complete'), 'guest-agent-large-body-1 close');
    await withTimeout(host.close('test-complete'), 'host-agent-large-body-1 close');
  }
});

test('Broker Agent does not follow internal redirect when request body exceeds replay buffer', async () => {
  const host = createHost({ port: 0 });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createBroker({
    hostUrl,
    brokerId: 'broker-agent-redirect-boundary',
    internalRedirectReplayBufferBytes: 128,
  });
  const redirectGuest = createGuest({ hostUrl, guestId: 'guest-agent-redirect-boundary-a' });
  const targetGuest = createGuest({ hostUrl, guestId: 'guest-agent-redirect-boundary-b' });
  let agent;
  redirectGuest.attach((_request, response) => {
    response.writeHead(308, { location: 'http://agent-target-boundary.local.test/final' });
    response.end('redirecting');
  }, 'agent-redirect-boundary.local.test');
  targetGuest.attach((_request, response) => {
    response.end('should-not-reach');
  }, 'agent-target-boundary.local.test');

  try {
    await withTimeout(broker.connect(), 'broker-agent-redirect-boundary connect');
    await withTimeout(redirectGuest.connect(), 'guest-agent-redirect-boundary-a connect');
    await withTimeout(targetGuest.connect(), 'guest-agent-redirect-boundary-b connect');
    await withTimeout(
      broker.waitForRoute('agent-redirect-boundary.local.test'),
      'agent redirect boundary route',
    );
    await withTimeout(
      broker.waitForRoute('agent-target-boundary.local.test'),
      'agent target boundary route',
    );

    agent = broker.createAgent();
    // Body > 128 bytes exceeds the replay buffer — redirect should NOT be followed
    const response = await requestWithAgent(
      'http://agent-redirect-boundary.local.test/start',
      { agent, method: 'POST' },
      Buffer.alloc(256, 'p'),
    );

    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location, 'http://agent-target-boundary.local.test/final');
  } finally {
    if (agent !== undefined) {
      agent.destroy();
    }
    await withTimeout(broker.close('test-complete'), 'broker-agent-redirect-boundary close');
    await withTimeout(
      redirectGuest.close('test-complete'),
      'guest-agent-redirect-boundary-a close',
    );
    await withTimeout(targetGuest.close('test-complete'), 'guest-agent-redirect-boundary-b close');
    await withTimeout(host.close('test-complete'), 'host-agent-redirect-boundary close');
  }
});

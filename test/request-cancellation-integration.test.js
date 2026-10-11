const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http2 = require('node:http2');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fetch: undiciFetch } = require('undici');
const test = require('./support/guarded-test.cjs');

const {
  collectChildProcessResult,
  createBoundedTextCollector,
  terminateChildProcess,
} = require('./support/child-process.cjs');
const { loadVerserGuestNode, loadVerserHost } = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');

const { createVerserBroker, createVerserNodeGuest } = loadVerserGuestNode();
const { createVerserHost } = loadVerserHost();

const rootDirectory = path.resolve(__dirname, '..');
const nodeGuestFixture = path.join(__dirname, 'support', 'cancellation-guest.cjs');
const pythonGuestFixture = path.join(__dirname, 'support', 'cancellation-guest.py');
const pythonPackageDirectory = path.join(rootDirectory, 'packages', 'verser2-guest-python');
const pythonSourceDirectory = path.join(pythonPackageDirectory, 'src');
const BARRIER_TIMEOUT_MS = 4_000;
const MAX_FIXTURE_OUTPUT_BYTES = 128 * 1024;
const MAX_FIXTURE_EVENTS = 512;
const nodeFetchPromise = import('node-fetch');
const RUNTIME_CONFIGURATIONS = [
  { runtime: 'node', guestId: 'issue83-cancel-node', domain: 'cancel-node.local.test' },
  { runtime: 'bun', guestId: 'issue83-cancel-bun', domain: 'cancel-bun.local.test' },
  {
    runtime: 'python',
    guestId: 'issue83-cancel-python',
    domain: 'cancel-python.local.test',
  },
];
const REQUEST_APIS = ['broker', 'agent-node-fetch', 'create-fetch', 'dispatcher'];

test.before(async () => {
  // Warm the process-wide TLS/HTTP2/OpenSSL machinery before guarded test
  // baselines, matching the existing streaming integration suites.
  requireRuntime('bun', ['--version']);
  requireRuntime('uv', ['--version']);
  const host = createVerserHost({
    port: 0,
    tls: { cert: trusted.certificate, key: trusted.key },
  });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createVerserBroker({
    hostUrl,
    brokerId: 'issue83-cancellation-warmup-broker',
    tls: { ca: trusted.certificate },
  });
  const guest = createVerserNodeGuest({
    hostUrl,
    guestId: 'issue83-cancellation-warmup-guest',
    minWaitingStreams: 3,
    tls: { ca: trusted.certificate },
  });
  guest.attach((_request, response) => response.end('warmup'), 'cancellation-warmup.local.test');
  let agent;
  try {
    await broker.connect();
    await guest.connect();
    await broker.waitForRoute('cancellation-warmup.local.test');
    const response = await broker.request({
      targetId: 'issue83-cancellation-warmup-guest',
      method: 'GET',
      path: '/',
    });
    await consumeFixedBody(response.body, 'warmup', 'cancellation infrastructure warm-up');

    agent = broker.createAgent();
    const { default: nodeFetch } = await nodeFetchPromise;
    const agentResponse = await nodeFetch('http://cancellation-warmup.local.test/agent', {
      agent,
    });
    await agentResponse.arrayBuffer();
    const fetch = broker.createFetch();
    const fetchResponse = await fetch('http://cancellation-warmup.local.test/fetch');
    await fetchResponse.arrayBuffer();
    const dispatcherResponse = await undiciFetch(
      'http://cancellation-warmup.local.test/dispatcher',
      {
        dispatcher: broker.createDispatcher(),
      },
    );
    await dispatcherResponse.arrayBuffer();
  } finally {
    agent?.destroy();
    await broker.close('warm-up complete');
    await guest.close('warm-up complete');
    await host.close('warm-up complete');
  }
});

function requireRuntime(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  assert.equal(
    result.status,
    0,
    `Required cancellation integration runtime ${command} ${args.join(' ')} is unavailable`,
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function withTimeout(promise, label, timeoutMs = BARRIER_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function createFixtureEventReader(child, runtime) {
  const events = [];
  const waiters = new Set();
  const stderr = createBoundedTextCollector(16 * 1024);
  let pendingLine = '';
  let totalOutputBytes = 0;
  let failure;
  let closed = false;
  const exit = deferred();

  const fail = (error) => {
    if (failure !== undefined) return;
    failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of [...waiters]) waiter.notify();
  };

  const notifyWaiters = () => {
    for (const waiter of [...waiters]) waiter.notify();
  };

  child.stdout.on('data', (chunk) => {
    const bytes = Buffer.from(chunk);
    totalOutputBytes += bytes.byteLength;
    if (totalOutputBytes > MAX_FIXTURE_OUTPUT_BYTES) {
      fail(new Error(`${runtime} fixture exceeded its bounded stdout budget`));
      return;
    }
    pendingLine += bytes.toString('utf8');
    if (Buffer.byteLength(pendingLine, 'utf8') > 4096) {
      fail(new Error(`${runtime} fixture emitted an oversized NDJSON line`));
      return;
    }
    while (true) {
      const newline = pendingLine.indexOf('\n');
      if (newline < 0) break;
      const line = pendingLine.slice(0, newline);
      pendingLine = pendingLine.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        fail(new Error(`${runtime} fixture emitted malformed NDJSON: ${String(error)}`));
        return;
      }
      if (events.length > MAX_FIXTURE_EVENTS) {
        fail(new Error(`${runtime} fixture exceeded its bounded event count`));
        return;
      }
      notifyWaiters();
    }
  });
  child.stderr.on('data', (chunk) => stderr.write(chunk));
  child.once('error', fail);
  child.once('close', (code, signal) => {
    closed = true;
    exit.resolve({ code, signal, stderr: stderr.result() });
    if (code !== 0) {
      fail(
        new Error(
          `${runtime} cancellation fixture exited code=${code} signal=${signal}: ${stderr.result().text}`,
        ),
      );
    }
    notifyWaiters();
  });

  const waitFor = (eventName, caseId, label = `${runtime} ${eventName} ${caseId}`) => {
    const matches = (event) =>
      event.event === eventName && (caseId === undefined || event.caseId === caseId);
    const existingIndex = events.findIndex(matches);
    if (existingIndex >= 0) return Promise.resolve(events.splice(existingIndex, 1)[0]);
    if (failure !== undefined) return Promise.reject(failure);
    if (closed) return Promise.reject(new Error(`${label}: fixture exited before barrier`));

    return new Promise((resolve, reject) => {
      const waiter = {
        timer: undefined,
        notify() {
          const index = events.findIndex(matches);
          if (index >= 0) {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            resolve(events.splice(index, 1)[0]);
            return;
          }
          if (failure !== undefined || closed) {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            reject(failure ?? new Error(`${label}: fixture exited before barrier`));
          }
        },
      };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`${label} timed out after ${BARRIER_TIMEOUT_MS} ms`));
      }, BARRIER_TIMEOUT_MS);
      waiters.add(waiter);
      waiter.notify();
    });
  };

  return {
    waitFor,
    has(eventName, caseId) {
      return events.some((event) => event.event === eventName && event.caseId === caseId);
    },
    exit: exit.promise,
    failure: () => failure,
  };
}

function startFixture(runtime, guestId, domain, hostUrl) {
  const environment = {
    ...process.env,
    VERSER_CANCELLATION_RUNTIME: runtime,
    VERSER_HOST_URL: hostUrl,
    VERSER_TLS_CA_FILE: trusted.certificatePath,
    VERSER_GUEST_ID: guestId,
    VERSER_GUEST_DOMAIN: domain,
    VERSER_MIN_WAITING_STREAMS: '3',
  };
  let child;
  if (runtime === 'node' || runtime === 'bun') {
    child = spawn(runtime === 'node' ? process.execPath : 'bun', [nodeGuestFixture], {
      cwd: rootDirectory,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(
      'uv',
      ['run', '--project', pythonPackageDirectory, 'python', pythonGuestFixture],
      {
        cwd: rootDirectory,
        env: { ...environment, PYTHONPATH: pythonSourceDirectory },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  }

  const events = createFixtureEventReader(child, runtime);
  const result = collectChildProcessResult(child, {
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
  });
  return {
    child,
    events,
    async release(caseId) {
      const command = Buffer.from(`${JSON.stringify({ type: 'release', caseId })}\n`);
      if (!child.stdin.write(command)) {
        await new Promise((resolve, reject) => {
          child.stdin.once('drain', resolve);
          child.stdin.once('error', reject);
        });
      }
    },
    async stop() {
      child.stdin.end();
      await terminateChildProcess(child, { timeoutMs: 4_000 });
      const resultValue = await withTimeout(result, `${runtime} fixture process close`, 6_000);
      assert.equal(resultValue.code, 0, `${runtime} fixture stderr: ${resultValue.stderr}`);
    },
  };
}

function createRequestObserver(host) {
  const records = new Map();
  const keyFor = (targetId, path) => `${targetId}\u0000${path}`;
  const watch = (targetId, path) => {
    const key = keyFor(targetId, path);
    let record = records.get(key);
    if (record === undefined) {
      record = { opened: deferred(), closed: deferred(), stream: undefined, closedState: false };
      records.set(key, record);
    }
    return record;
  };

  const server = host.server;
  assert.ok(
    server && typeof server.on === 'function',
    'test requires the Host private native server',
  );
  server.on('stream', (stream, headers) => {
    if (String(headers[':path'] ?? '') !== '/verser/request') return;
    const targetId = String(headers['x-verser-target-id'] ?? '');
    const path = String(headers['x-verser-path'] ?? '');
    const record = watch(targetId, path);
    record.stream = stream;
    record.opened.resolve(stream);
    stream.once('close', () => {
      record.closedState = true;
      record.rstCode = stream.rstCode;
      record.closed.resolve({ rstCode: stream.rstCode });
    });
  });

  return {
    watch,
    forget(targetId, path) {
      records.delete(keyFor(targetId, path));
    },
  };
}

function asObservedPromise(promise) {
  return promise.then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
}

function waitForFirstReadableChunk(stream, label) {
  let settled = false;
  let onData;
  let onError;
  const firstChunk = new Promise((resolve, reject) => {
    onData = (chunk) => {
      if (settled) return;
      settled = true;
      stream.pause();
      resolve(Buffer.byteLength(chunk));
    };
    onError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
  return {
    firstChunk: withTimeout(firstChunk, label),
    waitForFailure() {
      return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          stream.off('data', onUnexpectedData);
          stream.off('error', onError);
          stream.off('end', onEnd);
        };
        const onUnexpectedData = (chunk) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ type: 'data', bytes: Buffer.byteLength(chunk) });
        };
        const onError = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ type: 'error', error });
        };
        const onEnd = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ type: 'end' });
        };
        stream.on('data', onUnexpectedData);
        stream.once('error', onError);
        stream.once('end', onEnd);
        stream.resume();
      });
    },
    async dispose() {
      stream.off('data', onData);
      // Keep an error owner through destroy so cancellation errors are consumed.
      if (!stream.destroyed) stream.destroy();
      stream.off('error', onError);
    },
  };
}

async function firstResponseChunk(response, api, label) {
  if (api === 'dispatcher') {
    return withTimeout(response.firstChunk, label);
  }
  const body = response.body;
  assert.ok(body, `${label}: expected a response body stream`);
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const first = await withTimeout(reader.read(), label);
    assert.equal(first.done, false, `${label}: expected the initial streamed chunk`);
    assert.ok(first.value.byteLength > 0);
    return {
      dispose: async () => {
        try {
          await reader.cancel();
        } catch {
          // The Broker abort may already have canceled this Web reader.
        }
        try {
          reader.releaseLock();
        } catch {
          // The transport may already have released the reader.
        }
      },
      waitForFailure() {
        return reader.read().then(
          (result) =>
            result.done ? { type: 'end' } : { type: 'data', bytes: result.value.byteLength },
          (error) => ({ type: 'error', error }),
        );
      },
    };
  }
  const readable = waitForFirstReadableChunk(body, label);
  await readable.firstChunk;
  return readable;
}

function startOperation(
  api,
  { broker, agent, domain, targetId, path, nodeFetch, routedFetch, dispatcher },
) {
  const controller = new AbortController();
  let operationController;
  const terminal = deferred();
  const firstChunk = deferred();
  let result;
  let resultSettled = false;
  const observeResult = (promise) =>
    asObservedPromise(promise).then((outcome) => {
      resultSettled = true;
      return outcome;
    });

  if (api === 'broker') {
    result = observeResult(
      broker.request({
        targetId,
        routeDomain: domain,
        method: 'POST',
        path,
        headers: { 'content-type': 'text/plain' },
        body: [Buffer.from('small-upload')],
        signal: controller.signal,
      }),
    );
  } else if (api === 'agent-node-fetch') {
    result = observeResult(
      nodeFetch(`http://${domain}${path}`, {
        method: 'POST',
        body: 'small-upload',
        agent,
        signal: controller.signal,
      }),
    );
  } else if (api === 'create-fetch') {
    result = observeResult(
      routedFetch(`http://${domain}${path}`, {
        method: 'POST',
        body: 'small-upload',
        signal: controller.signal,
      }),
    );
  } else if (api === 'dispatcher') {
    let resolveResult;
    result = new Promise((resolve) => {
      resolveResult = (outcome) => {
        resultSettled = true;
        resolve(outcome);
      };
    });
    dispatcher.dispatch(
      {
        origin: `http://${domain}`,
        path,
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('small-upload'),
      },
      {
        onRequestStart(dispatchController) {
          operationController = dispatchController;
        },
        onResponseStart(_dispatchController, statusCode) {
          resolveResult({ response: { statusCode, firstChunk: firstChunk.promise } });
        },
        onResponseData(_dispatchController, chunk) {
          firstChunk.resolve(Buffer.byteLength(chunk));
        },
        onResponseEnd() {
          terminal.resolve({ type: 'end' });
        },
        onResponseError(_dispatchController, error) {
          if (resolveResult !== undefined) resolveResult({ error });
          terminal.resolve({ type: 'error', error });
        },
      },
    );
  } else {
    throw new Error(`Unknown integration request API: ${api}`);
  }

  return {
    result,
    get resultSettled() {
      return resultSettled;
    },
    terminal: terminal.promise,
    abort() {
      if (api === 'dispatcher') {
        operationController?.abort(new Error('cancellation integration abort'));
      } else {
        controller.abort(new Error('cancellation integration abort'));
      }
    },
  };
}

async function consumeFixedBody(stream, expected, label) {
  const expectedBytes = Buffer.from(expected);
  let offset = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    assert.ok(
      offset + bytes.byteLength <= expectedBytes.byteLength,
      `${label}: body exceeded limit`,
    );
    assert.deepEqual(bytes, expectedBytes.subarray(offset, offset + bytes.byteLength));
    offset += bytes.byteLength;
  }
  assert.equal(offset, expectedBytes.byteLength, `${label}: body length mismatch`);
}

async function consumeSibling(outcomePromise, label) {
  const outcome = await withTimeout(outcomePromise, `${label} response`, 8_000);
  assert.equal(
    outcome.error,
    undefined,
    `${label} failed: ${outcome.error?.stack ?? outcome.error}`,
  );
  assert.equal(outcome.response.statusCode, 200);
  await consumeFixedBody(outcome.response.body, 'sibling-ok', label);
}

async function runRuntimeCancellationMatrix(configuration, api) {
  const { default: nodeFetch } = await nodeFetchPromise;
  const { runtime } = configuration;
  const host = createVerserHost({
    port: 0,
    tls: { cert: trusted.certificate, key: trusted.key },
  });
  await host.start();
  const hostUrl = `https://127.0.0.1:${host.address.port}`;
  const broker = createVerserBroker({
    hostUrl,
    brokerId: `issue83-cancellation-${runtime}-${api}-broker`,
    tls: { ca: trusted.certificate },
  });
  const observer = createRequestObserver(host);
  const fixtures = [];
  const agent = broker.createAgent();
  const routedFetch = broker.createFetch();
  const dispatcher = broker.createDispatcher();
  let cancellationCases = 0;
  let completedSiblings = 0;
  let healthyFollowUps = 0;
  let primaryError;
  const shutdownErrors = [];
  const responseBodyDisposers = [];

  try {
    try {
      await broker.connect();
      const fixture = startFixture(runtime, configuration.guestId, configuration.domain, hostUrl);
      fixtures.push({ ...configuration, ...fixture });
      await fixture.events.waitFor('ready', '', `${runtime} Guest ready`);
      await withTimeout(
        broker.waitForRoute(configuration.domain),
        `${runtime} route registration`,
        8_000,
      );

      let caseNumber = 0;
      for (const fixture of fixtures) {
        for (const mode of ['preheader', 'stream']) {
          caseNumber += 1;
          const caseId = `${fixture.runtime}-${api}-${mode}-${caseNumber}`;
          const siblingId = `${caseId}-sibling`;
          const siblingPath = `/sibling/${siblingId}`;
          const cancelPath = `/cancel/${caseId}/${mode}`;
          const cancelHostStream = observer.watch(fixture.guestId, cancelPath);
          const siblingHostStream = observer.watch(fixture.guestId, siblingPath);
          const siblingOutcome = asObservedPromise(
            broker.request({
              targetId: fixture.guestId,
              routeDomain: fixture.domain,
              method: 'GET',
              path: siblingPath,
            }),
          );

          await fixture.events.waitFor('entered', siblingId);
          await fixture.events.waitFor('upload-ended', siblingId);
          await withTimeout(siblingHostStream.opened.promise, `${caseId} sibling Host stream`);
          assert.equal(siblingHostStream.closedState, false);

          const operation = startOperation(api, {
            broker,
            agent,
            domain: fixture.domain,
            targetId: fixture.guestId,
            path: cancelPath,
            nodeFetch,
            routedFetch,
            dispatcher,
          });
          let bodyFailure;
          await fixture.events.waitFor('entered', caseId);
          await fixture.events.waitFor('upload-ended', caseId);
          await withTimeout(cancelHostStream.opened.promise, `${caseId} Host request stream`);
          assert.equal(cancelHostStream.closedState, false);

          if (mode === 'stream') {
            await fixture.events.waitFor('response-started', caseId);
            const openedResponse = await withTimeout(
              operation.result,
              `${caseId} response headers`,
            );
            assert.equal(openedResponse.error, undefined);
            assert.equal(openedResponse.response.statusCode ?? openedResponse.response.status, 200);
            const bodyOwner = await firstResponseChunk(
              openedResponse.response,
              api,
              `${caseId} first body chunk`,
            );
            if (bodyOwner !== undefined && typeof bodyOwner.dispose === 'function') {
              responseBodyDisposers.push(bodyOwner.dispose);
            }
            if (api !== 'dispatcher') bodyFailure = bodyOwner.waitForFailure();
          } else {
            assert.equal(operation.resultSettled, false, `${caseId} responded before cancellation`);
          }

          assert.equal(siblingHostStream.closedState, false, `${caseId} sibling ended prematurely`);
          operation.abort();
          if (mode === 'preheader') {
            const cancelled = await withTimeout(operation.result, `${caseId} local abort result`);
            assert.ok(
              cancelled.error instanceof Error,
              `${caseId} unexpectedly produced a response`,
            );
            if (api === 'dispatcher') {
              await withTimeout(operation.terminal, `${caseId} dispatcher abort callback`);
            }
          } else {
            const bodyOutcome =
              api === 'dispatcher'
                ? await withTimeout(operation.terminal, `${caseId} dispatcher body failure`)
                : await withTimeout(bodyFailure, `${caseId} response body rejection`);
            assert.equal(
              bodyOutcome.type,
              'error',
              `${caseId} response body ended or continued normally instead of failing after abort`,
            );
            assert.ok(bodyOutcome.error instanceof Error, `${caseId} lacked a body failure`);
          }

          await fixture.events.waitFor(
            'disconnect-notified',
            caseId,
            `${caseId} remote disconnect notification`,
          );
          const cleanup = await fixture.events.waitFor(
            'cleanup',
            caseId,
            `${caseId} remote cleanup completion`,
          );
          assert.equal(cleanup.active, false, `${caseId} Guest still owns the canceled resource`);
          if (fixture.runtime === 'bun' && mode === 'preheader') {
            await fixture.events.waitFor(
              'late-disposed',
              caseId,
              `${caseId} late Response disposal`,
            );
          }
          const closed = await withTimeout(
            cancelHostStream.closed.promise,
            `${caseId} native Host reset`,
          );
          assert.equal(
            closed.rstCode,
            http2.constants.NGHTTP2_CANCEL,
            `${caseId} Host stream did not close with RST_STREAM CANCEL`,
          );
          observer.forget(fixture.guestId, cancelPath);
          for (let index = responseBodyDisposers.length - 1; index >= 0; index -= 1) {
            await responseBodyDisposers[index]();
          }
          responseBodyDisposers.length = 0;
          assert.equal(
            siblingHostStream.closedState,
            false,
            `${caseId} cancellation affected sibling`,
          );

          await fixture.release(siblingId);
          await consumeSibling(siblingOutcome, `${caseId} active sibling`);
          await fixture.events.waitFor('completed', siblingId);
          assert.equal(
            fixture.events.has('unexpected-disconnect', siblingId),
            false,
            `${caseId} normal GET upload EOF incorrectly terminated the response`,
          );
          completedSiblings += 1;

          const healthyId = `${caseId}-healthy`;
          const healthyPath = `/normal/${healthyId}`;
          const healthyOutcome = asObservedPromise(
            broker.request({
              targetId: fixture.guestId,
              routeDomain: fixture.domain,
              method: 'GET',
              path: healthyPath,
            }),
          );
          await fixture.events.waitFor('entered', healthyId);
          await fixture.events.waitFor('upload-ended', healthyId);
          const healthy = await withTimeout(healthyOutcome, `${caseId} same-session follow-up`);
          assert.equal(healthy.error, undefined);
          assert.equal(healthy.response.statusCode, 200);
          await consumeFixedBody(healthy.response.body, 'normal-ok', `${caseId} healthy follow-up`);
          await fixture.events.waitFor('completed', healthyId);
          observer.forget(fixture.guestId, siblingPath);
          assert.equal(
            broker.sessionCount,
            1,
            `${caseId} unexpectedly lost the shared Broker session`,
          );
          healthyFollowUps += 1;
          cancellationCases += 1;
        }
      }
      assert.equal(cancellationCases, 2);
      assert.equal(completedSiblings, 2);
      assert.equal(healthyFollowUps, 2);
    } catch (error) {
      primaryError = error;
    }
  } finally {
    for (const dispose of responseBodyDisposers) {
      try {
        await dispose();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }
    for (const fixture of fixtures) {
      try {
        await fixture.stop();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }
    try {
      agent.destroy();
    } catch (error) {
      shutdownErrors.push(error);
    }
    try {
      await withTimeout(broker.close('integration-complete'), 'Broker shutdown', 8_000);
    } catch (error) {
      shutdownErrors.push(error);
    }
    try {
      await withTimeout(host.close('integration-complete'), 'Host shutdown', 8_000);
    } catch (error) {
      shutdownErrors.push(error);
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (shutdownErrors.length > 0) {
    throw new AggregateError(shutdownErrors, 'Cancellation integration cleanup failed');
  }
}

for (const configuration of RUNTIME_CONFIGURATIONS) {
  for (const api of REQUEST_APIS) {
    test(
      `TLS ${api} cancellation isolates active requests for the ${configuration.runtime} Guest`,
      { timeout: 40_000 },
      async () => {
        await runRuntimeCancellationMatrix(configuration, api);
      },
    );
  }
}

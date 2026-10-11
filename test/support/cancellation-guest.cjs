const readline = require('node:readline');

const runtime = process.env.VERSER_CANCELLATION_RUNTIME;
const hostUrl = process.env.VERSER_HOST_URL;
const guestId = process.env.VERSER_GUEST_ID;
const domain = process.env.VERSER_GUEST_DOMAIN;
const caFile = process.env.VERSER_TLS_CA_FILE;
const minWaitingStreams = Number(process.env.VERSER_MIN_WAITING_STREAMS ?? 3);

if (!runtime || !hostUrl || !guestId || !domain || !caFile) {
  throw new Error('Missing cancellation Guest environment configuration');
}

const emit = (event, caseId, details = {}) => {
  process.stdout.write(`${JSON.stringify({ event, caseId, runtime, ...details })}\n`);
};

const gates = new Map();
const activeRequests = new Set();
const getGate = (caseId) => {
  let gate = gates.get(caseId);
  if (gate === undefined) {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    gate = { promise, release };
    gates.set(caseId, gate);
  }
  return gate;
};

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  try {
    const command = JSON.parse(line);
    if (command.type === 'release' && typeof command.caseId === 'string') {
      getGate(command.caseId).release();
    }
  } catch {
    // Parent commands are test-owned bounded NDJSON; malformed input is ignored.
  }
});

const parsePath = (path) => {
  const parts = path.split('/').filter(Boolean);
  return { kind: parts[0], caseId: parts[1] ?? '', mode: parts[2] ?? '' };
};

const readNodeUpload = (request) =>
  new Promise((resolve, reject) => {
    let bytes = 0;
    const onData = (chunk) => {
      bytes += Buffer.byteLength(chunk);
    };
    const onEnd = () => {
      request.off('data', onData);
      request.off('error', onError);
      resolve(bytes);
    };
    const onError = (error) => {
      request.off('data', onData);
      request.off('end', onEnd);
      reject(error);
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.resume();
  });

const makeNodeGuest = async () => {
  const { loadVerserGuestNode } = require('./verser-package-imports.cjs');
  const { createVerserNodeGuest } = loadVerserGuestNode();
  const guest = createVerserNodeGuest({
    hostUrl,
    guestId,
    minWaitingStreams,
    tls: { caFile },
  });

  guest.attach(async (request, response) => {
    const { kind, caseId, mode } = parsePath(request.url);
    if (kind === 'cancel') {
      activeRequests.add(caseId);
      emit('entered', caseId);
      let terminalResolve;
      let notified = false;
      const terminal = new Promise((resolve) => {
        terminalResolve = resolve;
      });
      const notifyDisconnect = () => {
        if (notified) return;
        notified = true;
        emit('disconnect-notified', caseId);
        terminalResolve();
      };
      request.once('error', notifyDisconnect);
      response.once?.('error', notifyDisconnect);
      response.once?.('close', notifyDisconnect);

      try {
        const uploadBytes = await readNodeUpload(request);
        emit('upload-ended', caseId, { bytes: uploadBytes });
        if (mode === 'stream') {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          response.write(Buffer.from('first-chunk'));
          emit('response-started', caseId);
        }
        await terminal;
      } finally {
        request.off('error', notifyDisconnect);
        response.off?.('error', notifyDisconnect);
        response.off?.('close', notifyDisconnect);
        activeRequests.delete(caseId);
      }
      emit('cleanup', caseId, { active: activeRequests.has(caseId) });
      return;
    }

    if (kind === 'sibling') {
      emit('entered', caseId);
      request.once('error', () => emit('unexpected-disconnect', caseId));
      const uploadBytes = await readNodeUpload(request);
      emit('upload-ended', caseId, { bytes: uploadBytes });
      await getGate(caseId).promise;
      response.end('sibling-ok');
      emit('completed', caseId);
      return;
    }

    if (kind === 'normal') {
      emit('entered', caseId);
      await readNodeUpload(request);
      emit('upload-ended', caseId, { bytes: 0 });
      response.end('normal-ok');
      emit('completed', caseId);
      return;
    }

    response.writeHead(404);
    response.end('not-found');
  }, domain);
  await guest.connect();
  emit('ready', '');
  await new Promise((resolve) => process.once('SIGTERM', resolve));
  await guest.close('integration-shutdown');
};

const readWebUpload = async (request) => {
  if (request.body === null) return 0;
  const reader = request.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return bytes;
      bytes += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
};

const makeBunGuest = async () => {
  const { loadVerserGuestBun } = require('./verser-package-imports.cjs');
  const { createVerserBunGuest } = loadVerserGuestBun();
  const guest = createVerserBunGuest({
    hostUrl,
    guestId,
    minWaitingStreams,
    tls: { caFile },
  });
  const activeRequests = new Set();

  guest.attach(
    {
      fetch: async (request) => {
        const { kind, caseId, mode } = parsePath(new URL(request.url).pathname);
        if (kind === 'cancel') {
          activeRequests.add(caseId);
          emit('entered', caseId);
          const uploadBytes = await readWebUpload(request);
          emit('upload-ended', caseId, { bytes: uploadBytes });
          let disconnectNotified = false;
          const notifyDisconnect = () => {
            if (disconnectNotified) return;
            disconnectNotified = true;
            emit('disconnect-notified', caseId);
          };
          request.signal.addEventListener('abort', notifyDisconnect, { once: true });

          if (mode === 'stream') {
            const body = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('first-chunk'));
              },
              cancel() {
                request.signal.removeEventListener('abort', notifyDisconnect);
                activeRequests.delete(caseId);
                emit('cleanup', caseId, { active: activeRequests.has(caseId) });
              },
            });
            emit('response-started', caseId);
            return new Response(body, { status: 200 });
          }

          await new Promise((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', resolve, { once: true });
          });
          request.signal.removeEventListener('abort', notifyDisconnect);
          activeRequests.delete(caseId);
          emit('cleanup', caseId, { active: activeRequests.has(caseId) });
          const lateBody = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('late-response'));
            },
            cancel() {
              emit('late-disposed', caseId);
            },
          });
          return new Response(lateBody, { status: 200 });
        }

        if (kind === 'sibling') {
          emit('entered', caseId);
          request.signal.addEventListener('abort', () => emit('unexpected-disconnect', caseId), {
            once: true,
          });
          const uploadBytes = await readWebUpload(request);
          emit('upload-ended', caseId, { bytes: uploadBytes });
          await getGate(caseId).promise;
          emit('completed', caseId);
          return new Response('sibling-ok');
        }

        if (kind === 'normal') {
          emit('entered', caseId);
          await readWebUpload(request);
          emit('upload-ended', caseId, { bytes: 0 });
          emit('completed', caseId);
          return new Response('normal-ok');
        }

        return new Response('not-found', { status: 404 });
      },
    },
    domain,
  );
  await guest.connect();
  emit('ready', '');
  await new Promise((resolve) => process.once('SIGTERM', resolve));
  await guest.close('integration-shutdown');
};

const main = runtime === 'node' ? makeNodeGuest : runtime === 'bun' ? makeBunGuest : undefined;
if (main === undefined) throw new Error(`Unsupported runtime ${runtime}`);
main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});

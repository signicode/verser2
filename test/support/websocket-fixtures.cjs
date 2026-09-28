const { trusted } = require('./tls-fixtures.cjs');
const { loadVerserGuestNode, loadVerserHost } = require('./verser-package-imports.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker, createVerserNodeGuest } = loadVerserGuestNode();

function createHost(options = {}) {
  return createVerserHost({
    ...options,
    tls: { cert: trusted.certificate, key: trusted.key, ...options.tls },
  });
}

function createBroker(options) {
  return createVerserBroker({
    ...options,
    tls: { ca: trusted.certificate, ...options.tls },
  });
}

function createGuest(options) {
  return createVerserNodeGuest({
    ...options,
    tls: { ca: trusted.certificate, ...options.tls },
  });
}

function createDirectFixture(domain = 'ws-direct.local.test') {
  const host = createHost({ port: 0 });
  let broker;
  let guest;
  const sockets = new Set();
  const attach = () =>
    guest?.attachWebSocket((open, ws) => {
      trackTerminal(ws);
      sockets.add(ws);
      return scenario(open, ws);
    }, domain);
  let scenario = () => undefined;
  return {
    domain,
    get host() {
      return host;
    },
    get broker() {
      return broker;
    },
    get guest() {
      return guest;
    },
    setScenario(handler) {
      scenario = handler;
      attach();
    },
    async start() {
      await host.start();
      const hostUrl = `https://127.0.0.1:${host.address.port}`;
      broker = createBroker({ hostUrl, brokerId: 'ws-direct-broker' });
      guest = createGuest({ hostUrl, guestId: 'ws-direct-guest' });
      attach();
      const webSocket = broker.webSocket.bind(broker);
      broker.webSocket = async (...args) => {
        const ws = await webSocket(...args);
        trackTerminal(ws);
        sockets.add(ws);
        return ws;
      };
      await broker.connect();
      await guest.connect();
      await broker.waitForRoute(domain);
    },
    async reset() {
      await Promise.all([...sockets].map((socket) => cleanupSocket(socket)));
      sockets.clear();
      scenario = () => undefined;
      attach();
    },
    async close(reason = 'test-cleanup') {
      await this.reset();
      await closePeer(broker, reason);
      await closePeer(guest, reason);
      await closePeer(host, reason);
    },
  };
}

function waitForEvent(emitter, eventName, timeoutMs = 3000, options = {}) {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = () => {
    clearTimeout(timer);
    emitter.off(eventName, onEvent);
    emitter.off('error', onError);
  };
  const settle = (callback) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const onEvent = (...args) => settle(() => resolvePromise(args));
  const onError = (error) => {
    if (options.ignoreError === true) return;
    settle(() => rejectPromise(error));
  };
  emitter.once(eventName, onEvent);
  emitter.once('error', onError);
  const timer = setTimeout(
    () => settle(() => rejectPromise(new Error(`Timed out waiting for ${eventName}`))),
    timeoutMs,
  );
  return { promise, dispose: cleanup };
}

function createDeferred(label, timeoutMs = 3000) {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  const dispose = () => clearTimeout(timer);
  const resolve = (value) => {
    if (settled) return;
    settled = true;
    dispose();
    resolvePromise(value);
  };
  const reject = (error) => {
    if (settled) return;
    settled = true;
    dispose();
    rejectPromise(error);
  };
  return { promise, resolve, reject, dispose };
}

function trackTerminal(socket) {
  const existing = terminalObservers.get(socket);
  if (existing !== undefined) return existing;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const record = { type: 'close', error: undefined };
  const cleanup = () => {
    socket.off('close', onClose);
    socket.off('error', onError);
  };
  const onClose = (code, reason) => {
    cleanup();
    resolvePromise({ ...record, code, reason });
  };
  const onError = (error) => {
    record.error = error;
  };
  socket.once('close', onClose);
  socket.once('error', onError);
  const observer = { promise, dispose: cleanup };
  terminalObservers.set(socket, observer);
  return observer;
}

const observeTerminal = trackTerminal;

async function cleanupSocket(socket, reason = 'test-cleanup', timeoutMs = 3000) {
  if (socket === undefined) return;
  const terminal = trackTerminal(socket);
  let timer;
  try {
    socket.close(1000, reason);
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for WebSocket cleanup')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    terminal.dispose();
  }
}

const closeSocket = cleanupSocket;

const terminalObservers = new WeakMap();

function waitForMessages(emitter, count, timeoutMs = 3000) {
  const messages = [];
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = () => {
    clearTimeout(timer);
    emitter.off('message', onMessage);
    emitter.off('error', onError);
  };
  const settle = (callback) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const onMessage = (...args) => {
    messages.push(args);
    if (messages.length === count) settle(() => resolvePromise(messages));
  };
  const onError = (error) => settle(() => rejectPromise(error));
  emitter.on('message', onMessage);
  emitter.once('error', onError);
  const timer = setTimeout(
    () => settle(() => rejectPromise(new Error(`Timed out waiting for ${count} messages`))),
    timeoutMs,
  );
  return { promise, dispose: cleanup };
}

function waitForCloseOrError(emitter, timeoutMs = 3000) {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const cleanup = () => {
    clearTimeout(timer);
    emitter.off('close', onClose);
    emitter.off('error', onError);
  };
  const settle = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };
  const onClose = (code, reason) => settle({ type: 'close', code, reason });
  const onError = (error) => settle({ type: 'error', error });
  emitter.once('close', onClose);
  emitter.once('error', onError);
  const timer = setTimeout(() => settle({ type: 'timeout' }), timeoutMs);
  return { promise, dispose: cleanup };
}

async function closePeer(peer, reason = 'test-cleanup') {
  if (peer !== undefined) await peer.close(reason).catch(() => undefined);
}

module.exports = {
  closePeer,
  closeSocket,
  createBroker,
  createDeferred,
  createDirectFixture,
  createGuest,
  createHost,
  trackTerminal,
  observeTerminal,
  waitForMessages,
  waitForCloseOrError,
  waitForEvent,
};

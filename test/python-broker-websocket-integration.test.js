const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('./support/guarded-test.cjs');
const {
  loadVerserGuestBun,
  loadVerserGuestNode,
  loadVerserHost,
} = require('./support/verser-package-imports.cjs');
const { trusted } = require('./support/tls-fixtures.cjs');
const { terminateChildProcess } = require('./support/child-process.cjs');

const { createVerserHost } = loadVerserHost();
const { createVerserBroker: createNodeBroker, createVerserNodeGuest } = loadVerserGuestNode();
const { createVerserBroker: createBunBroker, createVerserBunGuest } = loadVerserGuestBun();

const pythonDirectory = `${process.cwd()}/packages/verser2-guest-python`;
const pythonSource = `${pythonDirectory}/src`;

function hasUv() {
  return spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;
}

function waitForReady(child, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not become ready`)), 15_000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (/Traceback|Error|Exception/.test(chunk.toString())) {
        clearTimeout(timer);
        reject(new Error(chunk.toString()));
      }
    });
  });
}

function runPythonBroker(hostUrl, domains, brokerId = 'python-ws-integration') {
  const code = `
import asyncio, json, os
from verser2_guest_python import VerserWebSocketError, create_verser_broker

async def main():
    async with create_verser_broker(host_url=os.environ["HOST_URL"], broker_id=os.environ["BROKER_ID"], tls_ca_file=os.environ["CA_FILE"]) as broker:
        results = []
        for domain in os.environ["DOMAINS"].split(","):
            await broker.wait_for_route(domain)
            ws = await broker.websocket("http://" + domain + "/socket", protocol="python.v1")
            await ws.send_text("text-" + domain)
            text = await ws.receive()
            await ws.send_bytes(b"\\x00\\xff")
            binary = await ws.receive()
            await ws.ping("nonce")
            pong = await ws.receive()
            if pong["type"] != "pong" or pong["data"] != "nonce":
                raise RuntimeError("Python Broker ping/pong mismatch")
            await ws.close(1000, "done")
            close = await ws.receive()
            if close["type"] != "close" or close["code"] != 1000 or close["reason"] != "done":
                raise RuntimeError("Python Broker close propagation mismatch")
            results.append([domain, ws.protocol, text, binary["data"].hex(), close["code"], close["reason"]])
        aborted = await broker.websocket("http://" + os.environ["DOMAINS"].split(",")[0] + "/socket", protocol="python.v1")
        await aborted.abort()
        results.append(["aborted", aborted.closed])
        try:
            await broker.websocket("http://" + os.environ["UNAVAILABLE_DOMAIN"] + "/socket")
        except VerserWebSocketError as error:
            results.append(["unavailable", error.code, error.context])
        results.append(["cleanup", not broker._websockets])
        print("RESULT " + json.dumps(results, sort_keys=True), flush=True)

asyncio.run(main())
`;
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--project', pythonDirectory, 'python', '-c', code], {
      env: {
        ...process.env,
        PYTHONPATH: pythonSource,
        HOST_URL: hostUrl,
        CA_FILE: trusted.certificatePath,
        BROKER_ID: brokerId,
        DOMAINS: domains.join(','),
        UNAVAILABLE_DOMAIN: 'python-ws-unavailable.local',
      },
    });
    let output = '';
    let result;
    const timer = setTimeout(() => {
      void terminateChildProcess(child);
      reject(new Error('Python Broker WebSocket integration timed out'));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('RESULT ')) {
        result = JSON.parse(output.split('RESULT ')[1].trim());
      }
    });
    child.stderr.on('data', (chunk) => {
      if (/Traceback|Error|Exception/.test(chunk.toString())) {
        clearTimeout(timer);
        reject(new Error(chunk.toString()));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (result !== undefined && code === 0) resolve(result);
      else reject(new Error(`Python Broker exited before clean completion: ${code}`));
    });
  });
}

async function exerciseNodeStyleBroker(broker, targets) {
  for (const target of targets) {
    const socket = await broker.webSocket({
      targetId: target.targetId,
      domain: target.domain,
      protocol: 'python.v1',
    });
    assert.equal(socket.protocol, 'python.v1');
    const text = new Promise((resolve) => socket.once('message', resolve));
    await socket.send(`matrix-${target.domain}`, { type: 'text' });
    assert.equal(await text, `matrix-${target.domain}`);
    const binary = new Promise((resolve) => socket.once('message', resolve));
    await socket.send(Buffer.from([0, 255]), { type: 'binary' });
    assert.deepEqual(await binary, Buffer.from([0, 255]));
    const pong = new Promise((resolve) => socket.once('pong', resolve));
    await socket.ping('nonce');
    assert.equal(await pong, 'nonce');
    const close = new Promise((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason })),
    );
    socket.close(1000, 'matrix-done');
    assert.deepEqual(await close, { code: 1000, reason: 'matrix-done' });
    assert.equal(socket.destroyed, true);
  }
  return targets.length;
}

test(
  '3x3 Broker-runtime by Guest-runtime matrix across local, one-hop, and multi-hop routes',
  {
    skip: hasUv() ? false : 'uv is not installed',
    timeout: 90_000,
    memoryLeakBytes: 4 * 1024 * 1024,
  },
  async () => {
    const tls = { cert: trusted.certificate, key: trusted.key };
    const root = createVerserHost({ port: 0, hostId: 'python-ws-root', tls });
    const middle = createVerserHost({ port: 0, hostId: 'python-ws-middle', tls });
    const leaf = createVerserHost({ port: 0, hostId: 'python-ws-leaf', tls });
    await root.start();
    await middle.start();
    await leaf.start();
    const rootUrl = `https://127.0.0.1:${root.address.port}`;
    const middleUrl = `https://127.0.0.1:${middle.address.port}`;
    const leafUrl = `https://127.0.0.1:${leaf.address.port}`;
    const topologyHosts = [rootUrl, middleUrl, leafUrl];
    const nodeGuests = topologyHosts.map((hostUrl, index) => {
      const guest = createVerserNodeGuest({
        hostUrl,
        guestId: `python-ws-node-${index}`,
        tls: { ca: trusted.certificate },
      });
      guest.attachWebSocket((_open, ws) => {
        ws.on('message', (data, options) => void ws.send(data, options));
        return { protocol: _open.protocol };
      }, `python-ws-node-${index}.local`);
      return guest;
    });
    const unavailableGuest = createVerserNodeGuest({
      hostUrl: rootUrl,
      guestId: 'python-ws-unavailable',
      tls: { ca: trusted.certificate },
    });
    unavailableGuest.attachWebSocket(() => false, 'python-ws-unavailable.local');
    const bunGuests = topologyHosts.map((hostUrl, index) => {
      const guest = createVerserBunGuest({
        hostUrl,
        guestId: `python-ws-bun-${index}`,
        tls: { ca: trusted.certificate },
      });
      guest.attach(
        {
          fetch(_request, server) {
            server.upgrade(_request);
            return undefined;
          },
          websocket: {
            message(socket, message) {
              void socket.send(message);
            },
          },
        },
        `python-ws-bun-${index}.local`,
      );
      return guest;
    });
    const nodeBroker = createNodeBroker({
      hostUrl: rootUrl,
      brokerId: 'python-ws-node-broker',
      tls: { ca: trusted.certificate },
    });
    const bunBroker = createBunBroker({
      hostUrl: rootUrl,
      brokerId: 'python-ws-bun-broker',
      tls: { ca: trusted.certificate },
    });
    const pythonApp = `
import asyncio, os
from verser2_guest_python import create_verser_guest
async def app(scope, receive, send):
    if scope["type"] != "websocket": return
    await receive()
    await send({"type":"websocket.accept", "subprotocol":"python.v1"})
    while True:
        event = await receive()
        if event["type"] == "websocket.receive":
            if "text" in event: await send({"type":"websocket.send", "text":event["text"]})
            elif "bytes" in event: await send({"type":"websocket.send", "bytes":event["bytes"]})
        else: return
async def main():
    guest = create_verser_guest(host_url=os.environ["HOST_URL"], guest_id=os.environ["GUEST_ID"], app=app, routed_domains=[os.environ["DOMAIN"]], tls_ca_file=os.environ["CA_FILE"], min_waiting_websocket_streams=2, max_websocket_streams=3)
    await guest.connect()
    for _ in range(100):
        if len(guest._ws_lease_tasks) >= 2:
            break
        await asyncio.sleep(0.01)
    else:
        raise RuntimeError("configured websocket lease spares did not activate")
    print("READY", flush=True)
    await asyncio.Event().wait()
asyncio.run(main())
`;
    const pythonGuests = topologyHosts.map((hostUrl, index) =>
      spawn('uv', ['run', '--project', pythonDirectory, 'python', '-c', pythonApp], {
        env: {
          ...process.env,
          PYTHONPATH: pythonSource,
          HOST_URL: hostUrl,
          CA_FILE: trusted.certificatePath,
          GUEST_ID: `python-ws-python-${index}`,
          DOMAIN: `python-ws-python-${index}.local`,
        },
      }),
    );
    try {
      await middle.connectUpstream({
        upstreamId: 'root',
        url: rootUrl,
        tls: { ca: trusted.certificate },
      });
      await leaf.connectUpstream({
        upstreamId: 'middle',
        url: middleUrl,
        tls: { ca: trusted.certificate },
      });
      await Promise.all(nodeGuests.map((guest) => guest.connect()));
      await unavailableGuest.connect();
      await Promise.all(bunGuests.map((guest) => guest.connect()));
      await nodeBroker.connect();
      await bunBroker.connect();
      await Promise.all(
        pythonGuests.map((guest, index) => waitForReady(guest, `Python Guest ${index}`)),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const targets = topologyHosts.flatMap((_host, index) => [
        { targetId: `python-ws-node-${index}`, domain: `python-ws-node-${index}.local` },
        { targetId: `python-ws-bun-${index}`, domain: `python-ws-bun-${index}.local` },
        { targetId: `python-ws-python-${index}`, domain: `python-ws-python-${index}.local` },
      ]);
      const domains = targets.map((target) => target.domain);
      assert.equal(await exerciseNodeStyleBroker(nodeBroker, targets), 9);
      assert.equal(await exerciseNodeStyleBroker(bunBroker, targets), 9);
      const results = await runPythonBroker(rootUrl, domains);
      assert.deepEqual(
        results.slice(0, domains.length).map((item) => item[0]),
        domains,
      );
      assert.equal(
        results.filter((item) => Array.isArray(item) && item.length > 1 && item[1] === 'python.v1')
          .length,
        9,
      );
      assert.ok(results.slice(0, domains.length).every((item) => item[1] === 'python.v1'));
      assert.ok(results.slice(0, domains.length).every((item) => item[2].data.startsWith('text-')));
      assert.ok(results.slice(0, domains.length).every((item) => item[3] === '00ff'));
      assert.ok(
        results.slice(0, domains.length).every((item) => item[4] === 1000 && item[5] === 'done'),
      );
      assert.deepEqual(results[domains.length], ['aborted', true]);
      assert.equal(results[domains.length + 1][0], 'unavailable');
      assert.equal(results[domains.length + 1][1], 'missing-guest');
      assert.equal(results[domains.length + 1][2].domain, 'python-ws-unavailable.local');
      assert.deepEqual(results[domains.length + 2], ['cleanup', true]);
      const reverseTargets = targets.filter(
        (target) =>
          target.domain.startsWith('python-ws-node-0') ||
          target.domain.startsWith('python-ws-bun-0') ||
          target.domain.startsWith('python-ws-python-0'),
      );
      const reverseResults = await runPythonBroker(
        leafUrl,
        reverseTargets.map((target) => target.domain),
        'python-ws-reverse-broker',
      );
      assert.deepEqual(
        reverseResults.slice(0, reverseTargets.length).map((item) => item[0]),
        reverseTargets.map((target) => target.domain),
      );
      assert.ok(
        reverseResults.slice(0, reverseTargets.length).every((item) => item[1] === 'python.v1'),
      );
    } finally {
      await Promise.all(pythonGuests.map((guest) => terminateChildProcess(guest)));
      await Promise.all(nodeGuests.map((guest) => guest.close('test-complete')));
      await unavailableGuest.close('test-complete');
      await Promise.all(bunGuests.map((guest) => guest.close('test-complete')));
      await nodeBroker.close('test-complete');
      await bunBroker.close('test-complete');
      await leaf.close('test-complete');
      await middle.close('test-complete');
      await root.close('test-complete');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },
);

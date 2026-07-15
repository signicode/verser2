# VWS/1 WebSockets

VWS/1 provides WebSocket-style, message-oriented communication over a dedicated
TLS HTTP/2 stream between a Node Broker and a Guest. It uses explicit framed
messages; it does not forward HTTP/1 `Upgrade` bytes or expose a raw socket.

The supported runtime surfaces are:

- Node Guests accept connections with `guest.attachWebSocket()`.
- Node Brokers open connections with `broker.webSocket()` or the native-facing
  `broker.nativeWebSocket()`.
- Bun Guests use Bun-style `server.upgrade(request)` and `websocket` callbacks;
  Bun-facing Brokers use `broker.webSocket()` or `broker.nativeWebSocket()`.
- Python ASGI Guests receive VWS/1 connections as `websocket` scopes, and Python
  Brokers open them with `await broker.websocket(url, protocol=...)` (also
  available as `web_socket`).

Connect the Host, Guest, and Broker as described in [Connecting](./connecting.md)
before opening a WebSocket.

## Node example

This echo example accepts only the `chat.v1` subprotocol, echoes text and binary
messages, then opens and closes a connection from a Broker:

```ts
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'chat-guest',
  tls: { caFile: '/etc/verser/ca.crt' },
});
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'chat-broker',
  tls: { caFile: '/etc/verser/ca.crt' },
});

guest.attachWebSocket((open, ws) => {
  if (open.protocol !== 'chat.v1') return false;

  ws.on('message', (data, { type }) => {
    void ws.send(data, { type }).catch((error) => console.error('send failed', error));
  });
  ws.on('error', (error) => console.error('WebSocket error', error));

  return { protocol: 'chat.v1' };
}, 'chat.local.test');

await guest.connect();
await broker.connect();
await broker.waitForRoute('chat.local.test');

const ws = await broker.webSocket({
  targetId: 'chat-guest',
  domain: 'chat.local.test',
  path: '/room/general',
  protocol: 'chat.v1',
});

ws.on('message', (data, { type }) => console.log(type, data));
ws.on('close', (code, reason) => console.log('closed', code, reason));
ws.on('error', (error) => console.error('WebSocket error', error));

await ws.send('hello', { type: 'text' });
await ws.send(Buffer.from([0x00, 0xff]), { type: 'binary' });
await ws.ping('still here'); // the Guest automatically replies with pong
ws.close(1000, 'done');
```

For code that expects an EventTarget-style socket, use
`await broker.nativeWebSocket({ targetId, domain, path, protocol })`. It exposes
`send`, `close`, `ping`, `pong`, `bufferedAmount`, and `open`/`message`/`close`/
`error` events. `send()` is intentionally fire-and-report: observe `error` and
`close` for asynchronous transport failures.

`attachWebSocket(handler, domain?)` receives `{ domain, path, protocol }` and a
`VerserWebSocket`. Return `undefined` or `{ protocol }` to accept; return
`false` or `null` to reject. `broker.webSocket()` requires `targetId` and
`domain`; `path` and `protocol` are optional.

`VerserWebSocket.send(data, { type })` accepts text (`string`) or binary
(`Buffer`) messages and returns a promise that observes stream backpressure.
It emits `message`, `pong`, `close`, and `error`. `close(code?, reason?)`
performs a close handshake. Invalid close codes and close reasons longer than
123 UTF-8 bytes are rejected; abnormal transport loss is reported locally as
close code `1006` and is never sent on the wire. The encoded VWS/1 frame is
limited to 1 MiB; because binary messages are base64 encoded, their usable
binary capacity is lower than 1 MiB. Larger messages close the connection with
`1009`.

## Python ASGI Guest example

The Python Guest handles VWS/1 automatically when its ASGI application receives
a `websocket` scope. A Node or Python Broker can open the connection using the
Node or Python client surfaces described above.

```py
async def app(scope, receive, send):
    if scope["type"] != "websocket":
        # Handle HTTP scopes here.
        return

    await receive()  # {"type": "websocket.connect"}
    await send({"type": "websocket.accept", "subprotocol": "chat.v1"})

    while True:
        event = await receive()
        if event["type"] == "websocket.disconnect":
            return
        if event["type"] == "websocket.receive" and event.get("text") is not None:
            await send({"type": "websocket.send", "text": event["text"]})
        elif event["type"] == "websocket.receive":
            await send({"type": "websocket.send", "bytes": event["bytes"]})
```

The ASGI adapter maps text and binary messages to `websocket.receive`, sends a
`websocket.disconnect` event on close or transport loss, and automatically
replies to pings. Send `websocket.close` with a valid close code and optional
reason to close from the application.

Python Brokers have the async client surface:

```py
async with create_verser_broker(
    host_url="https://localhost:8443",
    broker_id="python-broker",
    tls_ca_file="/etc/verser/ca.crt",
) as broker:
    ws = await broker.websocket(
        "https://chat.local.test/room/general", protocol="chat.v1"
    )
    await ws.send_text("hello")
    event = await ws.receive()
    await ws.close(1000, "done")
```

The Python Broker is async and does not expose a native browser/Bun socket
object. `receive()` returns VWS events; `send_text`, `send_bytes`, `ping`,
`pong`, `close`, and `abort` are the public operations.

`VwsAsgiConnection` and `build_websocket_scope()` are public support helpers.
`dispatch_asgi_websocket()` is a test helper; applications should attach their
ASGI app through `create_verser_guest()` instead.

## Bun example

`server.upgrade()` is the Bun-facing Guest entry point; it claims the VWS/1
lease, not an inbound Bun server or a raw HTTP/1 upgrade:

```ts
import { createVerserBunGuest } from '@signicode/verser2-guest-bun';

const guest = createVerserBunGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'bun-chat',
  tls: { caFile: '/etc/verser/ca.crt' },
});
guest.attach({
  fetch(request, server) {
    if (request.url.endsWith('/room/general') &&
        server.upgrade(request, { protocol: 'chat.v1' })) return undefined;
    return new Response('not a WebSocket', { status: 404 });
  },
  websocket: {
    message(ws, message) { ws.send(message); },
    close(_ws, code, reason) { console.log('closed', code, reason); },
  },
}, 'chat.local.test');
await guest.connect();
```

Use a route handler's `(request, server)` arguments and call
`server.upgrade(request, { protocol: 'chat.v1' })` for a WebSocket request; the
handler's `websocket` callbacks then receive the VWS-backed socket. A Bun Guest
does not call `Bun.serve()` or `listen()` for this path.

## Federation and topology

Route advertisements stay protocol-neutral. A Guest advertises only its normal
`domain` and `targetId`; it does not advertise WebSocket capability, and Brokers
do not preflight for it. The selected endpoint decides whether the requested
VWS/1 open is available. Therefore an advertised HTTP route may explicitly
reject a WebSocket open.

For federation, every downstream Host connects outbound to its upstream with
`connectUpstream()`, and each Host in the path must support authenticated
federation-VWS version 1. The Broker connects to any Host that advertises the
route; the Host forwards the open hop by hop to the exact `(targetId, domain)`
candidate. Origin/via Host IDs, loop prevention, and the configured federation
hop limit apply at every hop. A valid runner → hub → manager chain therefore
works without a Guest with the same target ID on the Broker's Host.

Failover is permitted only before acceptance. Once a Guest has accepted, the
socket remains bound to that Guest and path; it is never migrated to another
candidate.

An explicit endpoint rejection is returned as an unavailable WebSocket error,
normally code `missing-guest` with HTTP status 404 (for example, an endpoint
without a WebSocket handler). A selected peer that closes/resets the negotiation
stream without sending `accept` or `error` produces the distinct
`websocket-negotiation-failed` error. A federation peer without the versioned
VWS endpoint also produces that negotiation-failure outcome; it is not silently
downgraded to HTTP upgrade or reported as `missing-guest`.

## Lifecycle, limits, and backpressure

`close(code, reason)` performs a close handshake. Host, Guest, Broker, upstream,
or transport shutdown closes the active socket and releases its dedicated
stream; it does not replay or migrate an accepted connection. Transport loss is
reported locally as close `1006` and is never sent on the wire. Invalid close
codes or reasons over 123 UTF-8 bytes are rejected. Malformed frames use close
`1002`; oversized frames use `1009`.

VWS frames are limited to 1 MiB including framing metadata. Binary payloads are
base64 encoded, so their usable binary payload is lower. Implementations use
bounded queues (64 pending messages in the Python adapters) and incremental
stream writes. Await Node/Python sends where the API returns a promise; Bun's
`send()` returns its bounded-send result and `drain`/`bufferedAmount` expose
consumer pressure. Applications should stop producing after `close`/`error` and
must not retain an unbounded message queue.

## Boundaries

- Generic HTTP/1 upgrades, HTTP `CONNECT`, RFC 8441 extended CONNECT, raw
  TCP/TLS or L4 forwarding, and Agent/Dispatcher upgrade requests are
  unsupported; use the direct VWS/1 Broker APIs.
- Python Host behavior is unsupported. Browser, Rust, Go, and Java runtimes,
  and HTTP/3, are roadmap work rather than supported federation endpoints.
- VWS/1 is not a public gateway. Applications retain authentication,
  authorization, and routing-policy responsibilities.

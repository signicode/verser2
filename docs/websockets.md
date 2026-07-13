# VWS/1 WebSockets

VWS/1 provides WebSocket-style, message-oriented communication over a dedicated
TLS HTTP/2 stream between a Node Broker and a Guest. It uses explicit framed
messages; it does not forward HTTP/1 `Upgrade` bytes or expose a raw socket.

The supported endpoints are:

- Node Guests accept connections with `guest.attachWebSocket()`.
- Node Brokers open connections with `broker.webSocket()`.
- Python ASGI Guests receive VWS/1 connections as `websocket` scopes.

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
a `websocket` scope. A Node Broker opens the connection using the Node example
above; the Python Broker does not provide a VWS/1 client API.

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

`VwsAsgiConnection` and `build_websocket_scope()` are public support helpers.
`dispatch_asgi_websocket()` is a test helper; applications should attach their
ASGI app through `create_verser_guest()` instead.

## Boundaries

- Generic HTTP/1 upgrades, HTTP `CONNECT`, RFC 8441 extended CONNECT, and raw
  TCP/TLS or L4 forwarding are unsupported.
- Agent and Dispatcher upgrade requests are unsupported; use
  `broker.webSocket()` for VWS/1.
- Bun `server.upgrade(request)` returns `false`; Bun Guest VWS/1 support is
  deferred.
- Federated WebSocket routes are explicitly unsupported.
- VWS/1 is not a public gateway. Applications retain authentication,
  authorization, and routing-policy responsibilities.

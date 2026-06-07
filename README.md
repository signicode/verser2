# verser2

`verser2` is a reverse HTTP connectivity package for exposing HTTP servers from client-side processes.

It lets a client process host an HTTP/1 server without opening a listening port, then allows other connected servers to call that HTTP/1 server through a multiplexed connection.

## Development Setup

This repository is an npm workspace monorepo using `packages/*`.

Initial TypeScript package scaffolds:

- `@signicode/verser-common` in `packages/verser-common`
- `@signicode/verser2-host` in `packages/verser2-host`
- `@signicode/verser2-guest-node` in `packages/verser2-guest-node`

Install dependencies:

```sh
npm install
```

Build all workspace packages:

```sh
npm run build
```

Run tests:

```sh
npm test
```

Run coverage with Node's test coverage support:

```sh
npm run test:coverage
```

Run Biome linting and formatting checks:

```sh
npm run lint
```

## What It Does

`verser2` is for cases where a process can make outbound connections but cannot accept inbound connections.

Examples include:

- local development agents
- NAT-restricted clients
- sandboxed runtimes
- worker processes
- containers without exposed ports
- private network services
- temporary remote clients

The client creates or owns a normal HTTP/1 server, but does not need to call `listen()`. Instead, `verser2` receives remote requests over a shared connection and dispatches them into that local HTTP server.

```txt
Connected Guest
    │
    │ HTTP request
    ▼
verser2 connection layer
    │
    │ HTTP/2 multiplexed stream in the current MVP
    ▼
Client Process
    │
    │ in-process HTTP/1 dispatch
    ▼
Non-listening HTTP/1 Server
```

## Core Idea

A guest-side (client side) HTTP server can be called by other connected servers even when it is not listening on a network port.

The examples in this section show the intended product API shape. The currently implemented workspace APIs are listed in [Current TypeScript MVP API](#current-typescript-mvp-api).

```ts
import http from "node:http";
import { Verser2Client } from "verser2";

const localServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const client = new Verser2Client({
  url: "https://broker.example.com"
});

client.registerServer("client-a", localServer);

await client.connect();
```

Another connected guest can then call the client-side server:

```ts
const response = await connectedServer.request({
  target: "client-a",
  method: "GET",
  path: "/health"
});

console.log(await response.json());
```

## Current TypeScript MVP API

The current workspace implementation exposes package-level APIs for the minimal Host, Node Guest, Broker, and plain HTTP Agent path.

```ts
import http from 'node:http';
import { createVerserHost } from '@signicode/verser2-host';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const host = createVerserHost({ port: 8443 });
await host.start();

const hostUrl = 'https://localhost:8443';
const broker = createVerserBroker({ hostUrl, brokerId: 'broker-a' });
const guest = createVerserNodeGuest({ hostUrl, guestId: 'client-a' });

const localServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Handled ${req.method} ${req.url}`);
});

// The local server is attached in-process and does not call listen().
guest.attach(localServer, 'client-a.local.test');

await broker.connect();
await guest.connect();
await broker.waitForRoute('client-a.local.test');

const brokerResponse = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/health',
});

console.log(brokerResponse.statusCode, brokerResponse.body.toString('utf8'));

const agent = broker.createAgent();
http.get('http://client-a.local.test/health', { agent }, (response) => {
  response.pipe(process.stdout);
});
```

### Current MVP transport notes

- The Host uses TLS HTTP/2 with an embedded self-signed development certificate from `@signicode/verser-common`.
- The Broker and Guest use that development certificate as a pinned CA for the MVP path.
- HTTP/3 and QUIC are explicitly not implemented in the current TypeScript MVP.
- A Broker uses one TLS HTTP/2 session and one Broker→Host HTTP/2 stream per routed request.
- The current Guest leg uses a Guest-opened control stream for routed request/response framing. A future leased-stream design is documented under the active Conductor track to replace body transfer over control frames with raw leased HTTP/2 streams.
- The Agent MVP supports plain `http.request`/`http.get` for Host-advertised domains only. Non-advertised hostnames are rejected instead of falling back to DNS.
- Agent keep-alive pooling, HTTPS Agent behavior, trailers, upgrades, and advanced socket features are outside the current MVP subset.

Requests can also be made using the current MVP `http.Agent` exposed by a connected Broker. An `undici` dispatcher remains future work:

```ts
import http from "node:http";
import { Verser2Client } from "verser2";
const client = await new Verser2Client({
  url: "https://broker.example.com"
}).connect();

const agent = client.agent();
const response = await http.get("http://client-a/health", { agent });
console.log(await response.json());
```



## Features

- Expose client-side HTTP/1 servers without opening inbound ports.
- Dispatch remote requests into non-listening `http.Server` instances.
- Allow connected servers to call each other through a shared broker or connection layer.
- Use HTTP/2 streams for multiplexed connectivity.
- Keep HTTP/3 streams as future work; they are not implemented in the current TypeScript MVP.
- Carry many concurrent requests over one physical connection.
- Preserve HTTP method, path, headers, body, and response semantics.
- Support request and response streaming where the transport supports it.
- Keep local application code compatible with normal Node.js HTTP server handlers.

## Why HTTP/2 Now, And HTTP/3 Later

HTTP/2 and HTTP/3 both support multiplexed streams. The current TypeScript MVP implements TLS HTTP/2 only; HTTP/3 is roadmap work.

That means one client connection can carry many independent HTTP requests at the same time:

```txt
single client connection
    ├── stream: GET /health
    ├── stream: POST /jobs
    ├── stream: GET /metrics
    └── stream: POST /rpc/process
```

This avoids opening a new TCP connection for every logical request and makes reverse connectivity more efficient and easier to manage.

## Connection Model

`verser2` has three main roles.

### Client

The client owns a local HTTP/1 server and opens an outbound connection.

```ts
const client = new Verser2Client({
  url: "https://broker.example.com",
  server: localHttpServer,
  id: "client-a"
});

await client.connect();
```

### Broker

The broker accepts connected clients and routes requests between connected peers.

```ts
const broker = new Verser2Broker({
  port: 8443,
  protocols: ["h3", "h2"]
});

await broker.listen();
```

### Connected Server

A connected server can call a client-side HTTP server through the broker.

```ts
const response = await broker.request({
  target: "client-a",
  method: "POST",
  path: "/tasks",
  body: { id: "task-1" }
});
```

## Non-Listening HTTP/1 Servers

A key feature of `verser2` is that local HTTP/1 servers do not need to bind a port.

Instead of this:

```ts
server.listen(3000);
```

Use this:

```ts
await client.connect({ server });
```

The current MVP dispatches to normal request listeners through minimal `IncomingMessage`-like and `ServerResponse`-like shims. Application handlers can remain close to ordinary Node.js HTTP code, but advanced socket internals, upgrades, trailers, and full `IncomingMessage`/`ServerResponse` compatibility are future work.

## Multiplexed Requests

Multiple requests can be active at once over a single client connection.

```ts
await Promise.all([
  broker.request({ target: "client-a", method: "GET", path: "/health" }),
  broker.request({ target: "client-a", method: "GET", path: "/metrics" }),
  broker.request({ target: "client-a", method: "POST", path: "/jobs", body: { id: 1 } })
]);
```

Each Broker-to-Host request maps to a separate HTTP/2 stream in the current MVP. The current Guest leg uses an internal Guest-opened control stream; a future leased-stream design is documented in Conductor to move routed bodies onto one-use raw HTTP/2 streams.

## Streaming Status

`verser2` should support streaming request and response bodies. The current MVP preserves binary bodies for basic routed requests but buffers some request/response data internally and uses MVP control framing on the Guest leg. Full backpressure-aware streaming is future work captured by the leased-stream handoff in the active Conductor track.

```ts
const response = await broker.request({
  target: "client-a",
  method: "POST",
  path: "/upload",
  body: readableStream
});

response.body.pipe(destination);
```

## Protocol Selection

`verser2` prefers modern multiplexed transports.

Recommended default order:

1. HTTP/2 as the current stable default.
2. HTTP/3 when added by a future track.
3. HTTP/1 only for local in-process server dispatch, not for the remote multiplexed connection.

```ts
const client = new Verser2Client({
  url: "https://broker.example.com",
  protocols: ["h3", "h2"],
  server: localServer
});
```

## Expected API Shape

```ts
import http from "node:http";
import { Verser2Client, Verser2Broker } from "verser2";

const broker = new Verser2Broker({
  port: 8443,
  protocols: ["h3", "h2"]
});

await broker.listen();

const localServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Handled ${req.method} ${req.url}`);
});

const client = new Verser2Client({
  id: "client-a",
  url: "https://127.0.0.1:8443",
  server: localServer
});

await client.connect();

const response = await broker.request({
  target: "client-a",
  method: "GET",
  path: "/hello"
});

console.log(await response.text());
```

## Error Handling

Errors should identify:

- connection id
- target client id
- selected protocol
- request method
- request path
- stream id, when available
- remote close reason
- timeout reason
- retry status

## Lifecycle

Typical lifecycle events:

```ts
client.on("connect", session => {});
client.on("disconnect", reason => {});
client.on("error", error => {});
client.on("reconnect", attempt => {});

broker.on("client", client => {});
broker.on("request", request => {});
broker.on("streamError", error => {});
```

## Use Cases

- Calling HTTP services running inside client processes.
- Exposing local developer tools without opening a port.
- Connecting private services to shared brokers.
- Running HTTP handlers in sandboxes or workers.
- Building peer-to-peer-like HTTP routing through connected servers.
- Supporting agents that can call out but cannot receive direct inbound traffic.

## Limitations

- `verser2` is not a general-purpose public HTTP gateway by itself.
- HTTP/3 is not implemented in the current TypeScript MVP; availability will depend on future runtime and platform support.
- Local HTTP/1 servers are dispatched in-process and are not automatically exposed as public network listeners.
- Authentication, authorization, and target routing policies must be configured by the application or broker layer.

## Status

`verser2` is intended as a modern replacement for reverse HTTP connectivity built around multiplexed sessions. The current TypeScript MVP uses TLS HTTP/2; HTTP/3 remains roadmap work.

The primary design goal is simple:

> Let connected servers call HTTP/1 servers running inside client processes, even when those client-side servers are not listening on a network port.

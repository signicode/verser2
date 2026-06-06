# verser2

`verser2` is a reverse HTTP connectivity package for exposing HTTP servers from client-side processes.

It lets a client process host an HTTP/1 server without opening a listening port, then allows other connected servers to call that HTTP/1 server through a multiplexed connection.

## Development Setup

This repository is an npm workspace monorepo using `packages/*`.

Initial TypeScript package scaffolds:

- `packages/verser2-host`
- `packages/verser2-guest-node`

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
Connected Server
    │
    │ HTTP request
    ▼
verser2 connection layer
    │
    │ HTTP/2 or HTTP/3 multiplexed stream
    ▼
Client Process
    │
    │ in-process HTTP/1 dispatch
    ▼
Non-listening HTTP/1 Server
```

## Core Idea

A client-side HTTP server can be called by other connected servers even when it is not listening on a network port.

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
  url: "https://broker.example.com",
  server: localServer
});

await client.connect();
```

Another connected server can then call the client-side server:

```ts
const response = await connectedServer.request({
  target: "client-a",
  method: "GET",
  path: "/health"
});

console.log(await response.json());
```

## Features

- Expose client-side HTTP/1 servers without opening inbound ports.
- Dispatch remote requests into non-listening `http.Server` instances.
- Allow connected servers to call each other through a shared broker or connection layer.
- Use HTTP/2 streams for multiplexed connectivity.
- Use HTTP/3 streams where supported.
- Carry many concurrent requests over one physical connection.
- Preserve HTTP method, path, headers, body, and response semantics.
- Support request and response streaming where the transport supports it.
- Keep local application code compatible with normal Node.js HTTP server handlers.

## Why HTTP/2 And HTTP/3

HTTP/2 and HTTP/3 both support multiplexed streams.

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

The server still receives normal `IncomingMessage` and `ServerResponse` objects. Application handlers can remain close to ordinary Node.js HTTP code.

## Multiplexed Requests

Multiple requests can be active at once over a single client connection.

```ts
await Promise.all([
  broker.request({ target: "client-a", method: "GET", path: "/health" }),
  broker.request({ target: "client-a", method: "GET", path: "/metrics" }),
  broker.request({ target: "client-a", method: "POST", path: "/jobs", body: { id: 1 } })
]);
```

Each request maps to a separate HTTP/2 or HTTP/3 stream.

## Streaming

`verser2` should support streaming request and response bodies.

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

1. HTTP/3 when available.
2. HTTP/2 as the stable default.
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
- HTTP/3 availability depends on runtime and platform support.
- Local HTTP/1 servers are dispatched in-process and are not automatically exposed as public network listeners.
- Authentication, authorization, and target routing policies must be configured by the application or broker layer.

## Status

`verser2` is intended as a modern replacement for reverse HTTP connectivity built around multiplexed HTTP/2 and HTTP/3 sessions.

The primary design goal is simple:

> Let connected servers call HTTP/1 servers running inside client processes, even when those client-side servers are not listening on a network port.

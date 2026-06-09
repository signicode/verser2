# verser2

`verser2` is a reverse HTTP connectivity package for exposing HTTP servers from client-side processes.

It lets a client process host an HTTP/1 server without opening a listening port, then allows other connected servers to call that HTTP/1 server through a multiplexed connection.

## Development Setup

This repository is an npm workspace monorepo using `packages/*`.

Implemented TypeScript packages:

- `@signicode/verser-common` in `packages/verser-common`
- `@signicode/verser2-guest-js-common` in `packages/verser2-guest-js-common`
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
    │ TLS HTTP/2 routed request stream plus leased body stream
    ▼
Client Process
    │
    │ in-process HTTP/1 dispatch
    ▼
Non-listening HTTP/1 Server
```

## Core Idea

A guest-side (client side) HTTP server can be called by other connected servers even when it is not listening on a network port.

The current TypeScript packages expose a Host, a Node Guest, and a guest-side Broker. A Guest attaches a normal Node HTTP handler without listening on a port, while a Broker connects to the Host and sends requests to advertised Guest routes.

```ts
import fs from 'node:fs';
import http from 'node:http';
import { createVerserHost } from '@signicode/verser2-host';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const ca = fs.readFileSync('/etc/verser/ca.crt', 'utf8');
const cert = fs.readFileSync('/etc/verser/host.crt', 'utf8');
const key = fs.readFileSync('/etc/verser/host.key', 'utf8');

const host = createVerserHost({ port: 8443, tls: { cert, key } });
await host.start();

const hostUrl = 'https://localhost:8443';
const broker = createVerserBroker({ hostUrl, brokerId: 'broker-a', tls: { ca } });
const guest = createVerserNodeGuest({ hostUrl, guestId: 'client-a', tls: { ca } });

const localServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

guest.attach(localServer, 'client-a.local.test');

await broker.connect();
await guest.connect();
await broker.waitForRoute('client-a.local.test');
```

The Broker can then call the Guest-side server:

```ts
const response = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/health',
});

console.log(response.statusCode);
response.body.pipe(process.stdout);
```

## Current TypeScript API

The current workspace implementation exposes package-level APIs for the Host, Node Guest, Broker, plain HTTP Agent path, and Undici/fetch routing path.

```ts
import fs from 'node:fs';
import http from 'node:http';
import { createVerserHost } from '@signicode/verser2-host';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const ca = fs.readFileSync('/etc/verser/ca.crt', 'utf8');
const cert = fs.readFileSync('/etc/verser/host.crt', 'utf8');
const key = fs.readFileSync('/etc/verser/host.key', 'utf8');

const host = createVerserHost({ port: 8443, tls: { cert, key } });
await host.start();

const hostUrl = 'https://localhost:8443';
const broker = createVerserBroker({ hostUrl, brokerId: 'broker-a', tls: { ca } });
const guest = createVerserNodeGuest({ hostUrl, guestId: 'client-a', tls: { ca } });

await broker.connect();
```

Serve a response from the attached Guest handler:

```ts
const jsonServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

guest.attach(jsonServer, 'client-json.local.test');

await guest.connect();
await broker.waitForRoute('client-json.local.test');
```

Send a routed request directly through the Broker:

```ts
const brokerResponse = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/health',
});

console.log(brokerResponse.statusCode);
brokerResponse.body.pipe(process.stdout);
```

Use the Broker's `http.Agent` with ordinary Node HTTP APIs:

```ts
const agent = broker.createAgent();
http.get('http://client-json.local.test/health', { agent }, (response) => {
  response.pipe(process.stdout);
});
```

Use the Broker's Undici `Dispatcher` with `fetch`:

```ts
const dispatcher = broker.createDispatcher();
const fetchResponse = await fetch('http://client-json.local.test/health', { dispatcher });
console.log(await fetchResponse.text());
```

Or create a fetch helper that is already wired to the Broker:

```ts
const routedFetch = broker.createFetch();
const helperResponse = await routedFetch('http://client-json.local.test/health');
console.log(await helperResponse.text());
```

The same routing APIs support streamed request and response bodies:

```ts
const uploadResponse = await broker.request({
  targetId: 'client-a',
  method: 'POST',
  path: '/upload',
  body: readableStream,
});

uploadResponse.body.pipe(destination);
```

```ts
const streamResponse = await fetch('http://client-json.local.test/upload', {
  method: 'POST',
  body: readableStream,
  duplex: 'half',
  dispatcher: broker.createDispatcher(),
});

console.log(streamResponse.status);
```

### Current transport notes

- The Host uses TLS HTTP/2 and requires application-provided certificate and private key material.
- Host `keyFile` private keys must be readable only by the owner (`chmod 0600`) on POSIX systems.
- The Broker and Guest use normal Node.js TLS trust by default, or application-provided `ca`/`caFile` trust when configured. Passing `ca` or `caFile` replaces Node's default CA set for that outbound HTTP/2 connection.
- HTTP/3 and QUIC are explicitly not implemented.
- A Broker uses one TLS HTTP/2 session and one Broker→Host HTTP/2 stream per routed request.
- The Guest maintains a configurable pool of one-use leased HTTP/2 streams. Routed request and response bodies are transferred as raw octets over an assigned lease, not as base64 NDJSON control frames.
- Guest control streams remain for coordination such as route advertisements.
- Node Guest lease pool options include `minWaitingStreams`, `maxOpenStreams`, `leaseAcquireTimeoutMs`, and `maxMetadataBytes`.
- Successful `broker.request()` calls expose `body` as a Node.js `Readable` stream. Error response bodies may be read internally so routed errors include actionable diagnostics.
- The Agent supports plain `http.request`/`http.get` for Host-advertised domains only. Non-advertised hostnames are rejected instead of falling back to DNS.
- The Node Broker also exposes `createDispatcher()` for Undici `fetch(url, { dispatcher })` and `createFetch()` for a local fetch helper preconfigured with Verser routing.
- Agent keep-alive pooling, HTTPS Agent behavior, trailers, upgrades, CONNECT, WebSocket, target TLS semantics, and advanced socket features are not implemented.

### TLS setup

TLS applies to the remote Host/Guest/Broker HTTP/2 transport only. Guest-attached local HTTP/1 servers remain plain in-process Node HTTP handlers; they do not need HTTPS certificates and do not call `listen()` for this routing path.

The Host certificate must be valid for the hostname or IP address used in `hostUrl` because Node.js still performs normal TLS hostname verification.

See [SSL certificate generation](./docs/ssl-certificate-generation.md) for local self-signed certificates, encrypted keys, and Let's Encrypt DNS-01 examples.

Configure Host TLS with direct PEM values:

```ts
import fs from 'node:fs';
import { createVerserHost } from '@signicode/verser2-host';

const host = createVerserHost({
  port: 8443,
  tls: {
    cert: fs.readFileSync('/etc/verser/host.crt', 'utf8'),
    key: fs.readFileSync('/etc/verser/host.key', 'utf8'),
    passphrase: process.env.VERSER_TLS_KEY_PASSPHRASE,
  },
});
```

Or configure Host TLS with certificate files:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
    passphrase: process.env.VERSER_TLS_KEY_PASSPHRASE,
  },
});
```

When using `keyFile`, set the private key mode to `0600` on POSIX systems:

```sh
chmod 0600 /etc/verser/host.key
```

File-based Host TLS can be reloaded after certificate renewal without restarting the process. The new certificate is used for new TLS handshakes; existing HTTP/2 sessions keep their current TLS state.

```ts
await host.start();

host.reloadTlsCertificate();
```

Verser does not install process signal handlers. Applications that want signal-driven reloads can wire them explicitly, and can reuse the same handler later for broader reload work:

```ts
process.on('SIGUSR1', () => {
  try {
    host.reloadTlsCertificate();
  } catch (error) {
    console.error('Failed to reload Verser TLS certificate:', error);
  }
});
```

Configure Guest and Broker trust with direct CA PEM values:

```ts
import fs from 'node:fs';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const ca = fs.readFileSync('/etc/verser/ca.crt', 'utf8');

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { ca },
});

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { ca },
});
```

Or configure trust with CA files:

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});
```

## Features

- Expose client-side HTTP/1 servers without opening inbound ports.
- Dispatch remote requests into non-listening `http.Server` instances.
- Allow connected servers to call each other through a shared broker or connection layer.
- Use HTTP/2 streams for multiplexed connectivity.
- Keep HTTP/3 streams as future work; they are not implemented.
- Carry many concurrent requests over one physical connection.
- Preserve HTTP method, path, headers, body, and response semantics.
- Support request and response streaming where the transport supports it.
- Keep local application code compatible with normal Node.js HTTP server handlers.

## Why HTTP/2 Now, And HTTP/3 Later

HTTP/2 and HTTP/3 both support multiplexed streams. The current TypeScript implementation uses TLS HTTP/2; HTTP/3 is roadmap work.

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

`verser2` has three main implemented roles.

### Host

The Host listens for outbound Guest and Broker connections and routes requests to registered Guest routes.

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
  },
});

await host.start();
```

### Broker

The Broker connects outbound to a Host and sends requests to advertised Guest routes.

```ts
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

await broker.connect();
```

### Guest

The Guest connects outbound to a Host and attaches a local HTTP/1 handler without listening on a port.

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});

guest.attach(localHttpServer, 'client-a.local.test');

await guest.connect();
```

## Non-Listening HTTP/1 Servers

A key feature of `verser2` is that local HTTP/1 servers do not need to bind a port.

Instead of this:

```ts
server.listen(3000);
```

Use this:

```ts
guest.attach(server, 'client-a.local.test');
await guest.connect();
```

The current implementation dispatches to normal request listeners through `IncomingMessage`-like and `ServerResponse`-like shims. Application handlers can remain close to ordinary Node.js HTTP code, while advanced socket internals, upgrades, trailers, and full `IncomingMessage`/`ServerResponse` compatibility remain outside the current API.

## Multiplexed Requests

Multiple requests can be active at once over a single client connection.

```ts
await Promise.all([
  broker.request({ targetId: 'client-a', method: 'GET', path: '/health' }),
  broker.request({ targetId: 'client-a', method: 'GET', path: '/metrics' }),
  broker.request({ targetId: 'client-a', method: 'POST', path: '/jobs', body: ['payload'] }),
]);
```

Each Broker-to-Host request maps to a separate HTTP/2 stream. The Guest leg uses an assigned one-use Guest-opened lease stream for raw routed request and response body bytes, while the Guest control stream remains available for route advertisements and coordination.

## Streaming Status

`verser2` supports streaming request and response bodies on the leased HTTP/2 routed path. Successful `broker.request()` calls return a response body `Readable`, and request bodies may be provided as a `Readable` or as explicit chunks. Error response bodies may still be read internally to produce actionable routed error diagnostics.

```ts
const response = await broker.request({
  targetId: 'client-a',
  method: 'POST',
  path: '/upload',
  body: readableStream,
});

response.body.pipe(destination);
```

## Protocol Selection

`verser2` prefers modern multiplexed transports.

Current protocol roles:

1. TLS HTTP/2 is the implemented remote multiplexed transport between Host, Guest, and Broker.
2. HTTP/1 is used for local in-process server dispatch into normal Node request handlers.
3. HTTP/3 remains roadmap work and is not implemented.

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
  },
});
await host.start();

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});
```

## End-to-End Example

```ts
import fs from 'node:fs';
import http from 'node:http';
import { createVerserHost } from '@signicode/verser2-host';
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const ca = fs.readFileSync('/etc/verser/ca.crt', 'utf8');
const cert = fs.readFileSync('/etc/verser/host.crt', 'utf8');
const key = fs.readFileSync('/etc/verser/host.key', 'utf8');

const host = createVerserHost({ port: 8443, tls: { cert, key } });
await host.start();

const hostUrl = 'https://localhost:8443';
const broker = createVerserBroker({ hostUrl, brokerId: 'broker-a', tls: { ca } });
const guest = createVerserNodeGuest({ hostUrl, guestId: 'client-a', tls: { ca } });

const localServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Handled ${req.method} ${req.url}`);
});

guest.attach(localServer, 'client-a.local.test');

await broker.connect();
await guest.connect();
await broker.waitForRoute('client-a.local.test');

const response = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/hello',
});

response.body.pipe(process.stdout);
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
- HTTP/3 is not implemented; availability will depend on future runtime and platform support.
- Local HTTP/1 servers are dispatched in-process and are not automatically exposed as public network listeners.
- Authentication, authorization, and target routing policies must be configured by the application or broker layer.

## Status

`verser2` is intended as a modern replacement for reverse HTTP connectivity built around multiplexed sessions. The current TypeScript implementation uses TLS HTTP/2; HTTP/3 remains roadmap work.

The primary design goal is simple:

> Let connected servers call HTTP/1 servers running inside client processes, even when those client-side servers are not listening on a network port.

# Verser2 roadmap

This document describes the roadmap for Verser2, a distributed system for building scalable and resilient applications. The roadmap is organized into three main phases: development, testing, and deployment.

## Development

The specifications for the implementation of roadmap items will be created as conductor tracks under [conductor](./conductor) directory and will be linked above as they are created.

### Node.js Implementation

Node.js implementation of Verser2 will be the first phase of development. This will include the core functionality of the client, broker, and connected server components, as well as the HTTP/2 and HTTP/3 transport layers. During development all requests must be streamed, no buffering of request or response bodies should be allowed.

Specific tasks for the Node.js implementation include:

- [x] Implement the core node.js functionality of Verser2, including the client, broker, and connected server components
- [x] Implement the Broker API for routing requests between connected clients (registration, request forwarding, etc.)
- [x] Implement the HTTP/2 transport layer for communication between clients via the broker
- [ ] Implement the HTTP/3 transport layer for communication between clients via the broker
- [x] Implement the http.Agent exposure for client-side requests
- [ ] Implement the undici dispatcher for client-side requests

Status evidence, reviewed 2026-06-07:

- Node Host, Node Guest, and Broker entrypoints exist and expose connection, registration, routing, lifecycle, and local server attachment APIs in `packages/verser2-host/src/index.ts` and `packages/verser2-guest-node/src/index.ts`.
- Broker registration, route advertisements, routed request forwarding, leased stream acquisition, request/response body streaming, and error handling are implemented over HTTP/2 streams in `packages/verser2-host/src/index.ts` and `packages/verser2-guest-node/src/index.ts`, with integration coverage in `test/broker-routing.test.js` and `test/end-to-end.test.js`.
- `VerserBroker.createAgent()` returns a `node:http` Agent implementation for routed client requests in `packages/verser2-guest-node/src/index.ts`.
- No code evidence was found for HTTP/3/QUIC transport or an undici dispatcher API.

### Browser Implementation

The browser implementation of Verser2 will be the second phase of development. This will include a client-side library for connecting to the broker and making requests to connected servers as exposing http servers similarily to node.js on the browser side (e.g. in Service Workers, in web apps).

- [ ] Implement the core browser functionality of Verser2, including the client-side library and support for HTTP/2 and HTTP/3 transport layers
- [ ] Implement the server exposure for browser-side requests.

Status evidence, reviewed 2026-06-07: no browser package or browser runtime implementation was found; documented future browser/Fetch API support remains roadmap work.

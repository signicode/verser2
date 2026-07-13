# Initial Concept

`verser2` is a reverse HTTP connectivity package for exposing HTTP servers from client-side processes. It lets a client process host an HTTP/1 server without opening a listening port, then allows connected hosts, guests, brokers, or peers to call that HTTP/1 server through an outbound connection model.

# Product Guide

## Product Vision

`verser2` is a reverse HTTP connectivity package that lets connected processes call HTTP/1 servers, Bun/Fetch handlers, and ASGI applications running inside client-side processes, even when those client-side services cannot open listening ports. It provides a low-friction way to expose local, sandboxed, NAT-restricted, or agent-hosted services through outbound connections while preserving familiar HTTP semantics.

## Target Users

- Node.js developers who want to embed ordinary HTTP server handlers in processes that cannot accept inbound connections.
- Bun developers who want to expose `fetch(request)` handlers or Bun-style local route tables without opening an inbound listening port.
- Python developers who want to expose ASGI 3 applications, including FastAPI-compatible or Starlette-compatible apps, from processes that cannot accept inbound connections.
- Agent platform teams running local development agents, sandboxed runtimes, worker processes, or containers that can connect outbound but cannot receive direct inbound traffic.
- Package maintainers extending the Host, Guest, Broker, Peer, or shared common library APIs while keeping implementation details reusable across packages.
- Teams planning future guest implementations in other languages after the TypeScript/Node foundation is stable.

## Core Product Model

The product uses the repo nomenclature:

- **Verser2 Host:** The main server that guests connect to. It manages connections and routes requests between guests.
- **Verser2 Guest:** A client that connects to the host. It can make requests to the host and receive requests from the host.
- **Verser2 Broker:** The guest component that connects to the host or hosts and allows making requests to other guests through the host.
- **Verser2 Peer:** A generic connected-client concept used in shared terminology. Current public registration roles are Guest and Broker; direct peer-to-peer behavior is not implemented.

## Initial Milestone

The implemented foundation includes the TypeScript/Node.js package path, a Bun Guest/Broker package, and a Python ASGI Guest/Broker package:

- A shared `@signicode/verser-common` package for reusable protocol-neutral primitives, types, constants, and helpers.
- A configurable TLS HTTP/2 Host that accepts outbound Guest and Broker connections, optionally enforces trusted client certificates for mTLS transport, registers routed domains, supports Guest-owned route revocation, and advertises route lifecycle updates.
- A Node Guest that owns or receives a normal `http.Server` or request listener without calling `listen()`.
- A Bun Guest that adapts Bun/Fetch-style handlers and local Bun-style routes without calling `Bun.serve()` or opening an inbound port, plus a Bun-facing Broker API that reuses the existing transport internally.
- A Python Guest that connects outbound to the existing Host and dispatches routed requests into an ASGI 3 app without opening an inbound port.
- Node, Bun-facing, and Python Broker APIs that can present client certificate identity when configured, observe route lifecycle changes, and route requests through the Host into a connected Guest's local handler; Node Broker request paths also follow eligible internal `307`/`308` redirects for advertised routes with bounded body replay.
- A minimal plain `node:http` Agent path for Host-advertised domains.
- End-to-end request and response forwarding for the MVP path while preserving core HTTP method, path, header, status, and body semantics.

Current MVP limitations are documented in the README: HTTP/3, browser/Rust/Go/Java guests, advanced Agent behavior, Broker per-request authorization, complete authentication/authorization systems, WebSocket forwarding for Bun, and public gateway policy are future track work. Python Host is not implemented and is not on the current roadmap.

## Product Principles

- **Low friction:** Developers should be able to reuse normal Node.js HTTP server handlers with minimal adaptation.
- **Reliability:** Connection lifecycle, timeouts, reconnects, errors, and close reasons should be explicit and actionable.
- **Streaming support:** Request and response bodies should preserve streaming behavior where the selected transport supports it.
- **Shared foundations:** Reusable solution code belongs in common packages before it is duplicated across Host, Guest, Broker, Peer, or runtime-specific packages.
- **Transport incrementality:** Transport behavior, multiplexing, routing, and HTTP/3 support should be introduced only by explicit implementation tracks, not by scaffold or documentation-only work.
- **Incremental language expansion:** TypeScript/Node is the primary implementation target, with Bun Guest/Broker and Python ASGI Guest/Broker support implemented. Browser, Rust, Go, and Java guests belong on the roadmap after the core model is proven.

## Primary Use Cases

- Calling HTTP services running inside client processes.
- Exposing local developer tools without opening a listening port.
- Connecting private or NAT-restricted services to a shared host.
- Running HTTP handlers in sandboxes, workers, or containers without exposed ports.
- Supporting agents that can initiate outbound connections but cannot receive direct inbound traffic.

## Non-Goals

- `verser2` is not a general-purpose public HTTP gateway by itself.
- The first milestone does not implement every language guest.
- Scaffold tracks should not implement HTTP/2 multiplexing, request routing, or HTTP/3 behavior unless the active track explicitly asks for it.
- Authentication, authorization, and routing policy can be designed as host-level capabilities in future tracks, but should not obscure the core Host/Guest request path.

## Success Criteria

- A Node guest can attach a normal HTTP/1 server without opening a port.
- A Bun guest can attach a Bun/Fetch-style handler or local Bun-style route table without opening a port.
- A Python guest can attach an ASGI 3 application without opening a port.
- A connected Broker can issue a request through the host to that guest server.
- Method, path, headers, request body, status, response headers, and response body are preserved, including method-preserving Node Broker internal redirects when the redirected hostname is an advertised route and the body stays within the configured replay limit.
- Shared primitives needed by multiple packages are provided by `@signicode/verser-common` instead of duplicated in package-local implementations.
- Concurrent request or multiplexing behavior is proven only when a track explicitly introduces that transport behavior.
- Errors include enough context to diagnose connection, target, protocol, path, stream, timeout, and close-reason failures.
- Guest-owned route revocation, degraded/disconnected route state, route restoration, and Broker route-change observation are explicit across implemented runtimes.
- Optional Host mTLS registration policy can identify Guest and Broker clients with certificate metadata without changing non-mTLS deployments.

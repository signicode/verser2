# Initial Concept

`verser2` is a reverse HTTP connectivity package for exposing HTTP servers from client-side processes. It lets a client process host an HTTP/1 server without opening a listening port, then allows connected hosts, guests, brokers, or peers to call that HTTP/1 server through an outbound connection model.

# Product Guide

## Product Vision

`verser2` is a reverse HTTP connectivity package that lets connected processes call HTTP/1 servers running inside client-side processes, even when those client-side servers cannot open listening ports. It provides a low-friction way to expose local, sandboxed, NAT-restricted, or agent-hosted services through outbound connections while preserving familiar HTTP semantics.

## Target Users

- Node.js developers who want to embed ordinary HTTP server handlers in processes that cannot accept inbound connections.
- Agent platform teams running local development agents, sandboxed runtimes, worker processes, or containers that can connect outbound but cannot receive direct inbound traffic.
- Package maintainers extending the Host, Guest, Broker, Peer, or shared common library APIs while keeping implementation details reusable across packages.
- Teams planning future guest implementations in other languages after the TypeScript/Node foundation is stable.

## Core Product Model

The product uses the repo nomenclature:

- **Verser2 Host:** The main server that guests connect to. It manages connections and routes requests between guests.
- **Verser2 Guest:** A client that connects to the host. It can make requests to the host and receive requests from the host.
- **Verser2 Broker:** The guest component that connects to the host or hosts and allows making requests to other guests through the host.
- **Verser2 Peer:** A connected client that can send and receive requests through the host or directly to other peers if supported.

## Initial Milestone

The first milestone should establish the TypeScript/Node.js package foundation and then build the core Host/Guest path incrementally:

- A shared `@signicode/verser-common` package for reusable protocol-neutral primitives, types, constants, and helpers.
- A host that accepts outbound guest connections and routes requests.
- A Node guest that owns or receives a normal `http.Server` without calling `listen()`.
- End-to-end request forwarding from a connected caller through the host into the guest's local HTTP/1 server.
- Response forwarding back to the original caller while preserving HTTP semantics.

## Product Principles

- **Low friction:** Developers should be able to reuse normal Node.js HTTP server handlers with minimal adaptation.
- **Reliability:** Connection lifecycle, timeouts, reconnects, errors, and close reasons should be explicit and actionable.
- **Streaming support:** Request and response bodies should preserve streaming behavior where the selected transport supports it.
- **Shared foundations:** Reusable solution code belongs in common packages before it is duplicated across Host, Guest, Broker, Peer, or runtime-specific packages.
- **Transport incrementality:** Transport behavior, multiplexing, routing, and HTTP/3 support should be introduced only by explicit implementation tracks, not by scaffold or documentation-only work.
- **Incremental language expansion:** TypeScript/Node is the primary implementation target. Browser, Bun, Python, Rust, Go, and Java guests belong on the roadmap after the core model is proven.

## Primary Use Cases

- Calling HTTP services running inside client processes.
- Exposing local developer tools without opening a listening port.
- Connecting private or NAT-restricted services to a shared host.
- Running HTTP handlers in sandboxes, workers, or containers without exposed ports.
- Supporting agents that can initiate outbound connections but cannot receive direct inbound traffic.

## Non-Goals

- `verser2` is not a general-purpose public HTTP gateway by itself.
- The first milestone does not need to implement every language guest.
- Scaffold tracks should not implement HTTP/2 multiplexing, request routing, or HTTP/3 behavior unless the active track explicitly asks for it.
- Authentication, authorization, and routing policy can be designed as host-level capabilities in future tracks, but should not obscure the core Host/Guest request path.

## Success Criteria

- A Node guest can attach a normal HTTP/1 server without opening a port.
- A connected peer can issue a request through the host to that guest server.
- Method, path, headers, request body, status, response headers, and response body are preserved.
- Shared primitives needed by multiple packages are provided by `@signicode/verser-common` instead of duplicated in package-local implementations.
- Concurrent request or multiplexing behavior is proven only when a track explicitly introduces that transport behavior.
- Errors include enough context to diagnose connection, target, protocol, path, stream, timeout, and close-reason failures.

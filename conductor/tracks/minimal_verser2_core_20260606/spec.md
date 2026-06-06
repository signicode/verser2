# Specification: Minimal Verser2 Host and Node Guest Core

## Overview

Implement the minimal TypeScript/Node.js version of Verser2 that proves the core reverse HTTP connectivity model across the existing workspace packages:

- `@signicode/verser-common`
- `@signicode/verser2-host`
- `@signicode/verser2-guest-node`

The track will implement the core Host, Node Guest, guest-side Broker, HTTP/2 transport, and Node `http.Agent` exposure needed for a connected caller to route HTTP requests through a Host to a Node Guest that owns a normal `node:http` server without opening a listening port.

This track covers these roadmap items:

- Implement the core Node.js functionality of Verser2, including the client, broker, and connected server components.
- Implement the Broker API for routing requests between connected clients, including registration and request forwarding.
- Implement the HTTP/2 transport layer for communication between clients via the broker.
- Implement the `http.Agent` exposure for client-side requests.

HTTP/3 is explicitly not supported by this track.

## Functional Requirements

### Host

- Provide a minimal Host API for starting and stopping a Verser2 Host.
- Accept TLS HTTP/2 connections from Node Guests and client-side Brokers.
- Register connected guests/peers by explicit identifier.
- Track guest domain registrations and advertise the routed domain map to connected client Brokers so they can decide which requests should be sent over Verser2.
- Route requests from a connected caller to a target guest through the Host.
- Forward response status, headers, and body data back to the original caller.
- Support multiple concurrent routed requests over the selected HTTP/2 transport.
- Emit or expose lifecycle information for connection, registration, request routing, errors, disconnects, and shutdown.

### Node Guest

- Provide a minimal Node Guest API that connects outbound to a Host.
- Allow a normal `node:http` server instance or compatible request listener to be attached without calling `listen()`.
- Register the guest with an explicit guest identifier.
- Receive routed requests from the Host and dispatch them to the attached local HTTP/1 handler/server.
- Preserve method, path, headers, request body, status code, response headers, and response body.
- Support streaming request and response bodies where Node HTTP/2 and the local HTTP/1 handler model allow it.
- Expose lifecycle information for connect, disconnect, reconnect-relevant errors, request handling failures, and close.

### Broker and Routing API

- Provide a minimal guest/client-side Broker API for connecting to the Host and issuing requests to registered guest identifiers.
- Support registration of connected clients/guests with the Host.
- Support registering guest routes by domain name so the Agent can route matching requests over Verser2 without requiring DNS resolution for those guest domains.
- Receive and apply routed domain advertisements from the Host so Brokers can keep their local routing decisions synchronized with currently registered guest domains.
- Support request forwarding through the Host to a selected target guest.
- Preserve streaming and flow control during forwarding: after headers are resolved and forwarded, remaining request and response body data must be streamed with Node `.pipe()` or equivalent backpressure-aware stream plumbing instead of buffering whole bodies.
- Return HTTP-like response information to the caller while preserving familiar Node HTTP semantics.
- Provide actionable errors for missing guests, disconnected targets, timeout or stream failures, protocol errors, and local handler failures.

### HTTP/2 Transport

- Implement TLS-based HTTP/2 transport using Node.js platform APIs.
- Use a single HTTP/2 session per connected Broker/Guest connection to the Host and create individual HTTP/2 streams for routed requests.
- Include minimal self-signed certificate generation or setup support for the Host/Broker/client development path.
- Implement a minimal certificate verification/check mechanism that is safe for the MVP and designed so it can later evolve into a full CA/trust model.
- Keep HTTP/2 transport-specific options explicit and grouped so the basic API remains approachable.
- Do not implement HTTP/3, QUIC, or non-HTTP/2 transports in this track.

### Node `http.Agent` Exposure

- Expose a Node `http.Agent`-compatible integration that lets client-side code issue familiar `http.request`-style calls through Verser2.
- Route Agent-originated requests through the Broker/Host path to target guests.
- Route requests whose hostnames match registered Verser2 guest domains through the Broker without relying on external DNS for those guest domains.
- Preserve ordinary Node HTTP request and response behavior as far as practical for the MVP.
- Document any Agent compatibility limits introduced by the reverse HTTP/2 transport bridge.

## Non-Functional Requirements

- Use TypeScript with strict typing and no explicit `any`.
- Keep reusable protocol-neutral primitives, types, constants, and helpers in `@signicode/verser-common` before duplicating package-local shapes.
- Preserve familiar HTTP semantics and Node developer ergonomics.
- Maintain at least 95% meaningful test coverage for changed behavior where measurable.
- Use test-driven development: write failing focused tests before implementation.
- Prefer small, reviewable phases and narrow validation commands.
- Keep lifecycle and error messages actionable by including relevant context such as guest id, target id, protocol, request method/path, stream id, timeout reason, and close reason when available.

## Acceptance Criteria

- A Host can start with TLS HTTP/2 configuration and accept outbound client/guest connections.
- A Node Guest can attach a normal `node:http` handler/server without opening a local listening port.
- A connected Broker/client can register and send a request through the Host to a target guest id.
- The Host advertises registered routed domains to connected client Brokers, and Brokers use those advertisements to route matching Agent requests through Verser2.
- The target Guest dispatches the request to its local HTTP/1 handler and returns the response to the original caller.
- Method, path, headers, request body, status code, response headers, and response body are preserved for basic requests.
- Streaming request and response bodies are covered by implementation and tests for the MVP-supported behavior.
- Concurrent routed requests over the HTTP/2 transport are implemented and tested.
- Missing guest, disconnect, timeout/stream, protocol, and local handler failure scenarios produce actionable errors or HTTP responses as specified by the implementation API.
- The Node `http.Agent` integration can be used for at least one end-to-end request through the Verser2 Host/Broker/Guest path.
- Self-signed certificate generation/setup and minimal certificate checking are documented and tested at the level needed for the MVP.
- Implementation review includes `AGENTS.md` and relevant Conductor documentation before completion.
- `npm run build`, relevant focused tests, `npm test`, and `npm run lint` pass before the implementation track is considered complete.

## Out of Scope

- HTTP/3 or QUIC transport support.
- Browser, Bun, Python, Rust, Go, Java, or other non-Node guest implementations.
- Authentication, authorization, tokens, ACLs, route-level policy, or a full CA/trust management system.
- General-purpose public HTTP gateway or reverse proxy behavior.
- Production-grade certificate authority management.
- Public internet exposure hardening beyond the minimal certificate check required for this MVP.
- Full compatibility with every advanced `http.Agent` behavior if a smaller documented subset proves the MVP path.

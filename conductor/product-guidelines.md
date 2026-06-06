# Product Guidelines

## Documentation Voice

Use a tutorial-friendly style that helps developers understand the product by building from familiar HTTP concepts. Prefer clear step-by-step explanations, practical examples, and short sections that explain both what to do and why it works.

The tone should be approachable but still technically precise. Avoid marketing language. Explain tradeoffs directly when protocol behavior, streaming, or connection lifecycle details matter.

## Developer Experience Principles

- **Minimal API:** Keep the primary API small and easy to remember. Common use cases should require only the host or guest endpoint, the local HTTP server, and basic request details.
- **Explicit configuration:** Make important operational choices visible, including protocols, timeouts, routing identifiers, reconnect behavior, and lifecycle hooks.
- **Familiar HTTP semantics:** Preserve ordinary method, path, headers, body, status, and response behavior wherever possible.
- **Shared common code:** Put reusable protocol-neutral primitives, types, constants, validation helpers, lifecycle helpers, and error helpers in `@signicode/verser-common` before duplicating them across packages.
- **Runtime portability:** Design shared concepts so future browser, Bun, Python, Rust, Go, and Java guests can map naturally to their runtime HTTP primitives.

## Example Guidelines

Examples should start with familiar Node.js HTTP handlers and clearly show that the local server does not call `listen()`.

Preferred example progression:

1. Create a normal `node:http` server.
2. Connect it as a Verser2 Guest without opening a local port.
3. Send a request through the Verser2 Host to the guest.
4. Read the response as ordinary HTTP data.
5. Extend the example to streaming request or response bodies where relevant.

Examples should include enough context to be understandable without becoming full applications. Use concrete method, path, header, and body values instead of abstract placeholders when possible.

## API Design Guidelines

- Prefer names that reflect the project nomenclature: Host, Guest, Broker, and Peer.
- Keep the default flow close to ordinary HTTP server and request usage.
- Use explicit identifiers for guests and peers so routing is understandable in logs and errors.
- Avoid exposing transport internals in the basic API unless the user needs them for reliability or debugging.
- Keep transport-specific options grouped and optional when an active track introduces transport behavior.
- Design request and response interfaces so streaming can be supported without changing the high-level API.
- Review `@signicode/verser-common` before adding package-local API shapes that could become shared across Host, Guest, Broker, Peer, or runtime packages.

## Error and Lifecycle Guidelines

Errors and events should help users diagnose what happened without reverse-engineering connection state.

When applicable, include:

- connection id
- guest or peer id
- selected protocol
- request method and path
- stream id
- timeout reason
- remote close reason
- retry or reconnect status

Lifecycle documentation should cover connect, disconnect, reconnect, request routing, stream failure, and graceful shutdown behavior.

## Product Boundary Guidelines

- Treat HTTP/2 multiplexing, request routing, and HTTP/3 behavior as explicit track work, not scaffold defaults.
- Treat HTTP/3 as a future or platform-dependent transport, not a blocker for the core product.
- Keep TypeScript/Node.js as the initial implementation focus.
- Keep `@signicode/verser-common` as the home for reused TypeScript foundations before adding duplicate package-local solutions.
- Document non-TypeScript guests as roadmap items until the core Host/Guest model is proven.
- Avoid positioning `verser2` as a full public HTTP gateway; it is a reverse connectivity and routing layer for connected processes.

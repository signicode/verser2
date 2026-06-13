# packages/verser2-guest-python/src/

## Responsibility

Holds the Python package source tree for `verser2_guest_python`, exposed through
the package's `pyproject.toml` and npm workspace bridge.

## Design

- **Python package namespace:** implementation code lives in
  `verser2_guest_python/`.
- **Public entrypoint:** `__init__.py` re-exports the public Guest/Broker factory
  functions and classes.
- **Protocol mirror:** Python source mirrors the TypeScript envelope and header
  semantics needed for cross-language Host interoperability.

## Flow

Importers load `verser2_guest_python`; the package exports factories that create
async Guest/Broker instances; those instances manage TLS HTTP/2 sessions and
translate routed requests to ASGI or Broker response APIs.

## Integration

- Built/tested through the package's npm scripts, which delegate to `uv`.
- Integrated with Node Host tests through Python integration test harnesses.

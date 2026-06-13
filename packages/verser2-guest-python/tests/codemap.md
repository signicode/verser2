# packages/verser2-guest-python/tests/

## Responsibility

Provides Python-focused unit tests for ASGI dispatch, envelope protocol helpers,
Guest lifecycle behavior, Broker route/request APIs, TLS trust, and mTLS client
identity handling.

## Design

- Uses Python async tests and fake stream/transport objects where possible.
- Keeps cross-language integration in root Node tests while validating Python
  internals close to the package source.
- Exercises one-shot response body readers, route replacement, and EOF handling
  to avoid non-terminating async stream behavior.

## Flow

Tests instantiate Python Guest/Broker objects, feed synthetic protocol frames or
fake readers/writers, assert route/request/response outcomes, and validate TLS
configuration paths.

## Integration

- Run through the package npm scripts using `uv run --project .`.
- Complements root `test/python-*.test.js` integration tests.

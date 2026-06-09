# @signicode/verser2-guest-python

Python ASGI Guest package for Verser2.

This package is scaffolded for the Python Guest implementation track. It is
recognized by the repository's npm workspace tooling through `package.json` and
by Python packaging tooling through `pyproject.toml`.

The Phase 1 scaffold intentionally does not yet connect to a Verser2 Host. Later
track phases add outbound TLS HTTP/2 registration, leased request dispatch, ASGI
scope/receive/send handling, and streaming behavior.

## Commands

```sh
npm run build --workspace=@signicode/verser2-guest-python
npm run test --workspace=@signicode/verser2-guest-python
npm run lint --workspace=@signicode/verser2-guest-python
```

## Scope

- Guest behavior connects outbound to an existing Verser2 Host.
- The local application interface targets ASGI 3: `app(scope, receive, send)`.
- Python Host, full Python Broker, HTTP/3, authentication, authorization, and
  public gateway policy are out of scope for this package scaffold.

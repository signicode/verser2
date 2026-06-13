# @signicode/verser2-guest-js-common

Shared JavaScript foundations for verser2 Guest adapters. This package provides
runtime-neutral helpers and the abstract dispatcher base class used by Node and
Bun Guest implementations.

## Public API

- `AbstractVerserFetchDispatcher` — abstract base class for fetch/dispatch
  adapters (intended for subclasses, not direct app-level dispatch)
- Header helpers, route helpers
- `appendQueryString`
- `createCommonBrokerRequest`
- Route, Broker, header, and stream chunk types
- Constant: `VERSER2_GUEST_JS_COMMON_PACKAGE_NAME`

## Usage

This package is a shared foundation consumed by `@signicode/verser2-guest-node`
and `@signicode/verser2-guest-bun`. Most applications interact with verser
through those higher-level packages rather than directly with
verser2-guest-js-common.

```ts
import { VERSER2_GUEST_JS_COMMON_PACKAGE_NAME, appendQueryString } from '@signicode/verser2-guest-js-common';
```

## Caveats

- `AbstractVerserFetchDispatcher` is designed for subclassing by adapter
  packages, not for direct use by applications.
- This package does not include transport or connection logic — it provides the
  shared JavaScript layer that adapter packages build on.

## Links

- [Root README](../../README.md)
- [Docs: Exposing HTTP](../../docs/exposing-http.md)
- [Docs: Making requests](../../docs/making-requests.md)

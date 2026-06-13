# @signicode/verser2-host

Host package for verser2. The Host listens for outbound Peer (Guest and Broker)
connections over TLS HTTP/2 and routes requests to advertised Guest routes.

## Public API

- `createVerserHost(options?: VerserHostOptions): VerserHost`
- Types: `VerserHost`, `VerserHostLifecycleEvent`, `VerserHostOptions`,
  `VerserHostRegistrationRequest`
- Re-exported: `VerserPeerRole`
- Constant: `VERSER2_HOST_PACKAGE_NAME`

## Basic usage

```ts
import fs from 'node:fs';
import { createVerserHost } from '@signicode/verser2-host';

const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
  },
});

await host.start();
```

## Caveats

- Host uses Node TLS HTTP/2 and requires TLS options.
- Defaults to `127.0.0.1` and port `0` (ephemeral).
- `host.address` throws before the Host starts listening.
- Server certificate material can be reloaded while running via
  `host.reloadTlsCertificate()`.
- Registration authorization is a registration-time mTLS/client-certificate hook
  only — it is not complete application authentication/authorization, and
  per-request Broker target authorization is not implemented.

## Links

- [Root README](../../README.md)
- [Docs: Connecting](../../docs/connecting.md)
- [Docs: Certificates](../../docs/certificates.md)
- [Docs: Authorization](../../docs/authorization.md)

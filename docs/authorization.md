# Authorization

Verser2 provides registration-time and upstream federation authorization hooks
based on mTLS client certificates. These are transport-level checks — verser2 is
not a complete public gateway. Applications remain responsible for
authentication, authorization, and routing policy beyond these checks.

## Registration authorization callback

The Host can provide an `authorizeRegistration` callback under
`tls.clientAuth`. It is called for each incoming Peer registration with the
peer's identity, role, requested routed domains, and certificate metadata:

```ts
const allowedBrokerFingerprint = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
    clientAuth: {
      caFile: '/etc/verser/client-ca.crt',
      authorizeRegistration(context) {
        // context.role: 'guest' | 'broker'
        // context.routedDomains: string[]
        // context.certificate?.commonName: string | undefined
        // context.certificate?.fingerprint256: SHA-256 fingerprint | undefined

        if (context.role === 'guest' && context.routedDomains.includes('internal.example.com')) {
          return { action: 'allow' };
        }
        if (context.role === 'broker' && context.certificate?.fingerprint256 === allowedBrokerFingerprint) {
          return { action: 'allow' };
        }
        return { action: 'close', reason: 'certificate identity is not authorized' };
      },
    },
  },
});
```

The callback returns an `action` of `'allow'` to accept the registration or
`'close'` to reject it with an optional reason string.

## Local peer authorization

Local Guests and Brokers attached through `host.attachLocalGuest()` or
`host.attachLocalBroker()` also invoke `authorizeRegistration` when it is
configured. Local peers do not have a TLS client certificate, so the Host calls
the callback with `certificate: undefined` and Host-owned metadata:

```ts
authorizeRegistration(context) {
  if (context.metadata.local === true && context.metadata.authorized === true) {
    return { action: 'allow' };
  }
  return { action: 'close', reason: 'not authorized' };
}
```

Caller-supplied `certificate` or `metadata` values in local attachment options
are not trusted or forwarded; the Host replaces them with `{ local: true,
authorized: true }`. Applications that rely on mTLS certificate identity should
treat local peers as a separate trusted in-process path.

## Federation authorization callback

The Host can also provide an `authorizeFederation` callback under
`tls.clientAuth`. It is called when another Host opens an upstream federation
link and sends its Host federation handshake:

```ts
const host = createVerserHost({
  hostId: 'host-manager',
  tls: {
    certFile: '/etc/verser/manager.crt',
    keyFile: '/etc/verser/manager.key',
    clientAuth: {
      caFile: '/etc/verser/host-client-ca.crt',
      authorizeFederation(context) {
        // context.hostId: declared upstream Host ID
        // context.handshake.hostId: Host ID from the versioned handshake
        // context.metadata.authorized: Node TLS authorization state
        // context.certificate?.fingerprint256: client certificate fingerprint
        if (context.hostId === 'host-runner-a' && context.metadata.authorized === true) {
          return { action: 'allow' };
        }
        return { action: 'close', reason: 'upstream Host is not authorized' };
      },
    },
  },
});
```

The callback returns `{ action: 'allow' }` to accept the Host link or
`{ action: 'close', reason }` to reject it. mTLS trust is transport evidence;
the application callback still decides whether the declared Host identity and
certificate context are allowed.

## Federated route authorization callback

A Host with federation can also configure a top-level `routeAuthorizer`
callback. It is hop-local only: the Host calls it with the already-resolved
normalized pair `{ previousAdvertisedDomain, nextSelectedDomain }` — the
immediate previous advertised domain toward the concrete next selected domain —
after candidate resolution and before any federation stream acquisition,
envelope/frame write, body piping, VWS open forwarding, or bridging. It is not
end-to-end Broker-to-Guest policy.

```ts
const host = createVerserHost({
  hostId: 'host-manager',
  routeAuthorizer: async (context) => {
    if (context.previousAdvertisedDomain === 'broker.corp.example') {
      // Cache this allow for 5 minutes instead of the Host default.
      return { decision: 'allow', cacheTtlMs: 5 * 60_000 };
    }
    // Legacy string result: use the configured Host cache TTLs.
    return 'deny';
  },
});
```

Results are cached per normalized pair with single-flight sharing and can be
revoked explicitly via `host.revokeRouteAuthorization(pair)` or are
invalidated by route/import/link mutations and Host shutdown. An authorized
logical federation request stream or accepted federated VWS connection keeps
its decision for its lifetime; cache changes gate only new forwarding/open
decisions, and physical HTTP/2 sessions are never route-bound.

### Per-decision cache TTLs

The positive (allow) and negative (deny) cache TTLs default to `60000` ms and
`Math.floor(allow / 10)` ms (`6000` ms) and are configured via the finite
Host options `routeAuthorizationCacheTtlMs` and
`routeAuthorizationNegativeCacheTtlMs` (`0` disables a class; entries expire
lazily without timers). A callback result may override the class TTL for that
single result via the object form `{ decision, cacheTtlMs? }`:

- omitted or `undefined` — the existing finite Host class TTL for the decision;
- `0` — disables caching for this result only;
- a positive safe integer whose computed `Date.now() + ttl` expiry is itself a
  safe integer — overrides the class TTL (a sum beyond the safe-integer range,
  e.g. `Number.MAX_SAFE_INTEGER`, is rejected without caching);
- `Number.POSITIVE_INFINITY` — caches until explicit revoke or lifecycle
  invalidation.

`Infinity` is a callback-only override: the Host TTL options remain finite and
reject it. Malformed or missing decisions and invalid TTLs (null, non-numbers,
NaN, negative or fractional values, unsafe integers, negative infinity) fail
deterministically without caching, as do callback errors. Revoke and
lifecycle invalidation clear finite and infinite entries and abandon pending
decisions; a stale pending result can neither take effect nor repopulate
either cache.

## Unauthorized client handler

`tls.clientAuth.unauthorizedClientHandler` is an opt-in callback for the first
request on a TLS session whose client certificate is missing or not valid for
the configured client trust. Without the handler, strict mTLS is unchanged:
the TLS handshake rejects such clients. With the handler configured, the Host
requests a client certificate but allows the session to complete, then gates
the Verser protocol instead of rejecting at the transport.

This is a protocol gate, not transport-level strict mTLS:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
    clientAuth: {
      caFile: '/etc/verser/client-ca.crt',
      unauthorizedClientHandler(context) {
        // context.method, context.path, context.headers (pseudo-headers removed),
        // context.body (Buffer), context.signal (AbortSignal)
        return { statusCode: 200, body: 'ok' };
      },
    },
  },
});
```

Contract:

- The callback is invoked at most once per session with a bounded, buffered
  request context. Raw HTTP/2 stream or session objects are not exposed.
- The result is declarative only: `{ statusCode, headers?, body? }`. Returning
  `undefined` closes the session without a response. No result can authorize,
  register, or otherwise promote the session to Verser protocol access.
- A first request to a reserved Verser path (`/verser` or `/verser/*`) is
  silently refused and the session closes without invoking the callback or any
  Verser protocol handler.
- Concurrent and subsequent streams on the session are refused; the callback
  is never invoked more than once.
- The session is closed after the one request. A client that later presents a
  valid certificate must reconnect with a new TLS session.
- Oversize, incomplete, timed-out, invalid, or throwing cases receive a
  bounded HTTP error (413, 400, 408, or 500) where possible, then the session
  closes.
- Enabling the handler requires `ca` or `caFile`; Host configuration fails
  without client trust material.
- Sessions served only by this handler are not registered peers: they never
  reach `authorizeRegistration`, `authorizeFederation`, normal route handling,
  or Host lifecycle events.

Defaults: request and response bodies 64 KiB
(`unauthorizedClientMaxRequestBodyBytes`,
`unauthorizedClientMaxResponseBodyBytes`), request and handler deadlines
5000 ms (`unauthorizedClientRequestTimeoutMs`,
`unauthorizedClientHandlerTimeoutMs`).

## Certificate identity and fingerprints

When mTLS is enabled, the Host extracts structured certificate identity metadata
for the registration callback. Depending on the presented certificate, this can
include the common name, DNS and URI subject alternative names, human-readable
subject and issuer strings, validity timestamps, custom extensions, raw DER
bytes encoded as Base64, and SHA fingerprints such as `fingerprint256`.

Prefer stable certificate fingerprints for allowlists when possible:

```ts
const allowedBrokerFingerprints = new Set([
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
]);

authorizeRegistration(context) {
  if (context.role === 'broker' && context.certificate?.fingerprint256) {
    return allowedBrokerFingerprints.has(context.certificate.fingerprint256)
      ? { action: 'allow' }
      : { action: 'close', reason: 'broker certificate is not allowed' };
  }
  return { action: 'close', reason: 'client certificate is required' };
}
```

Common names are useful for diagnostics and development certificates, but they
are not unique by themselves. Fingerprints identify the exact certificate
presented during the TLS handshake.

## What is not implemented

- **Per-request Broker target authorization** — the Host does not check whether
  a Broker is authorized to send requests to a specific Guest or route. The
  hop-local `routeAuthorizer` gates federation forwarding decisions only; it is
  not end-to-end Broker-to-Guest policy.
- **Complete application authentication** — mTLS authenticates the transport
  and supports registration policy, but verser2 is not a complete public
  gateway.
- **Credential-based auth** — there is no built-in token, password, or session
  authentication for requests or registrations beyond the mTLS certificate
  check.
- **Unauthorized-client admission** — `unauthorizedClientHandler` can only
  produce one bounded HTTP response for a client without a valid certificate;
  it cannot authorize the session for the Verser protocol. It is not
  application protocol validation, rate limiting, certificate issuance, or CSR
  processing.

Applications that need request-level or route-level authorization should
implement it at the application layer, for example by validating tokens in
Guest request handlers or by wrapping the Broker request path.

## TLS and authorization boundaries

| Layer           | What it provides                                       |
|-----------------|--------------------------------------------------------|
| TLS handshake   | Encrypted transport, optional mTLS client verification |
| Registration    | Certificate-based `authorizeRegistration` hook         |
| Federation handshake | Certificate-based `authorizeFederation` hook for Host links |
| Unauthorized client | One bounded handler response for a non-reserved first request; the Verser protocol is gated |
| Local peer attach | In-process registration hook with Host-owned metadata |
| Request routing | No per-request authorization                           |
| Guest handler   | Application-controlled (token validation, etc.)        |

## Route authority and trusted proxies

The Host authorizes routing using the exact `(targetId, routeDomain)` pair. It
rewrites the Guest-facing `Host` to the authorized advertised route. When the
caller supplied a distinct original authority, the Host sets
`X-Forwarded-Host` to that authority; caller-supplied `X-Forwarded-Host` is
never trusted. `X-Forwarded-For` and `Forwarded` remain application headers and
are not authorization inputs.

Only place a public trusted-proxy layer in front of a Host when that proxy is
authenticated and configured to set the original authority. Strip untrusted
forwarding headers at that boundary. If an application needs a stronger claim,
it may attach a signed Host/authority assertion and verify it itself; verser2
does not verify application-specific signatures, and such assertions do not
replace Host route authorization.

Python callers should use `route_domain=` when the URL authority is external or
when a Guest advertises multiple domains. The Python Broker sends the URL
authority as `Host`, including its port, and sends the selected advertised route
separately.

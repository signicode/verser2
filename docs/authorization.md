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
  a Broker is authorized to send requests to a specific Guest or route.
- **Complete application authentication** — mTLS authenticates the transport
  and supports registration policy, but verser2 is not a complete public
  gateway.
- **Credential-based auth** — there is no built-in token, password, or session
  authentication for requests or registrations beyond the mTLS certificate
  check.

Applications that need request-level or route-level authorization should
implement it at the application layer, for example by validating tokens in
Guest request handlers or by wrapping the Broker request path.

## TLS and authorization boundaries

| Layer           | What it provides                                       |
|-----------------|--------------------------------------------------------|
| TLS handshake   | Encrypted transport, optional mTLS client verification |
| Registration    | Certificate-based `authorizeRegistration` hook         |
| Federation handshake | Certificate-based `authorizeFederation` hook for Host links |
| Local peer attach | In-process registration hook with Host-owned metadata |
| Request routing | No per-request authorization                           |
| Guest handler   | Application-controlled (token validation, etc.)        |

# Certificates

TLS applies to the remote Host/Guest/Broker HTTP/2 transport only. Guest-attached
local handlers remain plain in-process handlers: Node HTTP handlers, Bun
Fetch-style handlers, and Python ASGI apps do not need HTTPS certificates or
listening ports for this routing path.

The Host certificate must be valid for the hostname or IP address used in
`hostUrl` because Guest and Broker clients perform normal TLS hostname
verification.

## Host TLS configuration

### Direct PEM values

```ts
import fs from 'node:fs';
import { createVerserHost } from '@signicode/verser2-host';

const host = createVerserHost({
  port: 8443,
  tls: {
    cert: fs.readFileSync('/etc/verser/host.crt', 'utf8'),
    key: fs.readFileSync('/etc/verser/host.key', 'utf8'),
    passphrase: process.env.VERSER_TLS_KEY_PASSPHRASE,
  },
});
```

### Certificate files

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
  },
});
```

When using `keyFile`, set the private key mode to `0600` on POSIX systems:

```sh
chmod 0600 /etc/verser/host.key
```

### PFX/PKCS12 identity

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    pfx: fs.readFileSync('/etc/verser/host.p12'),
    passphrase: process.env.VERSER_TLS_PFX_PASSPHRASE,
  },
});
```

Or with a file path:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    pfxFile: '/etc/verser/host.p12',
    passphrase: process.env.VERSER_TLS_PFX_PASSPHRASE,
  },
});
```

## Guest and Broker TLS trust

Configure trust with direct CA PEM values:

```ts
import { createVerserBroker, createVerserNodeGuest } from '@signicode/verser2-guest-node';

const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { ca: fs.readFileSync('/etc/verser/ca.crt', 'utf8') },
});

const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { ca },
});
```

Or with a CA file:

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: { caFile: '/etc/verser/ca.crt' },
});
```

Passing `ca` or `caFile` replaces Node's default CA set for that outbound HTTP/2
connection.

## Mutual TLS (mTLS)

To require Guest and Broker client certificates, configure the Host with trusted
client CA material under `tls.clientAuth`:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/verser/host.crt',
    keyFile: '/etc/verser/host.key',
    clientAuth: {
      caFile: '/etc/verser/client-ca.crt',
    },
  },
});
```

This enables `requestCert` and `rejectUnauthorized` on the Host TLS socket.

Node and Bun Guests, and Node/Bun Brokers, can present client identities as PEM
files:

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  tls: {
    caFile: '/etc/verser/host-ca.crt',
    certFile: '/etc/verser/client-a.crt',
    keyFile: '/etc/verser/client-a.key',
  },
});
```

Or as PFX/PKCS12:

```ts
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: {
    caFile: '/etc/verser/host-ca.crt',
    pfxFile: '/etc/verser/broker-a.p12',
    passphrase: process.env.VERSER_CLIENT_PFX_PASSPHRASE,
  },
});
```

### Python Guest and Broker TLS

The Python Guest and Broker support the same trust and client identity options
via file paths:

```py
guest = create_verser_guest(
    host_url="https://localhost:8443",
    guest_id="guest-a",
    app=app,
    routed_domains=["guest-a.local.test"],
    tls_ca_file="/etc/verser/ca.crt",
    tls_cert_file="/etc/verser/client.crt",
    tls_key_file="/etc/verser/client.key",
)

broker = create_verser_broker(
    host_url="https://localhost:8443",
    broker_id="broker-a",
    tls_ca_file="/etc/verser/ca.crt",
    tls_cert_file="/etc/verser/client.crt",
    tls_key_file="/etc/verser/client.key",
)
```

PFX/PKCS12 is also supported with `tls_pfx_file` and `tls_pfx_password`.

## Self-signed certificates

Generate a localhost certificate with SAN entries for `localhost` and `127.0.0.1`:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName = DNS:localhost,IP:127.0.0.1" \
  -keyout host.key \
  -out host.crt

chmod 0600 host.key
```

Use the generated certificate as Host TLS and as CA trust for Guests and Brokers:

```ts
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: './host.crt' },
});
```

## Encrypted private keys

Generate a password-protected key by omitting `-nodes` and providing `-passout`:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName = DNS:localhost,IP:127.0.0.1" \
  -passout pass:change-me \
  -keyout host.key \
  -out host.crt

chmod 0600 host.key
```

Pass the passphrase as `tls.passphrase`:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: './host.crt',
    keyFile: './host.key',
    passphrase: process.env.VERSER_TLS_KEY_PASSPHRASE,
  },
});
```

## PFX/PKCS12 creation

Export Host certificate and key into a `.p12` bundle:

```sh
openssl pkcs12 -export \
  -in host.crt \
  -inkey host.key \
  -out host.p12 \
  -passout pass:change-me
```

## Client CA creation

Create a client CA and sign a Guest client certificate for mTLS:

```sh
# Create client CA
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -subj "/CN=verser-client-ca" \
  -keyout client-ca.key \
  -out client-ca.crt

chmod 0600 client-ca.key

# Create and sign a Guest certificate
openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=guest-a" \
  -keyout guest-a.key \
  -out guest-a.csr \
  -addext "subjectAltName = DNS:guest-a,URI:urn:verser:client:guest-a" \
  -addext "extendedKeyUsage = clientAuth"

openssl x509 -req \
  -in guest-a.csr \
  -CA client-ca.crt \
  -CAkey client-ca.key \
  -CAcreateserial \
  -days 365 \
  -sha256 \
  -copy_extensions copy \
  -out guest-a.crt

chmod 0600 guest-a.key
```

## Certificate reload

After replacing certificate files, call the Host reload method. Reloaded
certificate material is used for new TLS handshakes; existing HTTP/2 sessions
keep their current TLS state.

```ts
await host.start();
host.reloadTlsCertificate();
```

Verser does not install signal handlers. Wire them at the application boundary
if needed:

```ts
process.on('SIGUSR1', () => {
  try {
    host.reloadTlsCertificate();
  } catch (error) {
    console.error('Failed to reload Verser TLS certificate:', error);
  }
});
```

**Note:** Changing `tls.clientAuth`, trusted client CA material, or whether the
Host requires client certificates changes mTLS mode and requires restarting the
Host. `reloadTlsCertificate()` is for Host server identity material, not for
changing client certificate policy on a running server.

## Let's Encrypt DNS-01

For public domains, use Certbot with a DNS challenge. This avoids exposing an
HTTP challenge endpoint.

```sh
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/certbot/cloudflare.ini \
  -d verser.example.com
```

Map the issued files to Host TLS:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/letsencrypt/live/verser.example.com/fullchain.pem',
    keyFile: '/etc/letsencrypt/live/verser.example.com/privkey.pem',
  },
});
```

Public Let's Encrypt certificates usually validate through Node.js default trust,
so Guests and Brokers normally do not need custom `ca` or `caFile` for those
hosts.

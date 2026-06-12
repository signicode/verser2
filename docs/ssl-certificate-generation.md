# SSL certificate generation

Verser Hosts need certificate material for the remote TLS HTTP/2 transport. Guest-attached local HTTP/1 handlers do not need HTTPS certificates.

## Local self-signed certificate

Generate a localhost certificate with SAN entries for `localhost` and `127.0.0.1`:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName = DNS:localhost,IP:127.0.0.1" \
  -keyout host.key \
  -out host.crt

chmod 0600 host.key
```

Verser enforces `0600` for `keyFile` on POSIX systems. Windows ACLs are not checked by this mode-bit validation.

Use it with file-based Host TLS:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: './host.crt',
    keyFile: './host.key',
  },
});
```

Guests and Brokers need the certificate as trust material when the certificate is self-signed:

```ts
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: { caFile: './host.crt' },
});
```

## PFX/PKCS12 Host identity

If your deployment stores TLS identity as PFX/PKCS12, export the Host certificate and key into a `.p12` bundle:

```sh
openssl pkcs12 -export \
  -in host.crt \
  -inkey host.key \
  -out host.p12 \
  -passout pass:change-me
```

Use it with Host TLS:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    pfxFile: './host.p12',
    passphrase: process.env.VERSER_TLS_PFX_PASSPHRASE,
  },
});
```

## Client CA and mTLS client certificates

To require Guest and Broker client certificates, create a client CA and sign client identities. This authenticates the remote TLS HTTP/2 transport; local Guest HTTP/1 handlers still do not need HTTPS certificates and still do not call `listen()`.

Create a client CA:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -subj "/CN=verser-client-ca" \
  -keyout client-ca.key \
  -out client-ca.crt

chmod 0600 client-ca.key
```

Create and sign a Guest client certificate:

```sh
openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=guest-a" \
  -keyout guest-a.key \
  -out guest-a.csr \
  -addext "subjectAltName = DNS:guest-a,URI:urn:verser:guest:guest-a" \
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

Configure the Host to trust the client CA and optionally authorize registration metadata:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: './host.crt',
    keyFile: './host.key',
    clientAuth: {
      caFile: './client-ca.crt',
      authorizeRegistration(context) {
        if (context.role === 'guest' && context.routedDomains.includes('guest-a.example.com')) {
          return { action: 'allow' };
        }
        return { action: 'close', reason: 'registration is not authorized' };
      },
    },
  },
});
```

Configure a Guest with PEM client identity material:

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'guest-a',
  routedDomains: ['guest-a.example.com'],
  tls: {
    caFile: './host.crt',
    certFile: './guest-a.crt',
    keyFile: './guest-a.key',
  },
});
```

Export the same client identity as PFX/PKCS12 when that is easier to distribute:

```sh
openssl pkcs12 -export \
  -in guest-a.crt \
  -inkey guest-a.key \
  -out guest-a.p12 \
  -passout pass:change-me
```

```ts
const broker = createVerserBroker({
  hostUrl: 'https://localhost:8443',
  brokerId: 'broker-a',
  tls: {
    caFile: './host.crt',
    pfxFile: './guest-a.p12',
    passphrase: process.env.VERSER_CLIENT_PFX_PASSPHRASE,
  },
});
```

Guest routed-domain authorization is callback-driven. Broker authorization is identity-only at registration time in this track; per-request Broker target authorization is out of scope. mTLS helps authenticate the remote transport, but applications remain responsible for complete public gateway authentication, authorization, and routing policy.

## Encrypted private key

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

Pass the same secret as `tls.passphrase`:

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

## Let's Encrypt DNS-01 with Cloudflare

For public domains, use Certbot's Cloudflare DNS plugin (`certbot-dns-cloudflare`). A DNS-01 challenge can issue certificates without exposing an HTTP challenge endpoint.

Create a Cloudflare credentials file:

```ini
dns_cloudflare_api_token = your-cloudflare-api-token
```

Restrict the credentials file:

```sh
chmod 600 ~/.secrets/certbot/cloudflare.ini
```

Request a certificate:

```sh
certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/certbot/cloudflare.ini \
  -d verser.example.com
```

Certbot stores renewal configuration and the credentials file path. Renewals use the same authenticator configuration:

```sh
certbot renew
```

Map the issued files to Verser Host TLS:

```ts
const host = createVerserHost({
  port: 8443,
  tls: {
    certFile: '/etc/letsencrypt/live/verser.example.com/fullchain.pem',
    keyFile: '/etc/letsencrypt/live/verser.example.com/privkey.pem',
  },
});
```

Public Let's Encrypt certificates usually validate through Node.js default trust, so Guests and Brokers normally do not need custom `ca` or `caFile` for those hosts.

## Reload after renewal

After replacing certificate files, call the Host reload method. Reloaded certificate material is used for new TLS handshakes; existing HTTP/2 sessions keep their current TLS state.

```ts
host.reloadTlsCertificate();
```

Verser does not install signal handlers. If your application wants signal-driven reloads, wire them at the application boundary:

```ts
process.on('SIGUSR1', () => {
  try {
    host.reloadTlsCertificate();
  } catch (error) {
    console.error('Failed to reload Verser TLS certificate:', error);
  }
});
```

Changing `tls.clientAuth`, trusted client CA material, or whether the Host requires client certificates changes mTLS mode and requires restarting the Host. `reloadTlsCertificate()` is for Host server identity material, not for changing client certificate policy on an already-running secure server.

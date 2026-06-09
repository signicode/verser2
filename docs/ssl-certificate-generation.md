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

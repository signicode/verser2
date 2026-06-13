# Making requests

A Broker sends requests to advertised Guest routes through the Host.

## Broker.request()

The Node and Bun Broker's `request()` method sends a single request:

```ts
const response = await broker.request({
  targetId: 'client-a',
  method: 'GET',
  path: '/health',
});

console.log(response.statusCode);
response.body.pipe(process.stdout);
```

Direct Node/Bun Broker request bodies can be omitted, provided as `Buffer`
chunks, or streamed with a Node `Readable`:

```ts
const uploadResponse = await broker.request({
  targetId: 'client-a',
  method: 'POST',
  path: '/upload',
  body: nodeReadableStream,
});

uploadResponse.body.pipe(destination);
```

## Agent

`createAgent()` returns a plain `http:` Agent that routes advertised hostnames
through the Broker without DNS resolution:

```ts
const agent = broker.createAgent();

http.get('http://client-a.local.test/health', { agent }, (response) => {
  response.pipe(process.stdout);
});
```

Non-advertised hostnames are rejected — there is no DNS fallback.

## Dispatcher (Undici)

`createDispatcher()` returns an Undici `Dispatcher` for use with `fetch`:

```ts
const dispatcher = broker.createDispatcher();

const response = await fetch('http://client-a.local.test/health', {
  dispatcher,
});
console.log(await response.text());
```

The Dispatcher rejects upgrade requests. It supports buffer, string, stream, and
iterable body forms.

## Fetch helper

`createFetch()` wraps a fetch function pre-wired to the Broker dispatcher:

```ts
const routedFetch = broker.createFetch();

const response = await routedFetch('http://client-a.local.test/health');
console.log(await response.text());
```

## Python Broker

The Python Broker routes by URL hostname and provides `request()` plus
convenience helpers:

```py
response = await broker.request("GET", "http://python-guest-a.local.test/health")
print(response.status)

# Convenience methods
response = await broker.get("http://python-guest-a.local.test/health")
response = await broker.post("http://python-guest-a.local.test/data", body=b'{"key": "value"}')
```

Response objects expose `status`, `headers`, `request_id`, and body reading
helpers:

```py
# Read the full body
body = await response.read()
text = await response.text()
data = await response.json()

# Iterate in chunks
async for chunk in response.aiter_bytes(8192):
    process(chunk)
```

Response bodies are one-shot — they can be read once.

## Multiplexed requests

Multiple requests can be active concurrently over a single Broker connection:

```ts
await Promise.all([
  broker.request({ targetId: 'client-a', method: 'GET', path: '/health' }),
  broker.request({ targetId: 'client-a', method: 'GET', path: '/metrics' }),
  broker.request({ targetId: 'client-a', method: 'POST', path: '/jobs', body: [Buffer.from('payload')] }),
]);
```

Each Broker-to-Host request uses a separate HTTP/2 stream. The Guest leg uses
an assigned one-use lease stream for raw body bytes while the control stream
remains available for coordination.

## Wait for route

Before sending requests, wait for the target route to be advertised:

```ts
await broker.waitForRoute('client-a.local.test');
```

This resolves when the Host sends a route-control frame that includes the
requested domain.

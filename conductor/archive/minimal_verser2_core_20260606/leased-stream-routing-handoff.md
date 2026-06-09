# Handoff: Leased HTTP/2 Streams for Routed Bodies

## Context

Phase 4 currently uses a Guest-opened control stream for routed request and response frames. That control path is useful for route advertisements and coordination, but carrying request or response bodies as NDJSON/base64 frames adds overhead and weakens per-request HTTP/2 backpressure.

This handoff captures the preferred follow-up design so it can be converted into a dedicated Conductor track after the current implementation track continues.

## Goal

Replace request/response body transfer over NDJSON/base64 control frames with raw octet body transfer over one-use leased HTTP/2 streams while preserving a small internal metadata envelope.

## Key Constraint

Node HTTP/2 does not let a server-side Host initiate normal request streams back to a client-initiated Guest session. Server push is not a substitute because it is not a request/response RPC path.

Therefore, Guests must pre-open streams that the Host can lease for later routed requests.

## Recommended Model

- Guest maintains a configurable pool of idle lease streams.
- Each lease stream is single-use for one routed request/response.
- `minWaitingStreams` controls how many idle streams should be ready.
- `maxOpenStreams` caps idle + active + opening streams per Guest.
- Host queues routed Broker requests when no lease is available, up to a timeout.
- Guest replenishes leases after a lease is assigned, closed, cancelled, or errors.

Suggested defaults for a future track:

```text
minWaitingStreams: 1-4
maxOpenStreams: 16-128
leaseAcquireTimeoutMs: configurable small timeout
maxMetadataBytes: 64 KiB or 256 KiB
```

## Stream Lifecycle

1. Guest registers normally.
2. Guest opens lease streams until pool constraints are satisfied:
   - `waiting + opening < minWaitingStreams`
   - `waiting + active + opening < maxOpenStreams`
3. Lease stream request:

   ```text
   POST /verser/guest/lease
   x-verser-peer-id: <guestId>
   x-verser-lease-id: <leaseId>
   ```

4. Host accepts and stores the stream as an idle lease.
5. Broker sends a routed request to Host on `/verser/request`.
6. Host assigns one idle lease.
7. Host writes a request metadata envelope to the lease, then pipes raw Broker request body bytes.
8. Guest parses the request metadata envelope and dispatches the raw body into the attached local HTTP handler.
9. Guest writes a response metadata envelope to the same lease, then pipes raw response body bytes.
10. Host parses response metadata, responds to the original Broker stream with real status/headers, then pipes raw response body bytes.
11. Lease closes and Guest replenishes as needed.

## Binary Envelope Shape

Use a small binary prefix before raw body bytes:

```text
byte 0      version, currently 1
byte 1      envelopeType: 1=request, 2=response, 3=error
bytes 2-5   uint32_be metadataLength
bytes 6..   UTF-8 JSON metadata
then        raw body bytes until stream EOF
```

Request metadata:

```ts
{
  requestId: string;
  sourceId: string;
  targetId: string;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  timeoutMs?: number;
}
```

Response metadata:

```ts
{
  requestId: string;
  statusCode: number;
  headers: Record<string, string | string[]>;
}
```

Error metadata, before response headers/body begin:

```ts
{
  requestId: string;
  code: string;
  message: string;
  context?: Record<string, string | number | boolean>;
}
```

## Why This Is Preferred

- Avoids base64 overhead.
- Preserves binary request and response bodies exactly.
- Lets HTTP/2 flow control and backpressure apply per routed request.
- Avoids a single shared control stream becoming an application-level bottleneck.
- Reduces latency when the idle lease pool is warm.

## Important Risks

- Idle leases consume HTTP/2 concurrent stream capacity.
- Bursts above `minWaitingStreams` may wait for Guest replenishment.
- Full-duplex and half-close behavior must be tested directly in Node HTTP/2.
- Cancellation must reset both the Broker stream and active lease.
- If Guest handler errors after response metadata/body has started, Host cannot cleanly convert that into a normal HTTP error response; it should reset/cancel the Broker stream and emit lifecycle/error information.
- Metadata must be validated before translating to HTTP/2 headers; do not forward invalid header names or HTTP/1 connection headers such as `connection`, `upgrade`, or `keep-alive`.

## Suggested Test Plan for Future Track

1. Prove Node HTTP/2 full-duplex lease behavior:
   - Guest opens a stream.
   - Host writes response-side request metadata/body before Guest request body ends.
   - Guest writes response metadata/body back.
2. Envelope parser tests:
   - partial prefix chunks,
   - partial metadata chunks,
   - body bytes in same chunk as metadata,
   - invalid version,
   - oversized metadata,
   - malformed JSON.
3. Lease pool tests:
   - maintains `minWaitingStreams`,
   - never exceeds `maxOpenStreams`,
   - replenishes after assignment/close/error,
   - queues and times out when no lease is available.
4. Routing tests:
   - Broker request body streams raw Host→Guest,
   - Guest response body streams raw Guest→Host→Broker,
   - binary payloads with null and non-UTF8 bytes round-trip unchanged.
5. Concurrency tests:
   - multiple Broker requests use separate leases,
   - responses can complete out of order,
   - max-open limits active concurrency.
6. Cancellation/error tests:
   - Broker abort cancels Guest lease,
   - Guest handler failure before headers maps to an actionable error,
   - Guest disconnect fails active and queued requests,
   - timeout cancels both legs.
7. Backpressure tests:
   - slow Broker response consumer throttles Guest response production,
   - slow Guest request consumer throttles Broker upload.

## Migration Plan

1. Add shared binary envelope encode/decode helpers, likely in `@signicode/verser-common`.
2. Add `/verser/guest/lease` alongside current registration/control routes.
3. Keep route advertisements and registration as-is initially.
4. Route Broker requests through leased streams behind a protocol version or internal feature flag.
5. Preserve existing buffer-returning `broker.request()` API while the transport becomes streaming internally.
6. Add a streaming response shape for future `http.Agent` integration.
7. Remove request/response `bodyBase64` NDJSON routing frames once lease tests pass.
8. Keep NDJSON route advertisements unless a later track replaces them.

## Decision Summary

Adopt one routed request per leased HTTP/2 stream in a future track. Use NDJSON/control frames only for coordination such as route advertisements and lease demand, not for request or response bodies.

# Specification: Leased HTTP/2 Streams for Routed Bodies

## Overview

Replace the current MVP routed request/response body transfer over Guest control-stream NDJSON/base64 frames with raw octet transfer over one-use leased HTTP/2 streams.

The existing control stream remains available for coordination such as route advertisements and lease management. Routed request and response bodies must no longer be carried as NDJSON/base64 frames once this track is complete.

This track implements the follow-up design captured in `conductor/tracks/minimal_verser2_core_20260606/leased-stream-routing-handoff.md`.

## Functional Requirements

### Lease Stream Model

- The Node Guest must maintain a configurable pool of idle lease streams to the Host.
- Each lease stream is single-use for exactly one routed request/response exchange.
- The Guest must expose lease pool configuration options, including:
  - `minWaitingStreams`
  - `maxOpenStreams`
  - `leaseAcquireTimeoutMs`
  - `maxMetadataBytes` or equivalent validation limit
- The Guest must replenish leases after assignment, close, cancellation, error, or disconnect while connected.
- The Host must store idle Guest-opened lease streams and assign them to Broker routed requests.
- The Host must queue routed Broker requests when no lease is available, up to the configured lease acquire timeout.
- The Host must fail queued requests with actionable contextual errors when no lease becomes available before timeout.

### Binary Envelope

- Add shared binary envelope encode/decode helpers in `@signicode/verser-common`.
- The envelope format must use:
  - byte 0: version, currently `1`
  - byte 1: envelope type: request, response, or error
  - bytes 2-5: unsigned big-endian metadata length
  - bytes 6..: UTF-8 JSON metadata
  - remaining stream bytes: raw request or response body
- Envelope parsing must support chunk boundaries across prefix, metadata, and body bytes.
- Envelope parsing must reject invalid versions, unknown envelope types, oversized metadata, and malformed JSON with contextual errors.
- Metadata must be validated before translating to HTTP headers.
- Invalid header names and HTTP/1 connection headers such as `connection`, `upgrade`, and `keep-alive` must not be forwarded.

### Routed Request Flow

- Broker routed requests must use the existing Broker-to-Host HTTP/2 request stream.
- Host must acquire an idle lease for the target Guest.
- Host must write request metadata to the lease, then pipe raw Broker request body bytes to the Guest.
- Guest must parse request metadata and dispatch the raw request body into the attached local HTTP handler.
- Guest must write response metadata to the same lease, then pipe raw response body bytes back to the Host.
- Host must parse response metadata, respond to the original Broker stream with status and headers, then pipe raw response body bytes back to the Broker.
- Multiple Broker requests must use separate active leases and may complete out of order.

### Migration From NDJSON Body Frames

- Remove routed request/response `bodyBase64` NDJSON body transfer after leased-stream routing tests pass.
- Keep route advertisements and other coordination messages on the existing control path unless this track explicitly requires a minimal lease coordination message.
- Preserve the existing buffer-returning `broker.request()` API while the internal transport becomes streaming.
- Preserve the minimal plain `node:http` Agent route for Host-advertised domains, updating it to use leased stream routing underneath.

### Cancellation, Failure, and Lifecycle Behavior

- Broker aborts must cancel the active Guest lease and fail the routed request cleanly.
- Guest disconnects must fail active and queued requests for that Guest.
- Lease acquisition timeouts must fail the original Broker request with contextual diagnostics.
- Guest handler failure before response metadata must map to an actionable routed error response where possible.
- Guest handler failure after response metadata/body has started must reset/cancel the Broker stream and emit lifecycle/error information rather than pretending to send a normal HTTP error response.
- Lease stream errors and resets must remove the lease from the pool and trigger replenishment while the Guest remains connected.

## Non-Functional Requirements

- Preserve HTTP method, path, headers, request body, status, response headers, and response body semantics for the routed paths covered by this track.
- Preserve binary request and response bodies exactly, including null bytes and non-UTF-8 data.
- Use HTTP/2 flow control and backpressure per routed request rather than buffering all bodies in control frames.
- Maintain at least 95% meaningful coverage for changed behavior.
- Keep reusable envelope, metadata, validation, and protocol-neutral helpers in `@signicode/verser-common`.
- Continue using npm, TypeScript strict CommonJS ES2019, Node `node:test`, and Biome.

## Acceptance Criteria

- Shared envelope helpers encode and decode request, response, and error envelopes and pass partial chunk, invalid version, oversized metadata, and malformed JSON tests.
- Guest lease pool maintains `minWaitingStreams`, respects `maxOpenStreams`, replenishes after assignment/close/error, and supports lease acquisition timeout behavior.
- Broker-to-Guest routed request bodies stream as raw bytes over leased HTTP/2 streams without base64 body frames.
- Guest-to-Broker response bodies stream as raw bytes over leased HTTP/2 streams without base64 body frames.
- Binary payloads with null and non-UTF-8 bytes round-trip unchanged.
- Concurrent routed requests use distinct leases and can complete out of order.
- Slow Broker response consumers apply backpressure to Guest response production, and slow Guest request consumers apply backpressure to Broker uploads.
- Broker abort, Guest disconnect, lease timeout, and lease stream error paths are covered by tests and produce actionable errors or lifecycle events.
- Existing route advertisement behavior remains functional.
- Existing `broker.request()` and plain `node:http` Agent MVP tests continue to pass using leased routing internally.
- Routed request/response body transfer over NDJSON `bodyBase64` frames is removed.
- Full validation passes with `npm run build`, `npm test`, `npm run lint`, and coverage measurement.

## Out of Scope

- HTTP/3 or QUIC transport.
- Non-Node Guest implementations.
- Public gateway behavior.
- Authentication, authorization, or routing policy features.
- Replacing route advertisements with a new binary control protocol.
- Full public streaming API redesign beyond what is required for internal leased routing and existing Broker/Agent compatibility.

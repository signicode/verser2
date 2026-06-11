# Specification: Address GitHub Issues from 2026-06-11

## Overview

Address the open GitHub issues created on 2026-06-11 for `verser2` hardening and cleanup:

- #9 `fix(guest-node): apply backpressure and bounds in Broker Agent request ingestion`
- #10 `fix(guest): bound buffered direct-dispatch response bodies`
- #11 `fix(common): bound envelope parser buffers`
- #12 `fix(python-guest): defer HTTP/2 body ACKs until ASGI receive consumes data`
- #13 `refactor(python-guest): remove unused full-body request reader`

The track should preserve Verser2 HTTP semantics while reducing unbounded memory growth risks and aligning backpressure with actual request-body consumption. The work must follow the repository's TDD workflow, prefer reusable common code where appropriate, and keep Host/Guest/Broker terminology precise.

## Functional Requirements

### GitHub Issue #11: Common Envelope Parser Bounds

- Update `@signicode/verser-common` envelope parsing so `createVerserEnvelopeParser(...)` enforces an explicit maximum pending buffer size.
- The parser must reject pending input that exceeds `VERSER_ENVELOPE_PREFIX_BYTES + maxMetadataBytes` before a complete envelope can be parsed.
- Oversized pending parser input must fail consistently with existing protocol-error behavior for oversized metadata.
- Valid split-envelope parsing must remain compatible.

### GitHub Issue #9: Node Guest Broker Agent Request Ingestion

- Update `VerserBrokerSocket` request-upload handling so write callbacks are deferred until downstream request-body consumers accept data.
- Preserve backpressure for both non-chunked and chunked request uploads, including handling `write(...) === false` and waiting for `drain` before accepting more body bytes.
- Add bounded request-header parsing using a configurable default such as `maxRequestHeaderBytes`.
- Add bounded chunk-size-line and pending-buffer checks in `ChunkedBodyDecoder` using configurable defaults where appropriate.
- Oversized, malformed, or unterminated request headers and chunk lines must fail without unbounded memory growth.
- Existing valid chunked and non-chunked routing behavior must remain compatible.

### GitHub Issue #10: Direct Dispatch Buffered Response Bounds

- Document direct/non-lease dispatch helpers as batch-only, non-streaming paths.
- Add configurable maximum buffered response size controls for direct Node dispatch and direct Python ASGI dispatch, using safe defaults.
- Enforce response-size limits while chunks are written or appended, before full concatenation.
- Preserve leased streaming response behavior unchanged.

### GitHub Issue #12: Python Guest HTTP/2 Request-Body ACK Backpressure

- Update the Python Guest so HTTP/2 request-body `WINDOW_UPDATE` credit is sent only after the ASGI application consumes the corresponding `http.request` body event via `receive()`.
- Stop acknowledging request-body `DataReceived` frames immediately in the HTTP/2 read loop.
- Preserve `event.flow_controlled_length` alongside queued body events and use that value for flow-control accounting.
- Slow ASGI request-body consumers must throttle inbound HTTP/2 request-body data.
- Existing leased request/response streaming semantics must remain compatible.

### GitHub Issue #13: Python Guest Dead-Code Cleanup

- Remove the unused `_read_request_envelope_and_body(...)` helper from the Python Guest.
- Do not replace it with another full-body request reader unless a future API explicitly requires bounded batch behavior.
- Ensure active streaming request handling remains unchanged except for the intentional flow-control changes in #12.

## Non-Functional Requirements

- Follow the Conductor workflow: write failing tests first, implement the smallest passing change, refactor after tests pass, and update `plan.md` as the source of truth.
- Maintain at least 95% meaningful coverage for changed behavior or document why coverage could not be measured.
- Use npm for repository commands and `uv` only for Python package-specific commands when needed.
- Preserve method, path, headers, body, status, response, streaming, lifecycle, and protocol semantics unless explicitly changed by these issues.
- Prefer `@signicode/verser-common` for reusable protocol-neutral limits or error helpers before adding duplicated package-local solutions.
- Avoid adding HTTP/3 or unrelated public gateway behavior.

## Implementation Organization

- Use one implementation phase per issue, ordered by affected package to simplify focused validation:
  1. Common package issue #11.
  2. Node Guest package issue #9.
  3. Cross-runtime direct dispatch issue #10, covering Node then Python.
  4. Python Guest issue #12.
  5. Python Guest issue #13.
- Manual verification/checkpointing should occur only after all issues for a specific package or package group are completed, not after every individual issue.

## Acceptance Criteria

- Issue #11: exported envelope parser cannot retain more than the maximum valid envelope size; oversized pending input fails with a protocol error; valid split-envelope parsing still works.
- Issue #9: slow Guest request-body consumption applies backpressure to Agent-originated uploads; non-chunked and chunked uploads respect downstream `drain`; oversized headers and malformed/oversized/incomplete chunk lines fail safely.
- Issue #10: direct Node and Python dispatch reject responses over configured/default buffered response limits; documentation distinguishes batch direct dispatch from leased streaming dispatch; leased response streaming remains streaming.
- Issue #12: Python Guest sends request-body `WINDOW_UPDATE` credit only after ASGI `receive()` consumes the body event; delayed ASGI consumers are covered by tests.
- Issue #13: unused Python full-body request reader is removed; Python Guest tests still pass; no active streaming request path regresses.
- Relevant focused tests, builds, linting, and package validations pass according to the workflow.

## Out of Scope

- Implementing HTTP/3 or new transport protocols.
- Changing authentication, authorization, or public gateway policy.
- Replacing leased streaming paths with batch buffering.
- Adding support for new guest runtimes beyond the current packages.
- Closing or editing GitHub issues automatically unless explicitly requested later.

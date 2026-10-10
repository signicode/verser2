import asyncio
import builtins
import json
import struct
import unittest
from io import BytesIO
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import h2.events

from verser2_guest_python import guest as guest_module
from verser2_guest_python import create_verser_guest
from verser2_guest_python.protocol import (
    decode_envelope,
    encode_envelope,
    normalize_headers,
    sanitize_http2_response_headers,
)


class FakeReader:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def read(self, _size):
        if self._chunks:
            return self._chunks.pop(0)
        return b""


class FakeConn:
    def __init__(self, events=None, window=65535):
        self.events = list(events or [])
        self.acknowledged = []
        self.sent_data = []
        self.sent_headers = []
        self.reset_streams = []
        self.window = window
        self._next_stream_id = 3

    def receive_data(self, _data):
        return list(self.events)

    def acknowledge_received_data(self, flow_controlled_length, stream_id):
        self.acknowledged.append((stream_id, flow_controlled_length))

    def send_data(self, stream_id, data, end_stream=False):
        self.sent_data.append((stream_id, data, end_stream))

    def send_headers(self, stream_id, headers, end_stream=False):
        self.sent_headers.append((stream_id, headers, end_stream))

    def get_next_available_stream_id(self):
        stream_id = self._next_stream_id
        self._next_stream_id += 2
        return stream_id

    def reset_stream(self, stream_id):
        self.reset_streams.append(stream_id)

    def data_to_send(self):
        return b""

    def local_flow_control_window(self, _stream_id):
        return self.window


class FakeWriter:
    def write(self, _data):
        pass

    async def drain(self):
        pass


class FeedReader:
    def __init__(self):
        self._chunks = asyncio.Queue()

    async def read(self, _size):
        return await self._chunks.get()

    def feed(self):
        self._chunks.put_nowait(b"event")


class EventBatchConn(FakeConn):
    def __init__(self, window=65535):
        super().__init__(window=window)
        self._event_batches = []

    def receive_data(self, _data):
        return self._event_batches.pop(0)

    def feed_events(self, *events):
        self._event_batches.append(list(events))


class ObservableWindowConn(EventBatchConn):
    def __init__(self, window=0, expected_waiters=1):
        super().__init__(window=window)
        self.expected_waiters = expected_waiters
        self.waiter_checks = 0
        self.waiters_blocked = asyncio.Event()

    def local_flow_control_window(self, _stream_id):
        self.waiter_checks += 1
        if self.waiter_checks >= self.expected_waiters:
            self.waiters_blocked.set()
        return self.window


class AsgiDispatchTest(unittest.TestCase):
    def test_dispatch_routed_request_builds_http_scope_and_returns_response(
        self,
    ) -> None:
        recorded = {}

        async def app(scope, receive, send):
            recorded["scope"] = scope
            recorded["request"] = await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 201,
                    "headers": [(b"x-guest", b"python")],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b"POST /hello payload",
                    "more_body": False,
                }
            )

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-unit-guest",
            app=app,
            routed_domains=["python-unit.local.test"],
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-1",
                    "sourceId": "broker-unit",
                    "targetId": "python-unit-guest",
                    "method": "POST",
                    "path": "/hello?name=verser",
                    "headers": {"x-input": "abc"},
                },
                b"payload",
            )
        )

        self.assertEqual(recorded["scope"]["type"], "http")
        self.assertEqual(recorded["scope"]["method"], "POST")
        self.assertEqual(recorded["scope"]["path"], "/hello")
        self.assertEqual(recorded["scope"]["query_string"], b"name=verser")
        self.assertIn((b"x-input", b"abc"), recorded["scope"]["headers"])
        self.assertEqual(
            recorded["request"],
            {"type": "http.request", "body": b"payload", "more_body": False},
        )
        self.assertEqual(response.request_id, "req-python-1")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers, {"x-guest": "python"})
        self.assertEqual(response.body, b"POST /hello payload")

    def test_app_exception_before_response_start_returns_local_handler_failure(
        self,
    ) -> None:
        async def app(scope, receive, send):
            raise RuntimeError("asgi exploded")

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-error-guest",
            app=app,
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-error",
                    "sourceId": "broker-unit",
                    "targetId": "python-error-guest",
                    "method": "GET",
                    "path": "/explode",
                    "headers": {},
                },
                b"",
            )
        )

        self.assertEqual(response.error["code"], "local-handler-failure")
        self.assertIn("asgi exploded", response.error["message"])
        self.assertEqual(response.error["context"]["guestId"], "python-error-guest")
        self.assertEqual(response.error["context"]["requestId"], "req-python-error")
        self.assertEqual(response.error["context"]["path"], "/explode")

    def test_dispatch_routed_request_streams_request_chunks_to_receive(self) -> None:
        received = []

        async def app(scope, receive, send):
            while True:
                event = await receive()
                received.append(event)
                if not event.get("more_body", False):
                    break
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-stream-request",
            app=app,
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-stream-request",
                    "sourceId": "broker-unit",
                    "targetId": "python-stream-request",
                    "method": "POST",
                    "path": "/stream",
                    "headers": {},
                },
                [b"one", b"two"],
            )
        )

        self.assertEqual(
            received,
            [
                {"type": "http.request", "body": b"one", "more_body": True},
                {"type": "http.request", "body": b"two", "more_body": False},
            ],
        )
        self.assertEqual(response.body, b"ok")

    def test_dispatch_routed_request_collects_streamed_response_body_chunks(
        self,
    ) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 202,
                    "headers": [(b"x-stream", b"yes")],
                }
            )
            await send(
                {"type": "http.response.body", "body": b"one-", "more_body": True}
            )
            await send(
                {"type": "http.response.body", "body": b"two", "more_body": False}
            )

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-stream-response",
            app=app,
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-stream-response",
                    "sourceId": "broker-unit",
                    "targetId": "python-stream-response",
                    "method": "GET",
                    "path": "/stream-response",
                    "headers": {},
                },
                b"",
            )
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers, {"x-stream": "yes"})
        self.assertEqual(response.body, b"one-two")

    def test_dispatch_routed_request_rejects_oversized_response_body(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send(
                {"type": "http.response.body", "body": b"abcd", "more_body": True}
            )
            await send({"type": "http.response.body", "body": b"e", "more_body": False})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-response-limit",
            app=app,
            max_response_bytes=4,
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-response-limit",
                    "sourceId": "broker-unit",
                    "targetId": "python-response-limit",
                    "method": "GET",
                    "path": "/response-limit",
                    "headers": {},
                },
                b"",
            )
        )

        self.assertEqual(response.error["code"], "local-handler-failure")
        self.assertIn(
            "response body bytes exceed limit", response.error["message"].lower()
        )

    def test_dispatch_routed_request_uses_latin1_response_header_decoding(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"x-binary", bytes([0xE9]))],
                }
            )
            await send({"type": "http.response.body", "body": b"ok"})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-latin1-response",
            app=app,
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-latin1-response",
                    "sourceId": "broker-unit",
                    "targetId": "python-latin1-response",
                    "method": "GET",
                    "path": "/latin1-response",
                    "headers": {},
                },
                b"",
            )
        )

        self.assertEqual(response.headers, {"x-binary": "é"})

    def test_dispatch_sanitizes_hop_by_hop_response_headers(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"transfer-encoding", b"chunked"),
                        (b"connection", b"close"),
                        (b"x-end-to-end", b"preserved"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b"ok"})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1",
            guest_id="python-sanitize-response",
            app=app,
        )

        response = asyncio.run(
            guest.dispatch_routed_request(
                {
                    "requestId": "req-python-sanitize",
                    "sourceId": "broker-unit",
                    "targetId": "python-sanitize-response",
                    "method": "GET",
                    "path": "/sanitize",
                    "headers": {},
                },
                b"",
            )
        )

        self.assertEqual(response.headers.get("x-end-to-end"), "preserved")
        self.assertIsNone(response.headers.get("transfer-encoding"))
        self.assertIsNone(response.headers.get("connection"))


class ProtocolEnvelopeTest(unittest.TestCase):
    def test_direct_dispatch_accepts_list_and_tuple_response_header_pairs(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [[b"x-list", b"value"], (b"x-tuple", b"value")],
                }
            )

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="list-pairs", app=app
        )
        response = asyncio.run(
            guest.dispatch_routed_request(
                {"requestId": "list-pairs", "method": "GET", "path": "/"}, b""
            )
        )

        self.assertEqual(
            response.header_pairs, [("x-list", "value"), ("x-tuple", "value")]
        )

    def test_direct_dispatch_rejects_malformed_response_header_pairs(self) -> None:
        for headers in (
            [[b"x-one"]],
            [[b"x-one", b"value", b"extra"]],
            [[b"x-one", "value"]],
            [["x-one", b"value"]],
        ):
            with self.subTest(headers=headers):
                async def app(scope, receive, send):
                    await receive()
                    await send(
                        {"type": "http.response.start", "status": 200, "headers": headers}
                    )

                guest = create_verser_guest(
                    host_url="https://127.0.0.1:1", guest_id="malformed-pairs", app=app
                )
                response = asyncio.run(
                    guest.dispatch_routed_request(
                        {"requestId": "malformed-pairs", "method": "GET", "path": "/"},
                        b"",
                    )
                )
                self.assertEqual(response.error["code"], "local-handler-failure")

    def test_direct_dispatch_rejects_invalid_response_headers_before_start(self) -> None:
        for name, value in (
            (b"bad name", b"value"),
            (b"x-\xff", b"value"),
            (b"x-control", b"line\rbreak"),
            (b"x-control", b"line\nbreak"),
            (b"x-control", b"nul\x00value"),
            (b"x-control", b"del\x7fvalue"),
        ):
            with self.subTest(name=name, value=value):
                async def app(scope, receive, send):
                    await receive()
                    await send(
                        {
                            "type": "http.response.start",
                            "status": 200,
                            "headers": [(name, value)],
                        }
                    )

                guest = create_verser_guest(
                    host_url="https://127.0.0.1:1", guest_id="invalid-header", app=app
                )
                response = asyncio.run(
                    guest.dispatch_routed_request(
                        {"requestId": "invalid-header", "method": "GET", "path": "/"},
                        b"",
                    )
                )
                self.assertEqual(response.error["code"], "local-handler-failure")

    def test_direct_dispatch_validates_final_response_status_boundaries(self) -> None:
        for status, valid in ((199, False), (200, True), (599, True), (600, False)):
            with self.subTest(status=status):
                async def app(scope, receive, send):
                    await receive()
                    await send(
                        {
                            "type": "http.response.start",
                            "status": status,
                            "headers": [(b"x-latin1", bytes([0xE9]))],
                        }
                    )

                guest = create_verser_guest(
                    host_url="https://127.0.0.1:1", guest_id="status-boundary", app=app
                )
                response = asyncio.run(
                    guest.dispatch_routed_request(
                        {"requestId": "status-boundary", "method": "GET", "path": "/"},
                        b"",
                    )
                )
                if valid:
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.header_pairs, [("x-latin1", "é")])
                else:
                    self.assertEqual(response.error["code"], "local-handler-failure")

    def test_lease_invalid_response_start_sends_pre_start_error_envelope(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"bad name", b"value")],
                }
            )

        request = encode_envelope(
            "request", {"requestId": "invalid-lease-start", "method": "GET", "path": "/"}
        )

        async def run() -> tuple[str, dict[str, Any], bool]:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="invalid-lease-start", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1, data=request, flow_controlled_length=len(request)
                )
            )
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await task
            envelope_type, metadata, _ = decode_envelope(conn.sent_data[0][1])
            return envelope_type, metadata, conn.sent_data[0][2]

        envelope_type, metadata, ended = asyncio.run(run())
        self.assertEqual(envelope_type, "error")
        self.assertEqual(metadata["code"], "local-handler-failure")
        self.assertTrue(ended)

    def test_response_header_pairs_preserve_repetitions_order_and_empty_values(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 207,
                    "headers": [
                        (b"set-cookie", b"first=a"),
                        (b"x-repeat", b"one"),
                        (b"set-cookie", b"second=b"),
                        (b"x-repeat", b"two"),
                        (b"x-empty", b""),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b"ok"})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="response-pairs", app=app
        )
        response = asyncio.run(
            guest.dispatch_routed_request(
                {"requestId": "response-pairs", "method": "GET", "path": "/"}, b""
            )
        )

        self.assertEqual(
            response.header_pairs,
            [
                ("set-cookie", "first=a"),
                ("x-repeat", "one"),
                ("set-cookie", "second=b"),
                ("x-repeat", "two"),
                ("x-empty", ""),
            ],
        )
        self.assertEqual(
            response.headers,
            {"set-cookie": "second=b", "x-repeat": "two", "x-empty": ""},
        )
        self.assertFalse(hasattr(response, "status_text"))

    def test_lease_response_envelope_uses_sanitized_pairs_and_legacy_projection(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"connection", b"x-remove"),
                        (b"x-remove", b"no"),
                        (b"transfer-encoding", b"chunked"),
                        (b"x-verser-response-metadata", b"spoofed"),
                        (b"set-cookie", b"first=a"),
                        (b"x-repeat", b"one"),
                        (b"set-cookie", b"second=b"),
                        (b"x-repeat", b"two"),
                        (b"x-empty", b""),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b"ok"})

        request = encode_envelope(
            "request",
            {"requestId": "lease-response-pairs", "method": "GET", "path": "/"},
        )

        async def run() -> dict[str, Any]:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="lease-response-pairs", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1, data=request, flow_controlled_length=len(request)
                )
            )
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await task
            envelope_type, metadata, _ = decode_envelope(conn.sent_data[0][1])
            self.assertEqual(envelope_type, "response")
            return metadata

        metadata = asyncio.run(run())
        self.assertEqual(
            metadata["headerPairs"],
            [
                ["set-cookie", "first=a"],
                ["x-repeat", "one"],
                ["set-cookie", "second=b"],
                ["x-repeat", "two"],
                ["x-empty", ""],
            ],
        )
        self.assertEqual(
            metadata["headers"],
            {"set-cookie": "second=b", "x-repeat": "two", "x-empty": ""},
        )
        self.assertNotIn("statusText", metadata)

    def test_encode_response_envelope_matches_verser_prefix(self) -> None:
        envelope = encode_envelope(
            "response",
            {
                "requestId": "req-python-envelope",
                "statusCode": 204,
                "headers": {"x-python": "yes"},
            },
        )
        metadata_length = struct.unpack(">I", envelope[2:6])[0]
        metadata = json.loads(envelope[6 : 6 + metadata_length].decode("utf-8"))

        self.assertEqual(envelope[0], 1)
        self.assertEqual(envelope[1], 2)
        self.assertEqual(metadata_length, len(envelope) - 6)
        self.assertEqual(metadata["requestId"], "req-python-envelope")
        self.assertEqual(metadata["statusCode"], 204)
        self.assertEqual(metadata["headers"], {"x-python": "yes"})

    def test_encode_response_envelope_preserves_latin1_and_rejects_non_latin1_values(self) -> None:
        latin1_envelope = encode_envelope(
            "response",
            {
                "requestId": "req-latin1-envelope",
                "statusCode": 200,
                "statusText": "R\u00e9ussi",
                "headers": {"x-latin1": "caf\u00e9"},
                "headerPairs": [("x-latin1", "caf\u00e9")],
            },
        )
        _, latin1_metadata, _ = decode_envelope(latin1_envelope)
        self.assertEqual(latin1_metadata["statusText"], "R\u00e9ussi")
        self.assertEqual(latin1_metadata["headerPairs"], [["x-latin1", "caf\u00e9"]])

        for metadata in (
            {"statusText": "😀", "headers": {}},
            {"headers": {"x-emoji": "😀"}},
            {"headers": {}, "headerPairs": [("x-emoji", "😀")]},
        ):
            with self.subTest(metadata=metadata):
                with self.assertRaisesRegex(ValueError, "Invalid response"):
                    encode_envelope("response", metadata)

    def test_decode_envelope_preserves_body_remainder(self) -> None:
        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-python-envelope-remainder",
                "sourceId": "broker-unit",
                "targetId": "python-envelope-guest",
                "method": "POST",
                "path": "/remainder",
                "headers": {},
            },
        )

        envelope_type, metadata, remainder = decode_envelope(envelope + b"first-body")

        self.assertEqual(envelope_type, "request")
        self.assertEqual(metadata["requestId"], "req-python-envelope-remainder")
        self.assertEqual(remainder, b"first-body")

    def test_normalize_headers_joins_lists_without_spaces_for_node_parity(self) -> None:
        self.assertEqual(
            normalize_headers({"x-list": ["one", "two"]}), {"x-list": "one,two"}
        )

    def test_sanitize_http2_response_headers_strips_standard_hop_by_hop(self) -> None:
        sanitized = sanitize_http2_response_headers(
            {
                "content-type": "text/plain",
                "connection": "close",
                "keep-alive": "timeout=5",
                "proxy-authenticate": "Basic",
                "proxy-authorization": "token",
                "te": "trailers",
                "trailer": "x-custom",
                "transfer-encoding": "chunked",
                "upgrade": "websocket",
                "x-end-to-end": "preserved",
            }
        )
        self.assertEqual(sanitized.get("content-type"), "text/plain")
        self.assertEqual(sanitized.get("x-end-to-end"), "preserved")
        self.assertIsNone(sanitized.get("connection"))
        self.assertIsNone(sanitized.get("keep-alive"))
        self.assertIsNone(sanitized.get("proxy-authenticate"))
        self.assertIsNone(sanitized.get("proxy-authorization"))
        self.assertIsNone(sanitized.get("te"))
        self.assertIsNone(sanitized.get("trailer"))
        self.assertIsNone(sanitized.get("transfer-encoding"))
        self.assertIsNone(sanitized.get("upgrade"))

    def test_sanitize_http2_response_headers_strips_connection_named_headers(
        self,
    ) -> None:
        sanitized = sanitize_http2_response_headers(
            {
                "connection": "x-foo, x-bar",
                "x-foo": "should-be-stripped",
                "x-bar": "also-stripped",
                "x-baz": "preserved",
            }
        )
        self.assertEqual(sanitized.get("x-baz"), "preserved")
        self.assertIsNone(sanitized.get("connection"))
        self.assertIsNone(sanitized.get("x-foo"))
        self.assertIsNone(sanitized.get("x-bar"))

    def test_sanitize_http2_response_headers_preserves_end_to_end_headers(self) -> None:
        sanitized = sanitize_http2_response_headers(
            {
                "content-type": "application/json",
                "content-length": "42",
                "x-custom": "value",
            }
        )
        self.assertEqual(sanitized.get("content-type"), "application/json")
        self.assertEqual(sanitized.get("content-length"), "42")
        self.assertEqual(sanitized.get("x-custom"), "value")


class LeaseTaskTest(unittest.TestCase):
    def test_lease_request_preserves_latin1_header_octets_in_http_scope(self) -> None:
        received_headers: list[tuple[bytes, bytes]] = []

        async def app(scope, receive, send):
            received_headers.extend(scope["headers"])
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        request = encode_envelope(
            "request",
            {
                "requestId": "latin1-request-headers",
                "method": "GET",
                "path": "/",
                "headers": {"x-cafe": "café"},
            },
        )

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="latin1-request-headers", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            await guest._events[1].put(
                h2.events.DataReceived(stream_id=1, data=request, flow_controlled_length=len(request))
            )
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await task

        asyncio.run(run())
        self.assertIn((b"x-cafe", b"caf\xe9"), received_headers)

    def test_malformed_lease_request_headers_do_not_invoke_asgi_app(self) -> None:
        invoked = False

        async def app(scope, receive, send):
            nonlocal invoked
            invoked = True

        request = encode_envelope(
            "request",
            {
                "requestId": "invalid-request-headers",
                "method": "GET",
                "path": "/",
                "headers": {"x-emoji": "😀"},
            },
        )

        async def run() -> dict[str, Any]:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="invalid-request-headers", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            await guest._events[1].put(
                h2.events.DataReceived(stream_id=1, data=request, flow_controlled_length=len(request))
            )
            await task
            envelope_type, metadata, _ = decode_envelope(conn.sent_data[0][1])
            self.assertEqual(envelope_type, "error")
            return metadata

        metadata = asyncio.run(run())
        self.assertFalse(invoked)
        self.assertEqual(metadata["code"], "protocol-error")

    def test_read_loop_does_not_ack_request_body_data_on_frame_receipt(self) -> None:
        async def run() -> list[tuple[int, int]]:
            event = h2.events.DataReceived(
                stream_id=1, data=b"body", flow_controlled_length=7
            )
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="ack-delay"
            )
            conn = FakeConn([event])
            guest._conn = conn
            guest._reader = FakeReader([b"frame-bytes", b""])
            guest._events[1] = asyncio.Queue()
            await guest._read_loop()
            return conn.acknowledged

        self.assertEqual(asyncio.run(run()), [])

    def test_zero_window_sender_fails_when_connection_reaches_eof(self) -> None:
        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="zero-window-eof"
            )
            guest._conn = FakeConn(window=0)
            guest._writer = FakeWriter()
            guest._reader = FakeReader([b""])

            send_task = asyncio.create_task(guest._send_data(1, b"blocked", False))
            await asyncio.sleep(0)
            await guest._read_loop()
            with self.assertRaisesRegex(RuntimeError, "Guest connection closed"):
                await send_task

        asyncio.run(run())

    def test_leased_receive_acks_body_data_after_asgi_consumes_event(self) -> None:
        async def run() -> list[tuple[int, int]]:
            first_receive_ready = asyncio.Event()
            allow_first_receive = asyncio.Event()

            async def app(scope, receive, send):
                first_receive_ready.set()
                await allow_first_receive.wait()
                event = await receive()
                self.assertEqual(event["body"], b"payload")
                await send(
                    {"type": "http.response.start", "status": 200, "headers": []}
                )
                await send(
                    {"type": "http.response.body", "body": b"ok", "more_body": False}
                )

            envelope = encode_envelope(
                "request",
                {
                    "requestId": "req-ack-after-receive",
                    "sourceId": "broker-unit",
                    "targetId": "ack-after-receive",
                    "method": "POST",
                    "path": "/ack",
                    "headers": {},
                },
            )
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="ack-after-receive", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope + b"payload",
                    flow_controlled_length=len(envelope) + len(b"payload"),
                )
            )
            await first_receive_ready.wait()
            self.assertEqual(conn.acknowledged, [])
            allow_first_receive.set()
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await task
            return conn.acknowledged

        self.assertEqual(
            asyncio.run(run()),
            [
                (
                    1,
                    len(
                        encode_envelope(
                            "request",
                            {
                                "requestId": "req-ack-after-receive",
                                "sourceId": "broker-unit",
                                "targetId": "ack-after-receive",
                                "method": "POST",
                                "path": "/ack",
                                "headers": {},
                            },
                        )
                    )
                    + len(b"payload"),
                )
            ],
        )

    def test_completed_lease_tasks_are_pruned(self) -> None:
        async def run() -> int:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="task-prune"
            )

            async def complete_lease() -> None:
                return None

            guest._open_lease_stream = complete_lease
            guest._start_lease_task()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return len(guest._lease_tasks)

        self.assertEqual(asyncio.run(run()), 0)


class VerserGuestRevocationTest(unittest.TestCase):
    """Tests for VerserGuest.revoke_routes()."""

    def _guest_factory(self, **overrides: Any) -> Any:
        opts: dict[str, Any] = {
            "host_url": "https://127.0.0.1",
            "guest_id": "python-unit-guest",
            "routed_domains": ["alpha.local", "beta.local"],
        }
        opts.update(overrides)
        return create_verser_guest(**opts)

    def _run(self, coroutine: Any) -> Any:
        return asyncio.run(coroutine)

    def test_revoke_routes_raises_when_not_connected(self) -> None:
        guest = self._guest_factory()
        with self.assertRaises(RuntimeError) as context:
            self._run(guest.revoke_routes(["alpha.local"]))
        self.assertIn("not connected", str(context.exception).lower())

    def test_revoke_routes_raises_on_empty_domains(self) -> None:
        guest = self._guest_factory()
        guest._conn = MagicMock()
        with self.assertRaises(RuntimeError) as context:
            self._run(guest.revoke_routes([]))
        self.assertIn("at least one domain", str(context.exception).lower())

    def test_revoke_routes_sends_request_to_revoke_path(self) -> None:
        guest = self._guest_factory()
        guest._conn = MagicMock()

        headers_calls: list[Any] = []
        data_calls: list[tuple[int, bytes, bool]] = []

        async def fake_send_headers(
            headers_list: list[tuple[str, str]],
            *,
            end_stream: bool,
            create_queue: bool = True,
        ) -> int:
            headers_calls.append(dict(headers_list))
            return 42

        async def fake_send_data(stream_id: int, data: bytes, end_stream: bool) -> None:
            data_calls.append((stream_id, data, end_stream))

        # Provide a response via the event queue
        guest._events[42] = asyncio.Queue()
        guest._events[42].put_nowait(
            h2.events.DataReceived(
                stream_id=42,
                data=json.dumps({"status": "ack"}).encode(),
                flow_controlled_length=0,
            )
        )
        guest._events[42].put_nowait(h2.events.StreamEnded(stream_id=42))

        with patch.object(
            type(guest), "_send_headers", new=AsyncMock(side_effect=fake_send_headers)
        ):
            with patch.object(
                type(guest), "_send_data", new=AsyncMock(side_effect=fake_send_data)
            ):
                result = self._run(guest.revoke_routes(["alpha.local"]))

        self.assertEqual(result, {"status": "ack"})

        # Verify the request path is the revocation endpoint
        self.assertEqual(len(headers_calls), 1)
        path = headers_calls[0].get(":path")
        self.assertEqual(path, "/verser/guest/revoke")

        # Verify the body contains the domains
        self.assertEqual(len(data_calls), 1)
        body = data_calls[0][1]
        self.assertEqual(json.loads(body.decode()), {"domains": ["alpha.local"]})

    def test_revoke_routes_multiple_domains(self) -> None:
        guest = self._guest_factory()
        guest._conn = MagicMock()

        async def fake_send_headers(
            headers_list: list[tuple[str, str]],
            *,
            end_stream: bool,
            create_queue: bool = True,
        ) -> int:
            return 43

        async def fake_send_data(stream_id: int, data: bytes, end_stream: bool) -> None:
            pass

        guest._events[43] = asyncio.Queue()
        guest._events[43].put_nowait(
            h2.events.DataReceived(
                stream_id=43,
                data=json.dumps({"status": "ack"}).encode(),
                flow_controlled_length=0,
            )
        )
        guest._events[43].put_nowait(h2.events.StreamEnded(stream_id=43))

        with patch.object(
            type(guest), "_send_headers", new=AsyncMock(side_effect=fake_send_headers)
        ):
            with patch.object(
                type(guest), "_send_data", new=AsyncMock(side_effect=fake_send_data)
            ):
                result = self._run(guest.revoke_routes(["alpha.local", "beta.local"]))

        self.assertEqual(result, {"status": "ack"})

    def test_revoke_routes_parses_partial_response(self) -> None:
        guest = self._guest_factory()
        guest._conn = MagicMock()

        async def fake_send_headers(
            headers_list: list[tuple[str, str]],
            *,
            end_stream: bool,
            create_queue: bool = True,
        ) -> int:
            return 44

        async def fake_send_data(stream_id: int, data: bytes, end_stream: bool) -> None:
            pass

        partial_response = {
            "status": "partial",
            "failedDomains": [
                {"domain": "beta.local", "error": "not owned by this guest"},
            ],
        }
        guest._events[44] = asyncio.Queue()
        guest._events[44].put_nowait(
            h2.events.DataReceived(
                stream_id=44,
                data=json.dumps(partial_response).encode(),
                flow_controlled_length=0,
            )
        )
        guest._events[44].put_nowait(h2.events.StreamEnded(stream_id=44))

        with patch.object(
            type(guest), "_send_headers", new=AsyncMock(side_effect=fake_send_headers)
        ):
            with patch.object(
                type(guest), "_send_data", new=AsyncMock(side_effect=fake_send_data)
            ):
                result = self._run(guest.revoke_routes(["alpha.local", "beta.local"]))

        self.assertEqual(result, partial_response)

    def test_revoke_routes_parses_error_response(self) -> None:
        guest = self._guest_factory()
        guest._conn = MagicMock()

        async def fake_send_headers(
            headers_list: list[tuple[str, str]],
            *,
            end_stream: bool,
            create_queue: bool = True,
        ) -> int:
            return 45

        async def fake_send_data(stream_id: int, data: bytes, end_stream: bool) -> None:
            pass

        error_response = {"status": "error", "message": "invalid domain"}
        guest._events[45] = asyncio.Queue()
        guest._events[45].put_nowait(
            h2.events.DataReceived(
                stream_id=45,
                data=json.dumps(error_response).encode(),
                flow_controlled_length=0,
            )
        )
        guest._events[45].put_nowait(h2.events.StreamEnded(stream_id=45))

        with patch.object(
            type(guest), "_send_headers", new=AsyncMock(side_effect=fake_send_headers)
        ):
            with patch.object(
                type(guest), "_send_data", new=AsyncMock(side_effect=fake_send_data)
            ):
                result = self._run(guest.revoke_routes(["invalid.local"]))

        self.assertEqual(result, error_response)

    def test_revoke_routes_raises_on_empty_host_response(self) -> None:
        guest = self._guest_factory()
        guest._conn = MagicMock()

        async def fake_send_headers(
            headers_list: list[tuple[str, str]],
            *,
            end_stream: bool,
            create_queue: bool = True,
        ) -> int:
            return 46

        async def fake_send_data(stream_id: int, data: bytes, end_stream: bool) -> None:
            pass

        guest._events[46] = asyncio.Queue()
        guest._events[46].put_nowait(h2.events.StreamEnded(stream_id=46))

        with patch.object(
            type(guest), "_send_headers", new=AsyncMock(side_effect=fake_send_headers)
        ):
            with patch.object(
                type(guest), "_send_data", new=AsyncMock(side_effect=fake_send_data)
            ):
                with self.assertRaises(RuntimeError) as context:
                    self._run(guest.revoke_routes(["alpha.local"]))
        self.assertIn("empty", str(context.exception).lower())


class VerserGuestTlsConfigTest(unittest.TestCase):
    def _guest_factory(self, **overrides: Any) -> Any:
        opts: dict[str, Any] = {
            "host_url": "https://127.0.0.1",
            "guest_id": "python-unit-guest",
            "routed_domains": ["python-unit.local.test"],
        }
        opts.update(overrides)
        return create_verser_guest(**opts)

    def _run(self, coroutine: Any) -> Any:
        return asyncio.run(coroutine)

    def _mock_open_connection(self) -> Any:
        async def fake_open_connection(*_args: Any, **_kwargs: Any) -> tuple[Any, Any]:
            reader = AsyncMock()
            reader.read = AsyncMock(return_value=b"")
            writer = MagicMock()
            writer.write = MagicMock()
            writer.drain = AsyncMock()
            writer.close = MagicMock()
            writer.wait_closed = AsyncMock()
            ssl_obj = MagicMock()
            ssl_obj.selected_alpn_protocol.return_value = "h2"
            writer.get_extra_info.return_value = ssl_obj
            return reader, writer

        return fake_open_connection

    def test_tls_ca_file_passed_to_ssl_context(self) -> None:
        guest = self._guest_factory(tls_ca_file="/ca.pem")
        ssl_context = MagicMock()

        with patch("ssl.create_default_context", return_value=ssl_context) as mock_ctx:
            with patch(
                "asyncio.open_connection", side_effect=self._mock_open_connection()
            ):
                with patch.object(type(guest), "_register", new=AsyncMock()):
                    with patch.object(
                        type(guest), "_open_control_stream", new=AsyncMock()
                    ):
                        with patch.object(
                            type(guest), "_start_lease_task", new=MagicMock()
                        ):
                            self._run(guest.connect())

        mock_ctx.assert_called_once_with(cafile="/ca.pem")

    def test_pem_client_identity_configures_cert_chain(self) -> None:
        guest = self._guest_factory(
            tls_ca_file="/ca.pem",
            tls_cert_file="/client.pem",
            tls_key_file="/client-key.pem",
            tls_key_password="secret",
        )
        ssl_context = MagicMock()

        with patch("ssl.create_default_context", return_value=ssl_context):
            with patch(
                "asyncio.open_connection", side_effect=self._mock_open_connection()
            ):
                with patch.object(type(guest), "_register", new=AsyncMock()):
                    with patch.object(
                        type(guest), "_open_control_stream", new=AsyncMock()
                    ):
                        with patch.object(
                            type(guest), "_start_lease_task", new=MagicMock()
                        ):
                            self._run(guest.connect())

        ssl_context.load_cert_chain.assert_called_once_with(
            certfile="/client.pem",
            keyfile="/client-key.pem",
            password="secret",
        )

    def test_pfx_client_identity_invokes_helper(self) -> None:
        guest = self._guest_factory(
            tls_ca_file="/ca.pem",
            tls_pfx_file="/client.pfx",
            tls_pfx_password="pfx-secret",
        )

        self.assertTrue(
            hasattr(type(guest), "_load_pfx_client_identity"),
            "Guest should expose a _load_pfx_client_identity helper for PFX/PKCS12 support",
        )

    def test_pfx_client_identity_loads_temp_cert_after_file_close(self) -> None:
        guest = self._guest_factory()
        ssl_context = MagicMock()
        temp_file_state = {"closed": False}

        class FakeTemporaryFile:
            name = "/tmp/verser-python-guest-client.pem"

            def __enter__(self) -> "FakeTemporaryFile":
                return self

            def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
                temp_file_state["closed"] = True

            def write(self, payload: bytes) -> int:
                return len(payload)

            def flush(self) -> None:
                return None

        fake_key = MagicMock()
        fake_key.private_bytes.return_value = b"KEY"
        fake_certificate = MagicMock()
        fake_certificate.public_bytes.return_value = b"CERT"

        def assert_closed_before_load(_path: str) -> None:
            self.assertTrue(temp_file_state["closed"])

        ssl_context.load_cert_chain.side_effect = assert_closed_before_load

        with patch(
            "tempfile.NamedTemporaryFile", return_value=FakeTemporaryFile()
        ) as temp_file:
            with patch("os.unlink") as unlink:
                with patch.object(builtins, "open", return_value=BytesIO(b"pfx-bytes")):
                    with patch(
                        "cryptography.hazmat.primitives.serialization.pkcs12.load_key_and_certificates",
                        return_value=(fake_key, fake_certificate, []),
                    ):
                        guest._load_pfx_client_identity(
                            ssl_context, "/client.pfx", "secret"
                        )

        temp_file.assert_called_once_with("wb", delete=False)
        ssl_context.load_cert_chain.assert_called_once_with(
            "/tmp/verser-python-guest-client.pem"
        )
        unlink.assert_called_once_with("/tmp/verser-python-guest-client.pem")

    def test_alpn_not_h2_raises_actionable_error(self) -> None:
        guest = self._guest_factory()
        writer = MagicMock()
        ssl_obj = MagicMock()
        ssl_obj.selected_alpn_protocol.return_value = "http/1.1"
        writer.get_extra_info.return_value = ssl_obj

        with self.assertRaises(Exception) as context:
            guest._validate_h2_alpn(writer)

        message = str(context.exception).lower()
        self.assertTrue(any(word in message for word in ("alpn", "http/2", "h2")))

    def test_tls_handshake_failure_is_actionable(self) -> None:
        guest = self._guest_factory()
        ssl_context = MagicMock()

        with patch("ssl.create_default_context", return_value=ssl_context):
            with patch(
                "asyncio.open_connection", side_effect=OSError("Connection refused")
            ):
                with self.assertRaises(Exception) as context:
                    self._run(guest.connect())

        message = str(context.exception).lower()
        self.assertTrue(any(word in message for word in ("tls", "handshake")))


class LeaseStreamResetTest(unittest.TestCase):
    """Tests for stream reset/cancellation handling in leased dispatch."""

    def test_stream_reset_during_dispatch_unblocks_and_returns_cleanly(self) -> None:
        """StreamReset unblocks ASGI receive() and cancels app without hanging."""
        app_started = asyncio.Event()

        async def app(scope: Any, receive: Any, send: Any) -> None:
            app_started.set()
            _ = await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-reset-unblock",
                "sourceId": "broker-unit",
                "targetId": "reset-unblock-guest",
                "method": "POST",
                "path": "/reset",
                "headers": {},
            },
        )

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="reset-unblock-guest",
                app=app,
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            # Send request envelope to start the app
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope,
                    flow_controlled_length=len(envelope),
                )
            )
            await asyncio.wait_for(app_started.wait(), timeout=5)
            # Send StreamReset — must unblock receive() and cancel app dispatch
            await guest._events[1].put(h2.events.StreamReset(stream_id=1, error_code=0))
            # Task completes cleanly within timeout — no hang from hanging receive()
            await asyncio.wait_for(task, timeout=5)
            # The terminator event may or may not be consumed before cancellation,
            # but the key assertion is that dispatch returns without hanging.

        asyncio.run(run())

    def test_stream_reset_before_app_start_returns_cleanly(self) -> None:
        """StreamReset before the envelope is fully received returns cleanly."""

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="reset-before-start",
                app=lambda scope, receive, send: None,
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            # Send StreamReset before any data arrives
            await guest._events[1].put(h2.events.StreamReset(stream_id=1, error_code=0))
            await asyncio.wait_for(task, timeout=5)
            # Task completed cleanly without raising RuntimeError

        asyncio.run(run())

    def test_fail_pending_streams_unblocks_dispatch(self) -> None:
        """_fail_pending_streams via read-loop connection close unblocks dispatch
        and does NOT leave the ASGI app task pending."""
        app_exited = asyncio.Event()

        async def app(scope: Any, receive: Any, send: Any) -> None:
            try:
                event = await receive()
                _ = event
            finally:
                app_exited.set()

        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-fail-streams",
                "sourceId": "broker-unit",
                "targetId": "fail-streams-guest",
                "method": "GET",
                "path": "/fail",
                "headers": {},
            },
        )

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="fail-streams-guest",
                app=app,
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            # Queue envelope to start the app
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope,
                    flow_controlled_length=len(envelope),
                )
            )
            await asyncio.sleep(0.02)
            # Simulate connection close — fails pending streams
            guest._fail_pending_streams(RuntimeError("connection lost"))
            # Dispatch should raise after cleaning up the app task
            with self.assertRaises(RuntimeError):
                await task
            # Prove the app task was cleaned up (finally ran) and did not
            # remain pending until event-loop shutdown.
            await asyncio.wait_for(app_exited.wait(), timeout=5)

        asyncio.run(run())


class HttpLeaseCancellationTest(unittest.TestCase):
    """Barrier-driven coverage for HTTP lease EOF/disconnect supervision."""

    @staticmethod
    def _request(request_id: str = "cancel-http") -> bytes:
        return encode_envelope(
            "request",
            {
                "requestId": request_id,
                "sourceId": "broker-unit",
                "targetId": "cancel-http-guest",
                "method": "GET",
                "path": "/cancel",
                "headers": {},
            },
        )

    @staticmethod
    async def _dispatch(app: Any, stream_id: int = 71) -> tuple[Any, FakeConn, asyncio.Queue, asyncio.Task]:
        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="cancel-http-guest", app=app
        )
        conn = FakeConn()
        events: asyncio.Queue = asyncio.Queue()
        guest._conn = conn
        guest._events[stream_id] = events
        task = asyncio.create_task(guest._dispatch_leased_request_stream(stream_id))
        await events.put(
            h2.events.DataReceived(
                stream_id=stream_id,
                data=HttpLeaseCancellationTest._request(),
                flow_controlled_length=len(HttpLeaseCancellationTest._request()),
            )
        )
        return guest, conn, events, task

    async def _finish_task(self, task: asyncio.Task) -> None:
        await asyncio.wait_for(task, timeout=2)

    def test_post_upload_eof_reset_notifies_receive_and_finishes_app_before_dispatch(self) -> None:
        async def run_case(streaming: bool) -> None:
            app_ready = asyncio.Event()
            eof_received = asyncio.Event()
            cleanup_finished = asyncio.Event()
            disconnect_events: list[dict[str, Any]] = []

            async def app(scope: Any, receive: Any, send: Any) -> None:
                try:
                    request_event = await receive()
                    self.assertEqual(request_event["type"], "http.request")
                    self.assertFalse(request_event["more_body"])
                    eof_received.set()
                    if streaming:
                        await send(
                            {"type": "http.response.start", "status": 200, "headers": []}
                        )
                        await send(
                            {
                                "type": "http.response.body",
                                "body": b"partial",
                                "more_body": True,
                            }
                        )
                    app_ready.set()
                    disconnect_events.append(await receive())
                finally:
                    cleanup_finished.set()

            guest, conn, events, dispatch = await self._dispatch(app, 71 if not streaming else 72)
            try:
                await events.put(h2.events.StreamEnded(stream_id=71 if not streaming else 72))
                await asyncio.wait_for(eof_received.wait(), timeout=2)
                await asyncio.wait_for(app_ready.wait(), timeout=2)
                # app_ready is set only after EOF has become an ASGI request event.
                await events.put(
                    h2.events.StreamReset(stream_id=71 if not streaming else 72, error_code=8)
                )
                await self._finish_task(dispatch)
                self.assertEqual(disconnect_events, [{"type": "http.disconnect"}])
                self.assertTrue(cleanup_finished.is_set())
                self.assertEqual(conn.reset_streams, [])
                if streaming:
                    self.assertTrue(any(data == b"partial" for _, data, _ in conn.sent_data))
                    self.assertFalse(any(ended for _, _, ended in conn.sent_data))
            finally:
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        async def run() -> None:
            with patch.object(
                guest_module, "_DEFAULT_HTTP_DISCONNECT_GRACE_SECONDS", 0.01, create=True
            ):
                await run_case(False)
                await run_case(True)

        asyncio.run(run())

    def test_unobserved_disconnect_cancels_app_after_private_grace(self) -> None:
        async def run() -> None:
            unrelated_work = asyncio.Event()
            app_waiting = asyncio.Event()
            cancelled = asyncio.Event()
            received_events: list[dict[str, Any]] = []

            async def app(scope: Any, receive: Any, send: Any) -> None:
                try:
                    received_events.append(await receive())
                    app_waiting.set()
                    await unrelated_work.wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise

            with patch.object(
                guest_module, "_DEFAULT_HTTP_DISCONNECT_GRACE_SECONDS", 0.01, create=True
            ):
                guest, _conn, events, dispatch = await self._dispatch(app, 73)
                try:
                    await events.put(h2.events.StreamEnded(stream_id=73))
                    await asyncio.wait_for(app_waiting.wait(), timeout=2)
                    await events.put(h2.events.StreamReset(stream_id=73, error_code=8))
                    await self._finish_task(dispatch)
                    self.assertTrue(cancelled.is_set())
                    self.assertEqual(received_events[0]["type"], "http.request")
                finally:
                    if not dispatch.done():
                        dispatch.cancel()
                        await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_observed_disconnect_cleanup_is_not_cancelled_after_grace_expires(self) -> None:
        async def run() -> None:
            eof_received = asyncio.Event()
            cleanup_started = asyncio.Event()
            release_cleanup = asyncio.Event()
            cleanup_cancelled = asyncio.Event()
            cleanup_continued_past_grace = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                try:
                    await receive()
                    eof_received.set()
                    await receive()
                finally:
                    cleanup_started.set()
                    try:
                        await release_cleanup.wait()
                    except asyncio.CancelledError:
                        cleanup_cancelled.set()
                        raise

            with patch.object(
                guest_module, "_DEFAULT_HTTP_DISCONNECT_GRACE_SECONDS", 0.001, create=True
            ):
                guest, _conn, events, dispatch = await self._dispatch(app, 74)
                loop = asyncio.get_running_loop()
                grace_elapsed = asyncio.Event()
                timer = loop.call_later(0.02, grace_elapsed.set)
                try:
                    await events.put(h2.events.StreamEnded(stream_id=74))
                    await asyncio.wait_for(eof_received.wait(), timeout=2)
                    await events.put(h2.events.StreamReset(stream_id=74, error_code=8))
                    await asyncio.wait_for(cleanup_started.wait(), timeout=2)
                    await asyncio.wait_for(grace_elapsed.wait(), timeout=2)
                    cleanup_continued_past_grace.set()
                    self.assertFalse(cleanup_cancelled.is_set())
                    release_cleanup.set()
                    await self._finish_task(dispatch)
                    self.assertTrue(cleanup_continued_past_grace.is_set())
                    self.assertFalse(cleanup_cancelled.is_set())
                finally:
                    timer.cancel()
                    release_cleanup.set()
                    if not dispatch.done():
                        dispatch.cancel()
                        await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_connection_failure_after_upload_eof_awaits_cleanup_then_reraises_original(self) -> None:
        async def run() -> None:
            eof_received = asyncio.Event()
            cleanup_started = asyncio.Event()
            release_cleanup = asyncio.Event()
            original = RuntimeError("post-EOF connection failure")

            async def app(scope: Any, receive: Any, send: Any) -> None:
                try:
                    await receive()
                    eof_received.set()
                    await receive()
                finally:
                    cleanup_started.set()
                    await release_cleanup.wait()

            guest, _conn, events, dispatch = await self._dispatch(app, 75)
            try:
                await events.put(h2.events.StreamEnded(stream_id=75))
                await asyncio.wait_for(eof_received.wait(), timeout=2)
                await events.put(original)
                await asyncio.wait_for(cleanup_started.wait(), timeout=2)
                self.assertFalse(dispatch.done())
                release_cleanup.set()
                with self.assertRaises(RuntimeError) as caught:
                    await asyncio.wait_for(dispatch, timeout=2)
                self.assertIs(caught.exception, original)
            finally:
                release_cleanup.set()
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_normal_response_then_future_receive_is_disconnect_without_transport_abort(self) -> None:
        async def run() -> None:
            received: list[dict[str, Any]] = []
            response_complete = asyncio.Event()
            app_done = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                received.append(await receive())
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"ok", "more_body": False})
                response_complete.set()
                received.append(await receive())
                app_done.set()

            guest, conn, events, dispatch = await self._dispatch(app, 76)
            try:
                await events.put(h2.events.StreamEnded(stream_id=76))
                await asyncio.wait_for(response_complete.wait(), timeout=2)
                await asyncio.wait_for(app_done.wait(), timeout=2)
                await self._finish_task(dispatch)
                self.assertEqual(received[-1], {"type": "http.disconnect"})
                self.assertEqual(conn.reset_streams, [])
                self.assertTrue(any(item[2] for item in conn.sent_data))
            finally:
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_upload_eof_does_not_disconnect_while_response_is_still_pending(self) -> None:
        async def run() -> None:
            eof_received = asyncio.Event()
            waiting_for_response = asyncio.Event()
            allow_response = asyncio.Event()
            app_done = asyncio.Event()
            final_body_sent = asyncio.Event()
            receive_after_response = asyncio.Event()
            received: list[dict[str, Any]] = []
            body_send_errors: list[BaseException] = []

            async def app(scope: Any, receive: Any, send: Any) -> None:
                received.append(await receive())
                eof_received.set()
                await send({"type": "http.response.start", "status": 200, "headers": []})
                pending_receive = asyncio.create_task(receive())
                waiting_for_response.set()
                await allow_response.wait()
                try:
                    await send({"type": "http.response.body", "body": b"done", "more_body": False})
                except BaseException as error:
                    body_send_errors.append(error)
                    raise
                finally:
                    final_body_sent.set()
                received.append(await pending_receive)
                receive_after_response.set()
                app_done.set()

            guest, conn, events, dispatch = await self._dispatch(app, 77)
            try:
                await events.put(h2.events.StreamEnded(stream_id=77))
                await asyncio.wait_for(waiting_for_response.wait(), timeout=2)
                self.assertTrue(eof_received.is_set())
                self.assertFalse(dispatch.done())
                self.assertNotIn({"type": "http.disconnect"}, received)
                allow_response.set()
                await asyncio.wait_for(final_body_sent.wait(), timeout=2)
                self.assertEqual(body_send_errors, [])
                await asyncio.wait_for(receive_after_response.wait(), timeout=2)
                await asyncio.wait_for(app_done.wait(), timeout=2)
                await self._finish_task(dispatch)
                self.assertEqual(received[-1], {"type": "http.disconnect"})
                self.assertEqual(conn.reset_streams, [])
            finally:
                allow_response.set()
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_observed_disconnect_wins_timeout_race(self) -> None:
        async def run() -> None:
            eof_received = asyncio.Event()
            disconnect_received = asyncio.Event()
            cancelled = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                try:
                    await receive()
                    eof_received.set()
                    event = await receive()
                    self.assertEqual(event, {"type": "http.disconnect"})
                    disconnect_received.set()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise

            with patch.object(
                guest_module, "_DEFAULT_HTTP_DISCONNECT_GRACE_SECONDS", 0.01, create=True
            ):
                guest, _conn, events, dispatch = await self._dispatch(app, 78)
                try:
                    await events.put(h2.events.StreamEnded(stream_id=78))
                    await asyncio.wait_for(eof_received.wait(), timeout=2)
                    # Queue the terminal transport signal only after receive is waiting;
                    # the app's notification is the competing observation outcome.
                    await events.put(h2.events.StreamReset(stream_id=78, error_code=8))
                    await asyncio.wait_for(disconnect_received.wait(), timeout=2)
                    await self._finish_task(dispatch)
                    self.assertFalse(cancelled.is_set())
                finally:
                    if not dispatch.done():
                        dispatch.cancel()
                        await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_application_can_finish_before_eof_and_remaining_upload_is_drained_once(self) -> None:
        async def run() -> tuple[FakeConn, bytes]:
            app_finished = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"early", "more_body": False})
                app_finished.set()

            guest, conn, events, dispatch = await self._dispatch(app, 79)
            envelope = self._request()
            try:
                await asyncio.wait_for(app_finished.wait(), timeout=2)
                await events.put(
                    h2.events.DataReceived(
                        stream_id=79, data=b"discard-one", flow_controlled_length=11
                    )
                )
                await events.put(h2.events.DataReceived(stream_id=79, data=b"two", flow_controlled_length=3))
                await events.put(h2.events.StreamEnded(stream_id=79))
                await self._finish_task(dispatch)
                return conn, envelope
            finally:
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        conn, envelope = asyncio.run(run())
        self.assertEqual(
            sorted(amount for stream_id, amount in conn.acknowledged if stream_id == 79),
            sorted([len(envelope), 11, 3]),
        )
        self.assertEqual(
            sum(amount for _stream_id, amount in conn.acknowledged), len(envelope) + 14
        )
        self.assertTrue(any(ended for _stream, _data, ended in conn.sent_data))

    def test_early_response_reclaims_prequeued_body_credit_before_upload_eof(self) -> None:
        async def run() -> tuple[FakeConn, int, list[int]]:
            response_finished = asyncio.Event()
            expected_credit: list[int] = []

            async def app(scope: Any, receive: Any, send: Any) -> None:
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send(
                    {"type": "http.response.body", "body": b"early", "more_body": False}
                )
                response_finished.set()

            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="prequeued-early-response", app=app
            )
            conn = FakeConn()
            events: asyncio.Queue = asyncio.Queue()
            guest._conn = conn
            guest._events[82] = events
            envelope = self._request("prequeued-early-response")
            first_credit = len(envelope) + 3
            second_credit = 7
            expected_credit.extend([first_credit, second_credit])
            original_acknowledge = guest._acknowledge_received_data
            all_credit_returned = asyncio.Event()

            async def observe_acknowledgement(stream_id: int, amount: int) -> None:
                await original_acknowledge(stream_id, amount)
                if sum(value for _sid, value in conn.acknowledged) >= sum(expected_credit):
                    all_credit_returned.set()

            guest._acknowledge_received_data = observe_acknowledgement
            events.put_nowait(
                h2.events.DataReceived(
                    stream_id=82,
                    data=envelope + b"one",
                    flow_controlled_length=first_credit,
                )
            )
            events.put_nowait(
                h2.events.DataReceived(
                    stream_id=82,
                    data=b"payload",
                    flow_controlled_length=second_credit,
                )
            )
            task = asyncio.create_task(guest._dispatch_leased_request_stream(82))
            try:
                await asyncio.wait_for(response_finished.wait(), timeout=2)
                await asyncio.wait_for(all_credit_returned.wait(), timeout=2)
                self.assertFalse(task.done(), "the dispatcher must keep monitoring for upload EOF")
                self.assertEqual(
                    sorted(amount for _sid, amount in conn.acknowledged),
                    sorted(expected_credit),
                )
                await events.put(h2.events.StreamEnded(stream_id=82))
                await self._finish_task(task)
                return conn, sum(expected_credit), [amount for _sid, amount in conn.acknowledged]
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        conn, expected_total, acknowledged = asyncio.run(run())
        self.assertEqual(sum(acknowledged), expected_total)
        self.assertTrue(all(stream_id == 82 for stream_id, _amount in conn.acknowledged))

    def test_receive_and_terminal_credit_cleanup_join_one_inflight_ack(self) -> None:
        async def run() -> tuple[FakeConn, list[int]]:
            acknowledgement_entered = asyncio.Event()
            release_acknowledgement = asyncio.Event()
            receive_returned = asyncio.Event()
            app_events: list[dict[str, Any]] = []

            async def app(scope: Any, receive: Any, send: Any) -> None:
                app_events.append(await receive())
                receive_returned.set()

            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="overlap-credit-ack", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            events: asyncio.Queue = asyncio.Queue()
            guest._events[84] = events
            original_acknowledge = guest._acknowledge_received_data
            credit = len(self._request("overlap-credit-ack")) + 4

            async def gated_acknowledgement(stream_id: int, amount: int) -> None:
                await original_acknowledge(stream_id, amount)
                acknowledgement_entered.set()
                await release_acknowledgement.wait()

            guest._acknowledge_received_data = gated_acknowledgement
            await events.put(
                h2.events.DataReceived(
                    stream_id=84,
                    data=self._request("overlap-credit-ack") + b"body",
                    flow_controlled_length=credit,
                )
            )
            task = asyncio.create_task(guest._dispatch_leased_request_stream(84))
            try:
                await asyncio.wait_for(acknowledgement_entered.wait(), timeout=2)
                # The protocol acknowledgement has happened, but its flush is
                # held. Reset makes the supervisor concurrently claim cleanup.
                self.assertEqual(conn.acknowledged, [(84, credit)])
                await events.put(h2.events.StreamReset(stream_id=84, error_code=8))
                await asyncio.sleep(0)
                self.assertFalse(task.done())
                release_acknowledgement.set()
                await self._finish_task(task)
                self.assertTrue(receive_returned.is_set())
                self.assertEqual([event["type"] for event in app_events], ["http.disconnect"])
                self.assertEqual(conn.acknowledged, [(84, credit)])
                leaked_ack_tasks = [
                    pending
                    for pending in asyncio.all_tasks()
                    if pending.get_name().startswith("verser-http-credit-")
                    and not pending.done()
                ]
                self.assertEqual(leaked_ack_tasks, [])
                return conn, [amount for _stream_id, amount in conn.acknowledged]
            finally:
                release_acknowledgement.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        conn, acknowledged = asyncio.run(run())
        self.assertEqual(acknowledged, [len(self._request("overlap-credit-ack")) + 4])
        self.assertEqual(len(conn.acknowledged), 1)

    def test_administrative_cancel_joins_shared_ack_without_dangling_task(self) -> None:
        async def run() -> tuple[FakeConn, int]:
            acknowledgement_entered = asyncio.Event()
            release_acknowledgement = asyncio.Event()
            app_cancelled = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                try:
                    await receive()
                    await receive()
                except asyncio.CancelledError:
                    app_cancelled.set()
                    raise

            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="admin-credit-ack", app=app
            )
            conn = FakeConn()
            guest._conn = conn
            events: asyncio.Queue = asyncio.Queue()
            guest._events[85] = events
            original_acknowledge = guest._acknowledge_received_data
            credit = len(self._request("admin-credit-ack")) + 2

            async def gated_acknowledgement(stream_id: int, amount: int) -> None:
                await original_acknowledge(stream_id, amount)
                acknowledgement_entered.set()
                await release_acknowledgement.wait()

            guest._acknowledge_received_data = gated_acknowledgement
            await events.put(
                h2.events.DataReceived(
                    stream_id=85,
                    data=self._request("admin-credit-ack") + b"x",
                    flow_controlled_length=credit,
                )
            )
            task = asyncio.create_task(guest._dispatch_leased_request_stream(85))
            try:
                await asyncio.wait_for(acknowledgement_entered.wait(), timeout=2)
                self.assertEqual(conn.acknowledged, [(85, credit)])
                task.cancel()
                await asyncio.wait_for(app_cancelled.wait(), timeout=2)
                await asyncio.sleep(0)
                self.assertFalse(task.done())
                release_acknowledgement.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, timeout=2)
                leaked_ack_tasks = [
                    pending
                    for pending in asyncio.all_tasks()
                    if pending.get_name().startswith("verser-http-credit-")
                    and not pending.done()
                ]
                self.assertEqual(leaked_ack_tasks, [])
                self.assertEqual(conn.acknowledged, [(85, credit)])
                return conn, credit
            finally:
                release_acknowledgement.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        conn, credit = asyncio.run(run())
        self.assertEqual(conn.acknowledged, [(85, credit)])

    def test_terminal_send_failure_reclaims_fetched_and_raw_native_event_credit_once(self) -> None:
        async def run() -> tuple[FakeConn, list[int]]:
            fetched_event = asyncio.Event()

            class ObservedEventQueue(asyncio.Queue):
                async def get(self) -> Any:
                    event = await super().get()
                    if isinstance(event, h2.events.DataReceived) and event.data == b"fetched":
                        fetched_event.set()
                    return event

            async def app(scope: Any, receive: Any, send: Any) -> None:
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await fetched_event.wait()
                await send(
                    {
                        "type": "http.response.body",
                        "body": b"terminal-send-failure",
                        "more_body": False,
                    }
                )

            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="terminal-send-credit", app=app
            )
            conn = FakeConn()
            original_send_data = conn.send_data

            def reset_on_response_body(
                stream_id: int, data: bytes, end_stream: bool = False
            ) -> None:
                if data == b"terminal-send-failure":
                    raise guest_module._HTTP2StreamResetError("test terminal write reset")
                original_send_data(stream_id, data, end_stream)

            conn.send_data = reset_on_response_body
            events: asyncio.Queue = ObservedEventQueue()
            guest._conn = conn
            guest._events[83] = events
            envelope = self._request("terminal-send-credit")
            expected_credit = [len(envelope) + 3, 7, 5]
            events.put_nowait(
                h2.events.DataReceived(
                    stream_id=83,
                    data=envelope + b"one",
                    flow_controlled_length=expected_credit[0],
                )
            )
            events.put_nowait(
                h2.events.DataReceived(
                    stream_id=83, data=b"fetched", flow_controlled_length=7
                )
            )
            # These are still native-queue-owned when the response write fails.
            events.put_nowait(
                h2.events.DataReceived(stream_id=83, data=b"raw", flow_controlled_length=5)
            )
            events.put_nowait(h2.events.StreamEnded(stream_id=83))
            task = asyncio.create_task(guest._dispatch_leased_request_stream(83))
            try:
                await self._finish_task(task)
                return conn, expected_credit
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        conn, expected_credit = asyncio.run(run())
        self.assertEqual(
            sorted(amount for stream_id, amount in conn.acknowledged if stream_id == 83),
            sorted(expected_credit),
        )
        self.assertEqual(
            sum(amount for stream_id, amount in conn.acknowledged if stream_id == 83),
            sum(expected_credit),
        )

    def test_reset_recovers_queued_body_and_metadata_credit_exactly_once(self) -> None:
        async def run() -> tuple[FakeConn, bytes]:
            unrelated_work = asyncio.Event()
            app_started = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                app_started.set()
                await unrelated_work.wait()

            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="cancel-http-guest", app=app
            )
            conn = FakeConn()
            events: asyncio.Queue = asyncio.Queue()
            guest._conn = conn
            guest._events[80] = events
            envelope = self._request("credit-on-reset")
            task = asyncio.create_task(guest._dispatch_leased_request_stream(80))
            try:
                await events.put(
                    h2.events.DataReceived(
                        stream_id=80,
                        data=envelope + b"one",
                        flow_controlled_length=len(envelope) + 3,
                    )
                )
                await asyncio.wait_for(app_started.wait(), timeout=2)
                await events.put(
                    h2.events.DataReceived(
                        stream_id=80, data=b"two", flow_controlled_length=3
                    )
                )
                await events.put(h2.events.StreamEnded(stream_id=80))
                await events.put(h2.events.StreamReset(stream_id=80, error_code=8))
                await self._finish_task(task)
                return conn, envelope
            finally:
                unrelated_work.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        conn, envelope = asyncio.run(run())
        self.assertEqual(sum(amount for _stream_id, amount in conn.acknowledged), len(envelope) + 6)
        self.assertTrue(all(stream_id == 80 for stream_id, _amount in conn.acknowledged))
        self.assertEqual(
            [amount for _stream_id, amount in conn.acknowledged].count(len(envelope) + 3), 1
        )
        self.assertEqual([amount for _stream_id, amount in conn.acknowledged].count(3), 1)

    def test_http_stream_ended_preserves_blocked_response_write_until_window_update(self) -> None:
        async def run() -> tuple[ObservableWindowConn, int]:
            app_started = asyncio.Event()
            conn = ObservableWindowConn(window=65535, expected_waiters=2)

            async def app(scope: Any, receive: Any, send: Any) -> None:
                await receive()
                await send({"type": "http.response.start", "status": 200, "headers": []})
                app_started.set()
                conn.window = 0
                await send({"type": "http.response.body", "body": b"windowed", "more_body": False})

            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="window-after-eof", app=app
            )
            reader = FeedReader()
            guest._conn = conn
            guest._reader = reader
            guest._events[81] = asyncio.Queue()
            # The test enters through the HTTP lease path; the stream id is registered
            # before the reader processes its upload EOF.
            guest._http_lease_stream_ids.add(81)
            dispatch = asyncio.create_task(guest._dispatch_leased_request_stream(81))
            read_loop = asyncio.create_task(guest._read_loop())
            try:
                await guest._events[81].put(
                    h2.events.DataReceived(
                        stream_id=81,
                        data=self._request("window-after-eof") + b"request-body",
                        flow_controlled_length=len(self._request("window-after-eof"))
                        + len(b"request-body"),
                    )
                )
                await asyncio.wait_for(app_started.wait(), timeout=2)
                await asyncio.wait_for(conn.waiters_blocked.wait(), timeout=2)
                self.assertTrue(guest._window_waiters.get(81))
                conn.feed_events(
                    h2.events.StreamEnded(stream_id=81),
                    h2.events.WindowUpdated(stream_id=0, delta=8),
                )
                conn.window = 8
                reader.feed()
                await self._finish_task(dispatch)
                return conn, 81
            finally:
                if not read_loop.done():
                    read_loop.cancel()
                    await asyncio.gather(read_loop, return_exceptions=True)
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        conn, stream_id = asyncio.run(run())
        self.assertTrue(any(data == b"windowed" for sid, data, _end in conn.sent_data if sid == stream_id))

    def test_reset_fails_only_the_affected_window_writer_with_oserror(self) -> None:
        async def run() -> tuple[ObservableWindowConn, asyncio.Task, asyncio.Task]:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="isolated-window-reset"
            )
            conn = ObservableWindowConn(window=0, expected_waiters=2)
            reader = FeedReader()
            guest._conn = conn
            guest._reader = reader
            guest._http_lease_stream_ids.add(91)
            affected = asyncio.create_task(guest._send_data(91, b"affected", False))
            survivor = asyncio.create_task(guest._send_data(92, b"survives", False))
            read_loop = asyncio.create_task(guest._read_loop())
            try:
                await asyncio.wait_for(conn.waiters_blocked.wait(), timeout=2)
                conn.feed_events(h2.events.StreamReset(stream_id=91, error_code=8))
                reader.feed()
                with self.assertRaises(OSError):
                    await asyncio.wait_for(affected, timeout=2)
                self.assertFalse(survivor.done())
                conn.window = 16
                conn.feed_events(h2.events.WindowUpdated(stream_id=92, delta=16))
                reader.feed()
                await asyncio.wait_for(survivor, timeout=2)
                return conn, affected, survivor
            finally:
                if not read_loop.done():
                    read_loop.cancel()
                    await asyncio.gather(read_loop, return_exceptions=True)
                for task in (affected, survivor):
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

        asyncio.run(run())

    def test_completed_and_reset_sends_preserve_closed_and_validation_errors(self) -> None:
        async def run() -> tuple[list[type[BaseException]], FakeConn]:
            errors: list[type[BaseException]] = []
            response_done = asyncio.Event()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                await receive()
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"done", "more_body": False})
                response_done.set()
                for message in (
                    {"type": "not-an-asgi-message"},
                    {"type": "http.response.body", "body": b"late", "more_body": False},
                ):
                    try:
                        await send(message)
                    except BaseException as error:
                        errors.append(type(error))

            guest, conn, events, dispatch = await self._dispatch(app, 93)
            try:
                await events.put(h2.events.StreamEnded(stream_id=93))
                await asyncio.wait_for(response_done.wait(), timeout=2)
                await self._finish_task(dispatch)
                return errors, conn
            finally:
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        errors, _conn = asyncio.run(run())
        self.assertTrue(errors)
        self.assertTrue(issubclass(errors[0], ValueError))
        self.assertTrue(issubclass(errors[1], ConnectionError))

    def test_send_after_transport_reset_raises_connection_error(self) -> None:
        async def run() -> None:
            request_received = asyncio.Event()
            send_failed = asyncio.Event()
            observed: list[dict[str, Any]] = []
            errors: list[BaseException] = []

            async def app(scope: Any, receive: Any, send: Any) -> None:
                observed.append(await receive())
                request_received.set()
                observed.append(await receive())
                try:
                    await send({"type": "http.response.start", "status": 200, "headers": []})
                except ConnectionError as error:
                    errors.append(error)
                finally:
                    send_failed.set()

            guest, _conn, events, dispatch = await self._dispatch(app, 95)
            try:
                await events.put(h2.events.StreamEnded(stream_id=95))
                await asyncio.wait_for(request_received.wait(), timeout=2)
                await events.put(h2.events.StreamReset(stream_id=95, error_code=8))
                await asyncio.wait_for(send_failed.wait(), timeout=2)
                await self._finish_task(dispatch)
                self.assertEqual(observed[-1], {"type": "http.disconnect"})
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], OSError)
            finally:
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_supervisor_cancellation_does_not_recancel_async_finally_or_leak_tasks(self) -> None:
        async def run() -> None:
            app_waiting = asyncio.Event()
            cleanup_started = asyncio.Event()
            release_cleanup = asyncio.Event()
            cancellations = 0
            cleanup_interrupted = False
            baseline = asyncio.all_tasks()

            async def app(scope: Any, receive: Any, send: Any) -> None:
                nonlocal cancellations, cleanup_interrupted
                try:
                    await receive()
                    app_waiting.set()
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancellations += 1
                    raise
                finally:
                    cleanup_started.set()
                    try:
                        await release_cleanup.wait()
                    except asyncio.CancelledError:
                        cleanup_interrupted = True
                        raise

            guest, _conn, events, dispatch = await self._dispatch(app, 94)
            try:
                await events.put(h2.events.StreamEnded(stream_id=94))
                await asyncio.wait_for(app_waiting.wait(), timeout=2)
                dispatch.cancel()
                await asyncio.wait_for(cleanup_started.wait(), timeout=2)
                self.assertFalse(dispatch.done())
                self.assertEqual(cancellations, 1)
                release_cleanup.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(dispatch, timeout=2)
                await asyncio.sleep(0)
                leaked = [
                    task
                    for task in asyncio.all_tasks()
                    if task not in baseline and task is not asyncio.current_task() and not task.done()
                ]
                self.assertEqual(leaked, [])
                self.assertFalse(cleanup_interrupted)
                self.assertEqual(cancellations, 1)
            finally:
                release_cleanup.set()
                if not dispatch.done():
                    dispatch.cancel()
                    await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_fallback_cancel_then_supervisor_cancel_joins_finally_once(self) -> None:
        async def run() -> None:
            app_waiting = asyncio.Event()
            cleanup_started = asyncio.Event()
            release_cleanup = asyncio.Event()
            cancellations = 0
            cleanup_interrupted = False

            async def app(scope: Any, receive: Any, send: Any) -> None:
                nonlocal cancellations, cleanup_interrupted
                try:
                    await receive()
                    app_waiting.set()
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancellations += 1
                    raise
                finally:
                    cleanup_started.set()
                    try:
                        await release_cleanup.wait()
                    except asyncio.CancelledError:
                        cleanup_interrupted = True
                        raise

            with patch.object(
                guest_module, "_DEFAULT_HTTP_DISCONNECT_GRACE_SECONDS", 0.01, create=True
            ):
                guest, _conn, events, dispatch = await self._dispatch(app, 97)
                try:
                    await events.put(h2.events.StreamEnded(stream_id=97))
                    await asyncio.wait_for(app_waiting.wait(), timeout=2)
                    await events.put(h2.events.StreamReset(stream_id=97, error_code=8))
                    await asyncio.wait_for(cleanup_started.wait(), timeout=2)
                    self.assertEqual(cancellations, 1)

                    dispatch.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(dispatch.done())
                    self.assertEqual(cancellations, 1)
                    self.assertFalse(cleanup_interrupted)

                    release_cleanup.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(dispatch, timeout=2)
                    self.assertEqual(cancellations, 1)
                    self.assertFalse(cleanup_interrupted)
                finally:
                    release_cleanup.set()
                    if not dispatch.done():
                        dispatch.cancel()
                        await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())

    def test_supervisor_cancellation_during_fallback_join_does_not_cancel_app_twice(self) -> None:
        async def run() -> None:
            app_waiting = asyncio.Event()
            cleanup_started = asyncio.Event()
            release_cleanup = asyncio.Event()
            cancellations = 0
            cleanup_interrupted = False

            async def app(scope: Any, receive: Any, send: Any) -> None:
                nonlocal cancellations, cleanup_interrupted
                try:
                    await receive()
                    app_waiting.set()
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancellations += 1
                    raise
                finally:
                    cleanup_started.set()
                    try:
                        await release_cleanup.wait()
                    except asyncio.CancelledError:
                        cleanup_interrupted = True
                        raise

            with patch.object(
                guest_module, "_DEFAULT_HTTP_DISCONNECT_GRACE_SECONDS", 0.01, create=True
            ):
                guest, _conn, events, dispatch = await self._dispatch(app, 96)
                try:
                    await events.put(h2.events.StreamEnded(stream_id=96))
                    await asyncio.wait_for(app_waiting.wait(), timeout=2)
                    await events.put(h2.events.StreamReset(stream_id=96, error_code=8))
                    await asyncio.wait_for(cleanup_started.wait(), timeout=2)
                    self.assertEqual(cancellations, 1)

                    dispatch.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(dispatch.done())
                    self.assertEqual(cancellations, 1)
                    self.assertFalse(cleanup_interrupted)

                    release_cleanup.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(dispatch, timeout=2)
                    self.assertEqual(cancellations, 1)
                    self.assertFalse(cleanup_interrupted)
                finally:
                    release_cleanup.set()
                    if not dispatch.done():
                        dispatch.cancel()
                        await asyncio.gather(dispatch, return_exceptions=True)

        asyncio.run(run())


class PendingStreamFailureTest(unittest.TestCase):
    """Tests for _collect_response_body and _wait_for_success_response
    handling of Exception and StreamReset events."""

    def test_collect_response_body_raises_on_connection_error(self) -> None:
        """Exception from _fail_pending_streams propagates through _collect_response_body."""

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="collect-exc"
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            # Put an Exception event into the queue
            guest._events[1].put_nowait(RuntimeError("connection lost"))
            with self.assertRaises(RuntimeError) as ctx:
                await guest._collect_response_body(1)
            self.assertIn("connection lost", str(ctx.exception))

        asyncio.run(run())

    def test_collect_response_body_raises_on_stream_reset(self) -> None:
        """StreamReset propagates through _collect_response_body as RuntimeError."""

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="collect-reset"
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            guest._events[1].put_nowait(
                h2.events.StreamReset(stream_id=1, error_code=0)
            )
            with self.assertRaises(RuntimeError) as ctx:
                await guest._collect_response_body(1)
            self.assertIn("reset", str(ctx.exception).lower())

        asyncio.run(run())

    def test_wait_for_success_response_raises_on_connection_error(self) -> None:
        """Exception from _fail_pending_streams propagates through _wait_for_success_response."""

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="wait-exc"
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            guest._events[1].put_nowait(RuntimeError("connection gone"))
            with self.assertRaises(RuntimeError) as ctx:
                await guest._wait_for_success_response(1)
            self.assertIn("connection gone", str(ctx.exception))

        asyncio.run(run())

    def test_wait_for_success_response_raises_on_stream_reset(self) -> None:
        """StreamReset propagates through _wait_for_success_response as RuntimeError."""

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="wait-reset"
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            guest._events[1].put_nowait(
                h2.events.StreamReset(stream_id=1, error_code=0)
            )
            with self.assertRaises(RuntimeError) as ctx:
                await guest._wait_for_success_response(1)
            self.assertIn("reset", str(ctx.exception).lower())

        asyncio.run(run())

    def test_collect_response_body_normal_path_unchanged(self) -> None:
        """Normal DataReceived + StreamEnded still works after exception handling."""

        async def run() -> bytes:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="collect-normal"
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            guest._events[1].put_nowait(
                h2.events.DataReceived(
                    stream_id=1, data=b"hello", flow_controlled_length=5
                )
            )
            guest._events[1].put_nowait(h2.events.StreamEnded(stream_id=1))
            return await guest._collect_response_body(1)

        result = asyncio.run(run())
        self.assertEqual(result, b"hello")

    def test_wait_for_success_response_normal_path_unchanged(self) -> None:
        """Normal 200 ResponseReceived still works after exception handling."""

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1", guest_id="wait-normal"
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            from unittest.mock import MagicMock

            mock_response = MagicMock(spec=h2.events.ResponseReceived)
            mock_response.headers = [(":status", "200")]
            mock_response.stream_id = 1
            guest._events[1].put_nowait(mock_response)
            await guest._wait_for_success_response(1)

        asyncio.run(run())


class LeasedStreamingTest(unittest.TestCase):
    """Tests for streaming request/response bodies through lease dispatch."""

    def test_lease_dispatch_streams_large_response_in_chunks(self) -> None:
        """Lease dispatch forwards a multi-chunk response without buffering."""
        chunk_size = 4096
        num_chunks = 16
        sends_received: list[tuple[int, bytes, bool]] = []

        async def app(scope: Any, receive: Any, send: Any) -> None:
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            for i in range(num_chunks):
                chunk = b"x" * chunk_size
                await send(
                    {
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": i < num_chunks - 1,
                    }
                )

        class InspectConn(FakeConn):
            def send_data(
                self, stream_id: int, data: bytes, end_stream: bool = False
            ) -> None:
                sends_received.append((stream_id, data, end_stream))
                super().send_data(stream_id, data, end_stream)

        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-large-resp",
                "sourceId": "broker-unit",
                "targetId": "large-resp-guest",
                "method": "GET",
                "path": "/large",
                "headers": {},
            },
        )

        async def run() -> int:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="large-resp-guest",
                app=app,
            )
            conn = InspectConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope,
                    flow_controlled_length=len(envelope),
                )
            )
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await asyncio.wait_for(task, timeout=10)
            return len(sends_received)

        total_sends = asyncio.run(run())
        # 1 response envelope + num_chunks body sends
        self.assertEqual(total_sends, 1 + num_chunks)
        # Last body send should have end_stream=True
        body_sends = [s for s in sends_received if s[1] != b"" or s[2]]
        last_body = body_sends[-1]
        self.assertTrue(last_body[2], "last body send must end stream")
        # Since body_chunks are 4096 each, total should be num_chunks * 4096
        # But the first http.response.body send might have the data embedded
        # Let's just verify the count is right
        self.assertEqual(
            sum(len(s[1]) for s in sends_received[1:]),  # all sends after first = body
            chunk_size * num_chunks,
        )

    def test_lease_dispatch_streams_large_request_body_in_chunks(self) -> None:
        """Lease dispatch forwards a large request body as multiple http.request events."""
        received_bytes = 0
        event_count = 0
        app_ready = asyncio.Event()
        chunk_size = 8192
        num_chunks = 12

        async def app(scope: Any, receive: Any, send: Any) -> None:
            nonlocal received_bytes, event_count
            app_ready.set()
            while True:
                event = await receive()
                received_bytes += len(event.get("body", b""))
                event_count += 1
                if not event.get("more_body", False):
                    break
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-large-body",
                "sourceId": "broker-unit",
                "targetId": "large-body-guest",
                "method": "POST",
                "path": "/large-body",
                "headers": {},
            },
        )

        async def run() -> tuple[int, int]:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="large-body-guest",
                app=app,
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            # Send envelope
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope,
                    flow_controlled_length=len(envelope),
                )
            )
            await asyncio.wait_for(app_ready.wait(), timeout=5)
            # Send body chunks one at a time (simulating H2 DATA frames)
            for _ in range(num_chunks):
                await guest._events[1].put(
                    h2.events.DataReceived(
                        stream_id=1,
                        data=b"x" * chunk_size,
                        flow_controlled_length=chunk_size,
                    )
                )
            # End stream
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await asyncio.wait_for(task, timeout=10)
            return received_bytes, event_count

        total_bytes, total_events = asyncio.run(run())
        self.assertEqual(total_bytes, chunk_size * num_chunks)
        # Events: body chunks + 1 terminal (more_body=False) from StreamEnded
        self.assertEqual(total_events, num_chunks + 1)

    def test_app_early_finish_does_not_hang(self) -> None:
        """App that finishes without consuming full request body does not hang/leak."""
        received_events = 0

        async def app(scope: Any, receive: Any, send: Any) -> None:
            nonlocal received_events
            # Consume only the first body event, then respond early
            event = await receive()
            received_events += 1
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"early-response"})

        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-early-finish",
                "sourceId": "broker-unit",
                "targetId": "early-finish-guest",
                "method": "POST",
                "path": "/early",
                "headers": {},
            },
        )

        async def run() -> None:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="early-finish-guest",
                app=app,
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            # Send envelope with first body chunk (remainder)
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope + b"first-chunk",
                    flow_controlled_length=len(envelope) + 11,
                )
            )
            await asyncio.sleep(0.02)
            # Send more body data and StreamEnded — app already finished
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=b"second-chunk",
                    flow_controlled_length=11,
                )
            )
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await asyncio.wait_for(task, timeout=5)
            # App only consumed one event (more_body from remainder)
            self.assertEqual(received_events, 1)

        asyncio.run(run())

    def test_data_received_after_early_finish_is_acknowledged(self) -> None:
        """DataReceived after app finishes is discarded but flow control is acked."""
        app_done = asyncio.Event()

        async def app(scope: Any, receive: Any, send: Any) -> None:
            # Consume first body, then finish the response
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})
            app_done.set()

        envelope = encode_envelope(
            "request",
            {
                "requestId": "req-early-ack",
                "sourceId": "broker-unit",
                "targetId": "early-ack-guest",
                "method": "POST",
                "path": "/early-ack",
                "headers": {},
            },
        )

        async def run() -> list[tuple[int, int]]:
            guest = create_verser_guest(
                host_url="https://127.0.0.1:1",
                guest_id="early-ack-guest",
                app=app,
            )
            conn = FakeConn()
            guest._conn = conn
            guest._events[1] = asyncio.Queue()
            task = asyncio.create_task(guest._dispatch_leased_request_stream(1))
            # Send envelope with first body chunk (remainder triggers receive)
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1,
                    data=envelope + b"first",
                    flow_controlled_length=len(envelope) + 5,
                )
            )
            # Wait for app to consume the first event and finish
            await asyncio.wait_for(app_done.wait(), timeout=5)
            # Send more body data — app already finished, must ack and discard
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1, data=b"second", flow_controlled_length=6
                )
            )
            await guest._events[1].put(
                h2.events.DataReceived(
                    stream_id=1, data=b"third", flow_controlled_length=5
                )
            )
            await guest._events[1].put(h2.events.StreamEnded(stream_id=1))
            await asyncio.wait_for(task, timeout=5)
            # ACKs are now inline, so conn.acknowledged is populated before task completes
            return conn.acknowledged

        acknowledged = asyncio.run(run())
        # ack #1: receive() acks envelope+first (pending_metadata_flow_controlled_length)
        # ack #2: discard ack for "second" (6 bytes)
        # ack #3: discard ack for "third" (5 bytes)
        self.assertEqual(len(acknowledged), 3)
        # total acked bytes: envelope + "first" + "second" + "third"
        total_acked = sum(fcl for _, fcl in acknowledged)
        self.assertEqual(total_acked, len(envelope) + 5 + 6 + 5)


def _is_envelope(data: bytes) -> bool:
    """Check if *data* looks like a Verser envelope (vs raw body bytes)."""
    return len(data) > 6 and data[0] == 1 and data[1] in (1, 2, 3)


if __name__ == "__main__":
    unittest.main()

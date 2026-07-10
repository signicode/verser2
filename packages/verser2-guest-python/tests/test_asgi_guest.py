import asyncio
import builtins
import json
import struct
import unittest
from io import BytesIO
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import h2.events

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
    def __init__(self, events=None):
        self.events = list(events or [])
        self.acknowledged = []
        self.sent_data = []

    def receive_data(self, _data):
        return list(self.events)

    def acknowledge_received_data(self, flow_controlled_length, stream_id):
        self.acknowledged.append((stream_id, flow_controlled_length))

    def send_data(self, stream_id, data, end_stream=False):
        self.sent_data.append((stream_id, data, end_stream))

    def data_to_send(self):
        return b""


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

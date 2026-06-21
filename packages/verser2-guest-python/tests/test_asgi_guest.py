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
    def test_dispatch_routed_request_builds_http_scope_and_returns_response(self) -> None:
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

    def test_app_exception_before_response_start_returns_local_handler_failure(self) -> None:
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

    def test_dispatch_routed_request_collects_streamed_response_body_chunks(self) -> None:
        async def app(scope, receive, send):
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 202,
                    "headers": [(b"x-stream", b"yes")],
                }
            )
            await send({"type": "http.response.body", "body": b"one-", "more_body": True})
            await send({"type": "http.response.body", "body": b"two", "more_body": False})

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
            await send({"type": "http.response.body", "body": b"abcd", "more_body": True})
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
        self.assertIn("response body bytes exceed limit", response.error["message"].lower())

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
        self.assertEqual(normalize_headers({"x-list": ["one", "two"]}), {"x-list": "one,two"})

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

    def test_sanitize_http2_response_headers_strips_connection_named_headers(self) -> None:
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
            {"content-type": "application/json", "content-length": "42", "x-custom": "value"}
        )
        self.assertEqual(sanitized.get("content-type"), "application/json")
        self.assertEqual(sanitized.get("content-length"), "42")
        self.assertEqual(sanitized.get("x-custom"), "value")


class LeaseTaskTest(unittest.TestCase):
    def test_read_loop_does_not_ack_request_body_data_on_frame_receipt(self) -> None:
        async def run() -> list[tuple[int, int]]:
            event = h2.events.DataReceived(stream_id=1, data=b"body", flow_controlled_length=7)
            guest = create_verser_guest(host_url="https://127.0.0.1:1", guest_id="ack-delay")
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
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"ok", "more_body": False})

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
            guest = create_verser_guest(host_url="https://127.0.0.1:1", guest_id="ack-after-receive", app=app)
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

        self.assertEqual(asyncio.run(run()), [(1, len(encode_envelope("request", {"requestId": "req-ack-after-receive", "sourceId": "broker-unit", "targetId": "ack-after-receive", "method": "POST", "path": "/ack", "headers": {}})) + len(b"payload"))])

    def test_completed_lease_tasks_are_pruned(self) -> None:
        async def run() -> int:
            guest = create_verser_guest(host_url="https://127.0.0.1:1", guest_id="task-prune")

            async def complete_lease() -> None:
                return None

            guest._open_lease_stream = complete_lease
            guest._start_lease_task()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return len(guest._lease_tasks)

        self.assertEqual(asyncio.run(run()), 0)


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
            with patch("asyncio.open_connection", side_effect=self._mock_open_connection()):
                with patch.object(type(guest), "_register", new=AsyncMock()):
                    with patch.object(type(guest), "_open_control_stream", new=AsyncMock()):
                        with patch.object(type(guest), "_start_lease_task", new=MagicMock()):
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
            with patch("asyncio.open_connection", side_effect=self._mock_open_connection()):
                with patch.object(type(guest), "_register", new=AsyncMock()):
                    with patch.object(type(guest), "_open_control_stream", new=AsyncMock()):
                        with patch.object(type(guest), "_start_lease_task", new=MagicMock()):
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

        with patch("tempfile.NamedTemporaryFile", return_value=FakeTemporaryFile()) as temp_file:
            with patch("os.unlink") as unlink:
                with patch.object(builtins, "open", return_value=BytesIO(b"pfx-bytes")):
                    with patch(
                        "cryptography.hazmat.primitives.serialization.pkcs12.load_key_and_certificates",
                        return_value=(fake_key, fake_certificate, []),
                    ):
                        guest._load_pfx_client_identity(ssl_context, "/client.pfx", "secret")

        temp_file.assert_called_once_with("wb", delete=False)
        ssl_context.load_cert_chain.assert_called_once_with("/tmp/verser-python-guest-client.pem")
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
            with patch("asyncio.open_connection", side_effect=OSError("Connection refused")):
                with self.assertRaises(Exception) as context:
                    self._run(guest.connect())

        message = str(context.exception).lower()
        self.assertTrue(any(word in message for word in ("tls", "handshake")))


if __name__ == "__main__":
    unittest.main()

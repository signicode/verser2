import asyncio
import json
import struct
import unittest

import h2.events

from verser2_guest_python import create_verser_guest
from verser2_guest_python.protocol import decode_envelope, encode_envelope, normalize_headers


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


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import struct
import unittest

from verser2_guest_python import create_verser_guest
from verser2_guest_python.protocol import encode_envelope


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


if __name__ == "__main__":
    unittest.main()

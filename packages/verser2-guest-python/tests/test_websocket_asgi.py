"""Acceptance tests for ASGI websocket scope support.

These tests describe the expected ASGI websocket scope and dispatch API
shapes. They currently fail because the implementation does not exist
yet. They will pass once Python ASGI Guest websocket scope support is
implemented in Phase 4.
"""

import asyncio
import unittest


class TestWebSocketAsgiScope(unittest.TestCase):
    """Tests for build_websocket_scope — expected to fail before implementation."""

    def test_build_websocket_scope_produces_correct_asgi_websocket_scope(
        self,
    ) -> None:
        """build_websocket_scope produces a valid ASGI websocket scope dict."""
        # Import will raise ImportError until the function is implemented.
        from verser2_guest_python.asgi import build_websocket_scope

        metadata = {
            "requestId": "req-ws-scope",
            "sourceId": "broker-unit",
            "targetId": "ws-scope-guest",
            "method": "GET",
            "path": "/ws/chat?token=abc",
            "headers": {
                "sec-websocket-protocol": "vws.base64",
                "x-custom": "value",
            },
        }

        scope = build_websocket_scope(metadata, b"")

        self.assertEqual(scope["type"], "websocket")
        self.assertEqual(scope["asgi"]["version"], "3.0")
        self.assertEqual(scope["asgi"]["spec_version"], "2.5")
        self.assertEqual(scope["scheme"], "ws")
        self.assertEqual(scope["path"], "/ws/chat")
        self.assertEqual(scope["query_string"], b"token=abc")
        self.assertEqual(scope["root_path"], "")
        self.assertIsNone(scope.get("client"))
        self.assertIsNone(scope.get("server"))
        self.assertIsNone(scope.get("extensions"))
        self.assertIn(
            (b"sec-websocket-protocol", b"vws.base64"),
            scope["headers"],
        )
        self.assertIn(
            (b"x-custom", b"value"),
            scope["headers"],
        )

    def test_asgi_app_receives_websocket_connect_accepts_exchanges_messages_closes(
        self,
    ) -> None:
        """A full ASGI websocket lifecycle through the dispatch helper."""
        from verser2_guest_python.asgi import (
            build_websocket_scope,
            dispatch_asgi_websocket,
        )

        events: list[tuple[str, object]] = []

        async def app(
            scope: object,
            receive: object,
            send: object,
        ) -> None:
            # 1. Receive websocket.connect
            event = await receive()
            events.append(("received", event))

            # 2. Accept the connection
            await send({"type": "websocket.accept", "subprotocol": "vws.base64"})

            # 3. Receive a text message
            event = await receive()
            events.append(("received", event))

            # 4. Send a text reply
            await send({"type": "websocket.send", "text": "echo: hello"})

            # 5. Receive a binary message
            event = await receive()
            events.append(("received", event))

            # 6. Send a binary reply
            await send({"type": "websocket.send", "bytes": b"\x00\xff\x7f"})

            # 7. Receive disconnect / close
            event = await receive()
            events.append(("received", event))

        metadata = {
            "requestId": "req-ws-lifecycle",
            "sourceId": "broker-unit",
            "targetId": "ws-lifecycle-guest",
            "method": "GET",
            "path": "/ws/lifecycle",
            "headers": {"sec-websocket-protocol": "vws.base64"},
        }

        async def run_test() -> None:
            await dispatch_asgi_websocket(
                app=app,
                guest_id="ws-lifecycle-guest",
                metadata=metadata,
            )

        asyncio.run(run_test())

        # Verify the event sequence
        self.assertEqual(events[0][1]["type"], "websocket.connect")
        self.assertEqual(events[1][1]["type"], "websocket.receive")
        self.assertEqual(events[1][1]["text"], "hello")
        self.assertEqual(events[2][1]["type"], "websocket.receive")
        self.assertEqual(events[2][1]["bytes"], b"\x00\xff\x7f")
        # The app may receive websocket.disconnect or websocket.close
        self.assertIn(events[3][1]["type"], ["websocket.disconnect", "websocket.close"])

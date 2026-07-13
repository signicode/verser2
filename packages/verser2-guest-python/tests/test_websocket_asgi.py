"""Acceptance tests for Python ASGI VWS/1 websocket support."""

import asyncio
import json
import unittest

import h2.events
from unittest.mock import AsyncMock, MagicMock

from verser2_guest_python import create_verser_guest
from verser2_guest_python.asgi import VwsAsgiConnection


class TestWebSocketAsgiScope(unittest.TestCase):
    """Tests for the ASGI websocket scope and helper lifecycle."""

    def test_build_websocket_scope_produces_correct_asgi_websocket_scope(
        self,
    ) -> None:
        """build_websocket_scope produces a valid ASGI websocket scope dict."""
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


class TestLiveGuestWebSocketLease(unittest.TestCase):
    """Exercise the Guest lease dispatcher rather than helper-only APIs."""

    def test_live_vws_lease_drives_asgi_text_binary_and_close(self) -> None:
        sent: list[dict] = []
        send_calls: list[tuple[bytes, bool]] = []
        received: list[dict] = []

        async def app(scope, receive, send):
            self.assertEqual(scope["type"], "websocket")
            received.append(await receive())
            await send({"type": "websocket.accept", "subprotocol": "vws.test"})
            received.append(await receive())
            await send({"type": "websocket.send", "text": "reply"})
            received.append(await receive())
            await send({"type": "websocket.send", "bytes": b"\x00\xff"})
            received.append(await receive())
            await send({"type": "websocket.close", "code": 1000, "reason": "done"})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="live-ws-guest", app=app
        )
        guest._conn = MagicMock()
        guest._events[1] = asyncio.Queue()

        async def send_data(_stream_id, data, _end_stream):
            send_calls.append((data, _end_stream))
            sent.extend(json.loads(line) for line in data.splitlines())

        guest._send_data = send_data
        guest._events[1].put_nowait(
            h2.events.DataReceived(
                stream_id=1,
                data=(
                    b'{"type":"open","domain":"live.local","path":"/socket","protocol":"vws.test"}\n'
                    b'{"type":"text","data":"hello"}\n'
                    b'{"type":"binary","data":"AP8="}\n'
                    b'{"type":"close","code":1000,"reason":"peer"}\n'
                ),
                flow_controlled_length=100,
            )
        )

        asyncio.run(guest._read_websocket_lease(1))
        self.assertEqual(
            [event["type"] for event in received],
            [
                "websocket.connect",
                "websocket.receive",
                "websocket.receive",
                "websocket.disconnect",
            ],
        )
        self.assertEqual(received[1]["text"], "hello")
        self.assertEqual(received[2]["bytes"], b"\x00\xff")
        self.assertEqual(
            sorted(frame["type"] for frame in sent),
            ["accept", "binary", "close", "close", "text"],
        )
        self.assertTrue(any(end_stream and not data for data, end_stream in send_calls))

    def test_live_vws_lease_reset_delivers_asgi_abnormal_disconnect(self) -> None:
        disconnected: list[dict] = []

        async def app(_scope, receive, send):
            await receive()
            await send({"type": "websocket.accept"})
            disconnected.append(await receive())

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="live-ws-reset", app=app
        )
        guest._conn = MagicMock()
        guest._events[2] = asyncio.Queue()
        guest._send_data = lambda *_args: asyncio.sleep(0)
        guest._events[2].put_nowait(
            h2.events.DataReceived(
                stream_id=2,
                data=b'{"type":"open","domain":"reset.local","path":"/"}\n',
                flow_controlled_length=1,
            )
        )
        guest._events[2].put_nowait(h2.events.StreamReset(stream_id=2, error_code=8))

        asyncio.run(guest._read_websocket_lease(2))
        self.assertEqual(disconnected[0]["type"], "websocket.disconnect")
        self.assertEqual(disconnected[0]["code"], 1006)

    def test_close_validation_rejects_reserved_codes_and_invalid_remote_close(
        self,
    ) -> None:
        sent: list[dict] = []

        async def run() -> None:
            connection = VwsAsgiConnection(lambda frame: _record(sent, frame))
            with self.assertRaises(ValueError):
                await connection.send({"type": "websocket.close", "code": 1006})
            with self.assertRaises(ValueError):
                await connection.send({"type": "websocket.send", "text": 42})
            with self.assertRaises(ValueError):
                await connection.send({"type": "websocket.send", "bytes": "not-bytes"})
            with self.assertRaises(ValueError):
                await connection.send({"type": "websocket.close", "code": True})
            await connection.feed({"type": "close", "code": 1006, "reason": "invalid"})
            self.assertTrue(connection.close_sent)

        async def _run() -> None:
            await run()

        async def _record_async(frame: dict) -> None:
            sent.append(frame)

        def _record(target: list[dict], frame: dict):
            target.append(frame)
            return _record_async(frame)

        asyncio.run(_run())
        self.assertEqual(sent[-1]["code"], 1002)

    def test_asgi_selected_subprotocol_must_be_offered(self) -> None:
        sent: list[dict] = []

        async def record(frame: dict) -> None:
            sent.append(frame)

        async def run() -> None:
            connection = VwsAsgiConnection(
                record,
                offered_protocols=["vws.one", "vws.two"],
            )
            await connection.send({"type": "websocket.accept"})
            await connection.send(
                {"type": "websocket.accept", "subprotocol": "vws.two"}
            )
            with self.assertRaises(ValueError):
                await connection.send(
                    {"type": "websocket.accept", "subprotocol": "vws.other"}
                )

        asyncio.run(run())
        self.assertEqual([frame["protocol"] for frame in sent], ["", "vws.two"])

    def test_app_ignoring_disconnect_is_cancelled_after_reset(self) -> None:
        cancelled = False

        async def app(_scope, receive, send):
            nonlocal cancelled
            await receive()
            await send({"type": "websocket.accept"})
            try:
                while True:
                    await asyncio.sleep(10)
            except asyncio.CancelledError:
                cancelled = True
                raise

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="live-ws-ignore", app=app
        )
        guest._conn = MagicMock()
        guest._events[3] = asyncio.Queue()
        guest._send_data = lambda *_args: asyncio.sleep(0)
        guest._events[3].put_nowait(
            h2.events.DataReceived(
                stream_id=3,
                data=b'{"type":"open","domain":"ignore.local","path":"/"}\n',
                flow_controlled_length=1,
            )
        )
        guest._events[3].put_nowait(h2.events.StreamReset(stream_id=3, error_code=8))
        asyncio.run(guest._read_websocket_lease(3))
        self.assertTrue(cancelled)


class TestVwsOpenValidation(unittest.TestCase):
    """VWS OPEN frame schema validation in _read_websocket_lease."""

    def _guest_with_app(self, app):
        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="vws-open-val", app=app
        )
        guest._conn = MagicMock()
        guest._events[10] = asyncio.Queue()
        guest._send_data = lambda *_args: asyncio.sleep(0)
        return guest, 10

    def test_valid_open_passes_validation(self) -> None:
        received = []

        async def app(scope, receive, send):
            received.append(await receive())
            await send({"type": "websocket.accept"})
            received.append(await receive())
            await send({"type": "websocket.close", "code": 1000})

        guest, sid = self._guest_with_app(app)
        guest._events[sid].put_nowait(
            h2.events.DataReceived(
                stream_id=sid,
                data=b'{"type":"open","domain":"valid.local","path":"/ok","protocol":"vws.test"}\n'
                b'{"type":"text","data":"hello"}\n'
                b'{"type":"close","code":1000}\n',
                flow_controlled_length=1,
            )
        )
        asyncio.run(guest._read_websocket_lease(sid))
        self.assertEqual(received[1]["text"], "hello")

    def test_missing_domain_rejected(self) -> None:
        sent_frames: list[bytes] = []

        async def record_send(sid, data, end_stream):
            sent_frames.append(data)

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="vws-no-domain"
        )
        guest._conn = MagicMock()
        guest._events[11] = asyncio.Queue()
        guest._send_data = record_send
        guest._events[11].put_nowait(
            h2.events.DataReceived(
                stream_id=11,
                data=b'{"type":"open","path":"/x"}\n',
                flow_controlled_length=1,
            )
        )
        asyncio.run(guest._read_websocket_lease(11))
        close_lines = [json.loads(line) for line in b"".join(sent_frames).splitlines()]
        self.assertEqual(close_lines[-1]["type"], "close")
        self.assertEqual(close_lines[-1]["code"], 1002)

    def test_empty_domain_rejected(self) -> None:
        sent_frames: list[bytes] = []

        async def record_send(sid, data, end_stream):
            sent_frames.append(data)

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="vws-empty-domain"
        )
        guest._conn = MagicMock()
        guest._events[12] = asyncio.Queue()
        guest._send_data = record_send
        guest._events[12].put_nowait(
            h2.events.DataReceived(
                stream_id=12,
                data=b'{"type":"open","domain":"","path":"/"}\n',
                flow_controlled_length=1,
            )
        )
        asyncio.run(guest._read_websocket_lease(12))
        close_lines = [json.loads(line) for line in b"".join(sent_frames).splitlines()]
        self.assertEqual(close_lines[-1]["type"], "close")
        self.assertEqual(close_lines[-1]["code"], 1002)

    def test_non_string_domain_rejected(self) -> None:
        sent_frames: list[bytes] = []

        async def record_send(sid, data, end_stream):
            sent_frames.append(data)

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="vws-int-domain"
        )
        guest._conn = MagicMock()
        guest._events[13] = asyncio.Queue()
        guest._send_data = record_send
        guest._events[13].put_nowait(
            h2.events.DataReceived(
                stream_id=13,
                data=b'{"type":"open","domain":42,"path":"/"}\n',
                flow_controlled_length=1,
            )
        )
        asyncio.run(guest._read_websocket_lease(13))
        close_lines = [json.loads(line) for line in b"".join(sent_frames).splitlines()]
        self.assertEqual(close_lines[-1]["type"], "close")
        self.assertEqual(close_lines[-1]["code"], 1002)

    def test_non_string_path_rejected(self) -> None:
        sent_frames: list[bytes] = []

        async def record_send(sid, data, end_stream):
            sent_frames.append(data)

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="vws-int-path"
        )
        guest._conn = MagicMock()
        guest._events[14] = asyncio.Queue()
        guest._send_data = record_send
        guest._events[14].put_nowait(
            h2.events.DataReceived(
                stream_id=14,
                data=b'{"type":"open","domain":"x","path":false}\n',
                flow_controlled_length=1,
            )
        )
        asyncio.run(guest._read_websocket_lease(14))
        close_lines = [json.loads(line) for line in b"".join(sent_frames).splitlines()]
        self.assertEqual(close_lines[-1]["type"], "close")
        self.assertEqual(close_lines[-1]["code"], 1002)

    def test_non_string_protocol_rejected(self) -> None:
        sent_frames: list[bytes] = []

        async def record_send(sid, data, end_stream):
            sent_frames.append(data)

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="vws-int-protocol"
        )
        guest._conn = MagicMock()
        guest._events[15] = asyncio.Queue()
        guest._send_data = record_send
        guest._events[15].put_nowait(
            h2.events.DataReceived(
                stream_id=15,
                data=b'{"type":"open","domain":"x","protocol":42}\n',
                flow_controlled_length=1,
            )
        )
        asyncio.run(guest._read_websocket_lease(15))
        close_lines = [json.loads(line) for line in b"".join(sent_frames).splitlines()]
        self.assertEqual(close_lines[-1]["type"], "close")
        self.assertEqual(close_lines[-1]["code"], 1002)


class TestWebSocketCloseFinalization(unittest.TestCase):
    """Regression tests for VWS close/finalization — _reset_stream in
    oversized post-close input must set h2_ended to prevent
    _send_data(..., end_stream=True) on an already-reset stream."""

    def test_oversized_post_close_resets_stream_and_marks_h2_ended(self) -> None:
        """Oversized frame after close sends _reset_stream and sets
        h2_ended=True so finally cleanup does not call _send_data on a
        reset stream.

        We queue the open+text frame synchronously, then use
        asyncio.create_task to let the dispatch start, then inject an
        oversized DataReceived event into the post-close loop."""
        send_calls: list[tuple[int, bytes, bool]] = []

        async def app(scope, receive, send):
            await receive()
            await send({"type": "websocket.accept"})
            await receive()
            await send({"type": "websocket.close", "code": 1000})

        guest = create_verser_guest(
            host_url="https://127.0.0.1:1", guest_id="ws-close-reset", app=app
        )
        guest._conn = MagicMock()
        guest._events[4] = asyncio.Queue()

        async def fake_send_data(sid, data, end_stream):
            send_calls.append((sid, data, end_stream))

        guest._send_data = fake_send_data
        guest._reset_stream = AsyncMock()
        # Queue the initial open + text frame (small, under max).  After
        # dispatch the app sends close and the dispatcher enters the
        # post-close loop waiting for the next h2 event.
        guest._events[4].put_nowait(
            h2.events.DataReceived(
                stream_id=4,
                data=b'{"type":"open","domain":"close.local","path":"/"}\n'
                b'{"type":"text","data":"mini"}\n',
                flow_controlled_length=1,
            )
        )

        async def run() -> None:
            # Start the dispatch task
            task = asyncio.create_task(guest._read_websocket_lease(4))
            # Yield to let the app process connect/accept/text and send close
            await asyncio.sleep(0.01)
            # The app has sent close and the main loop is blocked on
            # self._events[4].get().  Queue a non-oversized DataReceived
            # first to unblock the main loop — the main loop will check
            # app_task.done(), see it is True, and exit.
            guest._events[4].put_nowait(
                h2.events.DataReceived(
                    stream_id=4,
                    data=b'{"type":"text","data":"trailing"}\n',
                    flow_controlled_length=1,
                )
            )
            # Then queue an oversized DataReceived.  Because the main
            # loop has already exited (app_task done), this event
            # arrives in the *post-close* loop, where the oversized
            # check calls _reset_stream and (with our fix) sets
            # h2_ended = True.
            guest._events[4].put_nowait(
                h2.events.DataReceived(
                    stream_id=4,
                    data=b"x" * (1024 * 1024 + 1),  # > VWS_MAX_FRAME_BYTES
                    flow_controlled_length=1,
                )
            )
            await asyncio.wait_for(task, timeout=5)

        asyncio.run(run())
        guest._reset_stream.assert_called()
        # Verify no _send_data call has end_stream=True after the reset.
        for sid, data, end_stream in send_calls:
            if end_stream and not data:
                self.fail(
                    "Found _send_data(stream_id=%s, b'', True) on potentially "
                    "reset stream — h2_ended was not set" % sid
                )

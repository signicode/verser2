import asyncio
import json
import unittest

import h2.events
from unittest.mock import MagicMock

from verser2_guest_python import (
    VerserBrokerWebSocket,
    VerserWebSocketError,
    create_verser_broker,
)


class BrokerWebSocketTest(unittest.TestCase):
    def broker(self):
        broker = create_verser_broker(
            host_url="https://127.0.0.1", broker_id="python-ws-broker"
        )
        broker._routes = [{"targetId": "python-ws-guest", "domain": "ws.local"}]
        return broker

    def run_async(self, coroutine):
        return asyncio.run(coroutine)

    def test_public_websocket_preserves_vws_boundaries_and_controls(self):
        broker = self.broker()
        broker._conn = MagicMock()
        sent = []

        async def send_headers(
            _headers, *, end_stream, create_queue=True, queue_maxsize=None
        ):
            self.assertFalse(end_stream)
            broker._events[7] = asyncio.Queue(maxsize=64)
            broker._events[7].put_nowait(
                h2.events.ResponseReceived(
                    stream_id=7,
                    headers=[(":status", "200"), ("x-verser-ws-protocol", "vws.test")],
                )
            )
            return 7

        async def send_data(stream_id, data, end_stream):
            sent.append((stream_id, data, end_stream))

        async def run():
            broker._send_headers = send_headers
            broker._send_data = send_data
            websocket = await broker.websocket(
                "http://ws.local/socket?room=one", protocol="vws.test"
            )
            self.assertEqual(websocket.protocol, "vws.test")
            await websocket.send_text("hello")
            await websocket.send_bytes(b"\x00\xff")
            await websocket.ping("nonce")
            await websocket.pong("reply")
            frames = [json.loads(data.decode().strip()) for _, data, _ in sent]
            self.assertEqual(
                [frame["type"] for frame in frames],
                ["text", "binary", "ping", "pong"],
            )
            self.assertEqual(frames[0]["data"], "hello")
            self.assertEqual(frames[1]["data"], "AP8=")
            broker._events[7].put_nowait(
                h2.events.DataReceived(
                    stream_id=7,
                    data=b'{"type":"text","data":"reply"}\n'
                    b'{"type":"binary","data":"AP8="}\n',
                    flow_controlled_length=1,
                )
            )
            self.assertEqual(
                await websocket.receive(), {"type": "text", "data": "reply"}
            )
            self.assertEqual(
                await websocket.receive(), {"type": "binary", "data": b"\x00\xff"}
            )
            await websocket.close(1000, "done")
            self.assertTrue(websocket.closed)

        self.run_async(run())

    def test_structured_unavailable_and_missing_negotiation_errors(self):
        async def run():
            for code in ("missing-guest", "websocket-negotiation-failed"):
                broker = self.broker()
                broker._conn = MagicMock()
                broker._events[8] = asyncio.Queue(maxsize=64)
                broker._events[8].put_nowait(
                    h2.events.ResponseReceived(
                        stream_id=8, headers=[(":status", "502")]
                    )
                )
                broker._events[8].put_nowait(
                    h2.events.DataReceived(
                        stream_id=8,
                        data=json.dumps(
                            {
                                "error": {
                                    "code": code,
                                    "message": code,
                                    "context": {
                                        "domain": "ws.local",
                                        "targetId": "python-ws-guest",
                                    },
                                }
                            }
                        ).encode(),
                        flow_controlled_length=1,
                    )
                )
                broker._events[8].put_nowait(h2.events.StreamEnded(stream_id=8))
                broker._send_headers = AsyncMockHeaders(8)
                with self.assertRaises(Exception) as caught:
                    await broker.websocket("http://ws.local/socket")
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(caught.exception.context["domain"], "ws.local")

        self.run_async(run())

    def test_malformed_frame_finalizes_socket_and_unblocks_repeated_abort(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[9] = asyncio.Queue(maxsize=64)

        async def run():
            broker._send_data = AsyncMockSend()
            websocket = VerserBrokerWebSocket(broker, 9, "")
            broker._events[9].put_nowait(
                h2.events.DataReceived(
                    stream_id=9, data=b"not-json\n", flow_controlled_length=1
                )
            )
            with self.assertRaises(VerserWebSocketError) as caught:
                await websocket.receive()
            self.assertEqual(caught.exception.code, "protocol-error")
            self.assertNotIn(9, broker._events)
            await websocket.abort()

        self.run_async(run())

    def test_outbound_queue_reserves_before_payload_and_waiter_cancels_per_stream(self):
        broker = self.broker()

        class FlowControlledConnection:
            max_outbound_frame_size = 16

            def local_flow_control_window(self, _stream_id):
                return 0

            def data_to_send(self):
                return b""

        broker._conn = FlowControlledConnection()
        broker._events[12] = asyncio.Queue(maxsize=64)

        async def run():
            websocket = VerserBrokerWebSocket(broker, 12, "")
            first = asyncio.create_task(websocket.send_bytes(b"payload"))
            await asyncio.sleep(0)
            self.assertIn(12, broker._window_waiters)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            self.assertNotIn(12, broker._window_waiters)

        self.run_async(run())

    def test_error_response_collection_is_bounded(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[13] = asyncio.Queue(maxsize=64)
        broker._events[13].put_nowait(
            h2.events.DataReceived(
                stream_id=13, data=b"x" * (128 * 1024), flow_controlled_length=1
            )
        )
        broker._events[13].put_nowait(h2.events.StreamEnded(stream_id=13))

        async def run():
            body = await broker._collect_error_response_body(13)
            self.assertEqual(len(body), 64 * 1024)

        self.run_async(run())

    def test_negotiation_cancellation_resets_and_removes_transport_queue(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[14] = asyncio.Queue(maxsize=64)
        reset = AsyncMockSend()

        async def run():
            async def headers(*_args, **_kwargs):
                return 14

            async def reset_stream(stream_id):
                reset.calls.append(stream_id)

            broker._send_headers = headers
            broker._reset_stream = reset_stream
            task = asyncio.create_task(broker.websocket("http://ws.local/socket"))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(reset.calls, [14])
            self.assertNotIn(14, broker._events)

        reset.calls = []
        self.run_async(run())

    def test_background_pump_observes_peer_close_without_public_receive(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[15] = asyncio.Queue(maxsize=64)
        sent = []

        async def run():
            async def send_data(_stream_id, data, _end_stream):
                sent.append(json.loads(data.decode()))

            broker._send_data = send_data
            ws = VerserBrokerWebSocket(broker, 15, "")
            broker._events[15].put_nowait(
                h2.events.DataReceived(
                    stream_id=15,
                    data=b'{"type":"close","code":1000,"reason":"peer"}\n',
                    flow_controlled_length=1,
                )
            )
            for _ in range(20):
                if ws._peer_close_waiter is not None:
                    break
                await asyncio.sleep(0)
            await asyncio.wait_for(ws._peer_close_waiter, 1)
            self.assertTrue(ws.closed)
            event = await ws.receive()
            self.assertEqual(event["type"], "close")
            self.assertEqual(event["code"], 1000)
            self.assertEqual(event["reason"], "peer")
            self.assertEqual(broker._events, {})

        self.run_async(run())

    def test_pump_terminal_transport_error_finalizes_once_and_unregisters(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[18] = asyncio.Queue(maxsize=64)

        async def run():
            ws = VerserBrokerWebSocket(broker, 18, "")
            broker._events[18].put_nowait(RuntimeError("transport failed"))
            with self.assertRaises(VerserWebSocketError) as caught:
                await ws.receive()
            self.assertEqual(caught.exception.code, "disconnected-target")
            self.assertTrue(ws.closed)
            self.assertNotIn(18, broker._events)
            self.assertNotIn(ws, broker._websockets)
            await ws.abort()

        self.run_async(run())

    def test_close_peer_timeout_resets_and_leaves_no_stream_state(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[16] = asyncio.Queue(maxsize=64)
        sent = []

        async def run():
            async def send_data(_stream_id, data, _end_stream):
                sent.append(json.loads(data.decode()))

            broker._send_data = send_data
            ws = VerserBrokerWebSocket(broker, 16, "")
            await ws.close(1000, "timeout")
            self.assertEqual(sent[0]["type"], "close")
            self.assertEqual(sent[0]["code"], 1000)
            self.assertTrue(ws.closed)
            self.assertNotIn(16, broker._events)

        self.run_async(run())

    def test_socket_event_queue_overflow_sends_1009_before_reset(self):
        broker = self.broker()
        broker._conn = MagicMock()
        broker._events[17] = asyncio.Queue(maxsize=64)
        sent = []

        async def run():
            async def send_data(_stream_id, data, _end_stream):
                sent.append(json.loads(data.decode()))

            broker._send_data = send_data
            ws = VerserBrokerWebSocket(broker, 17, "")
            ws._incoming = asyncio.Queue(maxsize=1)
            broker._events[17].put_nowait(
                h2.events.DataReceived(
                    stream_id=17,
                    data=b'{"type":"text","data":"a"}\n{"type":"text","data":"b"}\n',
                    flow_controlled_length=1,
                )
            )
            await asyncio.sleep(0.02)
            self.assertTrue(ws.closed)
            self.assertTrue(any(frame["code"] == 1009 for frame in sent))
            self.assertNotIn(17, broker._events)

        self.run_async(run())


class AsyncMockSend:
    async def __call__(self, _stream_id, _data, _end_stream):
        return None


class AsyncMockHeaders:
    def __init__(self, stream_id):
        self.stream_id = stream_id

    async def __call__(
        self, _headers, *, end_stream, create_queue=True, queue_maxsize=None
    ):
        return self.stream_id

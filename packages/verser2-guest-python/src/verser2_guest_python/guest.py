"""Minimal outbound HTTP/2 Verser Guest for ASGI applications."""

from __future__ import annotations

import asyncio
import json
import ssl
from typing import Any
from urllib.parse import urlsplit

import h2.connection
import h2.config
import h2.events

from .asgi import ASGIApp, DispatchResponse, dispatch_asgi_request
from .protocol import decode_envelope, encode_envelope, normalize_headers


class VerserGuest:
    def __init__(
        self,
        *,
        host_url: str,
        guest_id: str,
        app: ASGIApp | None = None,
        routed_domains: list[str] | None = None,
        tls_ca_file: str | None = None,
        min_waiting_streams: int = 1,
    ) -> None:
        self.host_url = host_url
        self.guest_id = guest_id
        self.app = app
        self.routed_domains = routed_domains or []
        self.tls_ca_file = tls_ca_file
        self.min_waiting_streams = max(1, min_waiting_streams)
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._conn: h2.connection.H2Connection | None = None
        self._events: dict[int, asyncio.Queue[Any]] = {}
        self._io_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._lease_counter = 0
        self._lease_tasks: list[asyncio.Task[None]] = []
        self._closed = False

    def attach(self, app: ASGIApp, domain: str | None = None) -> "VerserGuest":
        self.app = app
        if domain is not None:
            self.routed_domains = [domain]
        return self

    async def dispatch_routed_request(
        self, metadata: dict[str, Any], body: bytes
    ) -> DispatchResponse:
        if self.app is None:
            return DispatchResponse(
                request_id=str(metadata.get("requestId") or ""),
                error={
                    "requestId": str(metadata.get("requestId") or ""),
                    "code": "local-handler-failure",
                    "message": "No ASGI app is attached",
                    "context": {
                        "guestId": self.guest_id,
                        "requestId": str(metadata.get("requestId") or ""),
                    },
                },
            )
        return await dispatch_asgi_request(self.app, self.guest_id, metadata, body)

    async def connect(self) -> None:
        if self._conn is not None:
            return
        parsed = urlsplit(self.host_url)
        context = ssl.create_default_context(cafile=self.tls_ca_file)
        context.set_alpn_protocols(["h2"])
        reader, writer = await asyncio.open_connection(
            parsed.hostname,
            parsed.port or 443,
            ssl=context,
            server_hostname=parsed.hostname,
        )
        self._reader = reader
        self._writer = writer
        self._conn = h2.connection.H2Connection(
            config=h2.config.H2Configuration(client_side=True, header_encoding="utf-8")
        )
        self._conn.initiate_connection()
        await self._flush()
        self._reader_task = asyncio.create_task(self._read_loop())
        await self._register()
        await self._open_control_stream()
        for _ in range(self.min_waiting_streams):
            self._lease_tasks.append(asyncio.create_task(self._open_lease_stream()))

    async def close(self, reason: str = "guest-close") -> None:
        del reason
        self._closed = True
        for task in self._lease_tasks:
            task.cancel()
        if self._reader_task is not None:
            self._reader_task.cancel()
        writer = self._writer
        if writer is not None:
            writer.close()
            await writer.wait_closed()
        self._conn = None

    async def _register(self) -> None:
        body = json.dumps(
            {"peerId": self.guest_id, "role": "guest", "routedDomains": self.routed_domains}
        ).encode("utf-8")
        stream_id = await self._send_headers(
            [
                (":method", "POST"),
                (":scheme", "https"),
                (":authority", self._authority()),
                (":path", "/verser/register"),
                ("content-type", "application/json"),
            ],
            end_stream=False,
        )
        await self._send_data(stream_id, body, end_stream=True)
        response_body = await self._collect_response_body(stream_id)
        response = json.loads(response_body.decode("utf-8"))
        if response.get("status") != "registered":
            raise RuntimeError("Host did not register Python Guest")

    async def _open_control_stream(self) -> None:
        await self._send_headers(
            [
                (":method", "POST"),
                (":scheme", "https"),
                (":authority", self._authority()),
                (":path", "/verser/guest/control"),
                ("x-verser-peer-id", self.guest_id),
            ],
            end_stream=False,
        )

    async def _open_lease_stream(self) -> None:
        self._lease_counter += 1
        lease_id = f"{self.guest_id}-lease-{self._lease_counter}"
        stream_id = await self._send_headers(
            [
                (":method", "POST"),
                (":scheme", "https"),
                (":authority", self._authority()),
                (":path", "/verser/guest/lease"),
                ("x-verser-peer-id", self.guest_id),
                ("x-verser-lease-id", lease_id),
            ],
            end_stream=False,
        )
        await self._wait_for_success_response(stream_id)
        while not self._closed:
            envelope_type, metadata, body = await self._read_request_envelope_and_body(stream_id)
            if envelope_type != "request":
                raise RuntimeError("Lease stream received a non-request envelope")
            response = await self.dispatch_routed_request(metadata, body)
            if response.error is not None:
                await self._send_data(stream_id, encode_envelope("error", response.error), True)
            else:
                await self._send_data(
                    stream_id,
                    encode_envelope(
                        "response",
                        {
                            "requestId": response.request_id,
                            "statusCode": response.status_code,
                            "headers": normalize_headers(response.headers),
                        },
                    )
                    + response.body,
                    True,
                )
            if not self._closed:
                self._lease_tasks.append(asyncio.create_task(self._open_lease_stream()))
            return

    async def _send_headers(self, headers: list[tuple[str, str]], end_stream: bool) -> int:
        conn = self._require_conn()
        async with self._io_lock:
            stream_id = conn.get_next_available_stream_id()
            self._events[stream_id] = asyncio.Queue()
            conn.send_headers(stream_id, headers, end_stream=end_stream)
            await self._flush_unlocked()
            return stream_id

    async def _send_data(self, stream_id: int, data: bytes, end_stream: bool) -> None:
        conn = self._require_conn()
        async with self._io_lock:
            conn.send_data(stream_id, data, end_stream=end_stream)
            await self._flush_unlocked()

    async def _collect_response_body(self, stream_id: int) -> bytes:
        chunks: list[bytes] = []
        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, h2.events.DataReceived):
                chunks.append(event.data)
            if isinstance(event, h2.events.StreamEnded):
                return b"".join(chunks)

    async def _wait_for_success_response(self, stream_id: int) -> None:
        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, h2.events.ResponseReceived):
                status = dict(event.headers).get(":status")
                if status != "200":
                    raise RuntimeError(f"Lease stream was rejected with status {status}")
                return

    async def _read_request_envelope_and_body(self, stream_id: int) -> tuple[str, dict[str, Any], bytes]:
        chunks: list[bytes] = []
        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, h2.events.DataReceived):
                chunks.append(event.data)
            if isinstance(event, h2.events.StreamEnded):
                return decode_envelope(b"".join(chunks))

    async def _read_loop(self) -> None:
        reader = self._reader
        if reader is None:
            return
        while not self._closed:
            data = await reader.read(65535)
            if not data:
                return
            async with self._io_lock:
                events = self._require_conn().receive_data(data)
                for event in events:
                    stream_id = getattr(event, "stream_id", None)
                    if isinstance(event, h2.events.DataReceived):
                        self._require_conn().acknowledge_received_data(
                            event.flow_controlled_length, event.stream_id
                        )
                    if stream_id in self._events:
                        self._events[stream_id].put_nowait(event)
                await self._flush_unlocked()

    async def _flush(self) -> None:
        async with self._io_lock:
            await self._flush_unlocked()

    async def _flush_unlocked(self) -> None:
        writer = self._writer
        if writer is None:
            return
        data = self._require_conn().data_to_send()
        if data:
            writer.write(data)
            await writer.drain()

    def _authority(self) -> str:
        parsed = urlsplit(self.host_url)
        return f"{parsed.hostname}:{parsed.port or 443}"

    def _require_conn(self) -> h2.connection.H2Connection:
        if self._conn is None:
            raise RuntimeError("Guest is not connected")
        return self._conn


def create_verser_guest(**options: Any) -> VerserGuest:
    return VerserGuest(**options)

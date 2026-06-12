"""Minimal outbound Python Broker for Verser 2."""

from __future__ import annotations

import asyncio
import json
import ssl
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit

import h2.connection
import h2.config
import h2.events


class VerserBrokerResponse:
    """Represent a broker routed response body with one-shot readers."""

    def __init__(
        self,
        *,
        status: int,
        headers: dict[str, str],
        request_id: str,
        body: bytes,
    ) -> None:
        self.status = status
        self.headers = dict(headers)
        self.request_id = request_id
        self._body = bytes(body)
        self._state = "unused"

    def _ensure_full_unused(self) -> None:
        if self._state == "streamed":
            raise RuntimeError("Response body stream has already been consumed")
        if self._state == "consumed":
            raise RuntimeError("Response body has already been consumed")

    def _set_streaming(self) -> None:
        if self._state == "consumed":
            raise RuntimeError("Response body has already been consumed")
        if self._state == "streamed":
            raise RuntimeError("Response body stream is already in use")
        self._state = "streamed"

    async def read(self) -> bytes:
        self._ensure_full_unused()
        self._state = "consumed"
        return self._body

    async def text(self) -> str:
        return (await self.read()).decode("utf-8")

    async def json(self) -> Any:
        payload = await self.text()
        return json.loads(payload)

    async def aiter_bytes(self, chunk_size: int = 8192):
        self._set_streaming()
        try:
            for index in range(0, len(self._body), chunk_size):
                yield self._body[index : index + chunk_size]
        finally:
            self._state = "consumed"


class VerserBroker:
    """Track state needed by the broker control channel."""

    def __init__(
        self,
        *,
        host_url: str,
        broker_id: str,
        tls_ca_file: str | None = None,
        **options: Any,
    ) -> None:
        self.host_url = host_url
        self.broker_id = broker_id
        self.tls_ca_file = tls_ca_file
        self.options = dict(options)
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._conn: h2.connection.H2Connection | None = None
        self._events: dict[int, asyncio.Queue[Any]] = {}
        self._io_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._closed = False
        self._routes: list[dict[str, str]] = []
        self._route_waiters: dict[str, list[asyncio.Future[None]]] = {}

    async def __aenter__(self) -> "VerserBroker":
        await self.connect()
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        await self.close()

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

    async def close(self, reason: str = "broker-close") -> None:
        del reason
        self._closed = True
        task = self._reader_task
        if task is not None:
            task.cancel()
        writer = self._writer
        if writer is not None:
            writer.close()
            await writer.wait_closed()
        self._conn = None

    def _registration_payload(self) -> dict[str, str]:
        return {"peerId": self.broker_id, "role": "broker"}

    async def _register(self) -> None:
        payload = self._registration_payload()
        body = json.dumps(payload).encode("utf-8")
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
        try:
            await self._send_data(stream_id, body, end_stream=True)
            response_body = await self._collect_response_body(stream_id)
        finally:
            self._events.pop(stream_id, None)
        self._parse_registration_response(response_body)

    def _parse_registration_response(self, payload: str | bytes | dict[str, Any]) -> None:
        response = self._coerce_registration_response(payload)
        status = response.get("status")
        if status == "registered":
            return
        raise RuntimeError(
            f"Broker {self.broker_id} registration failed while processing response "
            f"(status={status})"
        )

    def _validate_registration_response(self, payload: str | bytes | dict[str, Any]) -> None:
        self._parse_registration_response(payload)

    def _coerce_registration_response(self, payload: str | bytes | dict[str, Any]) -> dict[str, Any]:
        if isinstance(payload, dict):
            return dict(payload)
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        if not isinstance(payload, str):
            raise TypeError("Registration response must be json-compatible text or object")
        return json.loads(payload)

    async def _open_control_stream(self) -> None:
        await self._send_headers(
            [
                (":method", "POST"),
                (":scheme", "https"),
                (":authority", self._authority()),
                (":path", "/verser/broker/control"),
                ("x-verser-peer-id", self.broker_id),
            ],
            end_stream=False,
        )

    def _start_lease_task(self) -> None:
        return None

    async def request(self, *_args: Any, **_kwargs: Any) -> VerserBrokerResponse:
        return self._disconnected_error()

    async def get(self, *args: Any, **kwargs: Any) -> VerserBrokerResponse:
        return self._disconnected_error()

    async def post(self, *args: Any, **kwargs: Any) -> VerserBrokerResponse:
        return self._disconnected_error()

    async def put(self, *args: Any, **kwargs: Any) -> VerserBrokerResponse:
        return self._disconnected_error()

    async def patch(self, *args: Any, **kwargs: Any) -> VerserBrokerResponse:
        return self._disconnected_error()

    async def delete(self, *args: Any, **kwargs: Any) -> VerserBrokerResponse:
        return self._disconnected_error()

    def get_routes(self) -> list[dict[str, str]]:
        return [dict(route) for route in self._routes]

    async def wait_for_route(self, domain: str) -> None:
        if any(route.get("domain") == domain for route in self._routes):
            return
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        waiters = self._route_waiters.setdefault(domain, [])
        waiters.append(future)

        def cleanup(_: Any) -> None:
            try:
                self._route_waiters.setdefault(domain, []).remove(future)
                if domain in self._route_waiters and not self._route_waiters[domain]:
                    del self._route_waiters[domain]
            except ValueError:
                pass

        future.add_done_callback(cleanup)
        await future

    def _handle_control_frame(self, frame: dict[str, Any]) -> None:
        if frame.get("type") != "routes":
            return
        routes = self._coerce_routes(frame.get("routes", []))
        self._routes = routes
        self._resolve_waiters([route.get("domain") for route in routes if isinstance(route, dict)])

    async def _send_headers(
        self,
        headers: Iterable[tuple[str, str]],
        *,
        end_stream: bool,
        create_queue: bool = True,
    ) -> int:
        conn = self._require_conn()
        async with self._io_lock:
            stream_id = conn.get_next_available_stream_id()
            if create_queue:
                self._events[stream_id] = asyncio.Queue()
            conn.send_headers(stream_id, list(headers), end_stream=end_stream)
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
                    if stream_id in self._events:
                        self._events[stream_id].put_nowait(event)
                await self._flush_unlocked()

    def _resolve_waiters(self, domains: list[str | None]) -> None:
        for domain in set(domains):
            if not domain:
                continue
            if any(route.get("domain") == domain for route in self._routes):
                waiters = self._route_waiters.pop(domain, [])
                for waiter in waiters:
                    if not waiter.done():
                        waiter.set_result(None)

    def _coerce_routes(self, routes: Any) -> list[dict[str, str]]:
        if not isinstance(routes, list):
            raise RuntimeError("Invalid routes control frame: expected a routes array")
        normalized: list[dict[str, str]] = []
        for route in routes:
            if not isinstance(route, dict):
                continue
            target_id = str(route.get("targetId", ""))
            domain = str(route.get("domain", ""))
            normalized.append({"targetId": target_id, "domain": domain})
        return normalized

    def _disconnected_error(self) -> VerserBrokerResponse:
        raise RuntimeError("Broker routed requests are not implemented in this phase")

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
            raise RuntimeError("Broker is not connected")
        return self._conn


def create_verser_broker(**options: Any) -> VerserBroker:
    return VerserBroker(**options)

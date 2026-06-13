"""Minimal outbound HTTP/2 Verser Guest for ASGI applications."""

from __future__ import annotations

import asyncio
import json
import ssl
import struct
from typing import Any
from urllib.parse import urlsplit

import h2.connection
import h2.config
import h2.events

from ._tls import create_client_ssl_context, load_pfx_client_identity, validate_h2_alpn
from .asgi import (
    DEFAULT_MAX_RESPONSE_BYTES,
    ASGIApp,
    DispatchResponse,
    build_http_scope,
    dispatch_asgi_request,
)
from .protocol import VERSER_ENVELOPE_PREFIX_BYTES, decode_envelope, encode_envelope


class VerserGuest:
    """An outbound Verser Guest peer that routes HTTP requests to a local ASGI app.

    The Guest connects to a Verser Host (TLS + HTTP/2), registers as role
    ``"guest"``, opens a control stream and one or more lease streams, and
    dispatches each routed request to the attached ASGI application via the
    **ASGI 3** protocol (``scope["asgi"]["version"] == "3.0"``,
    ``scope["asgi"]["spec_version"] == "2.5"``).

    URL hostname matching
        The Host matches incoming request URLs against the Guest's advertised
        ``routed_domains`` using exact hostname equality.  No wildcard or
        suffix matching is supported.

    Lifecycle
        1. Instantiate with connection parameters and (optionally) an app.
        2. Attach or provide the ASGI app before ``connect()``. To advertise
           a route at registration, also pass ``routed_domains=...`` to the
           constructor or call ``attach(domain=...)`` before ``connect()``.
           Calling ``attach(app)`` without ``domain`` only changes the local
           app. Route changes made after registration are not re-advertised to
           the Host.
        3. ``await guest.connect()`` — initiates TLS with ALPN ``h2``,
           performs the HTTP/2 handshake, registers with the Host, opens a
           control stream, and establishes lease streams.
        4. The Guest automatically dispatches incoming requests on lease
           streams.
        5. ``await guest.close()`` — cancels lease/reader tasks and closes the
           TCP/TLS connection.

    Errors
        ``RuntimeError`` is raised if the Host rejects registration, a lease
        stream is rejected, or a lease stream ends without complete request
        metadata.  App exceptions captured after a response has started are
        silently discarded; before a response starts they are returned as error
        envelopes with code ``"local-handler-failure"``.
    """

    def __init__(
        self,
        *,
        host_url: str,
        guest_id: str,
        app: ASGIApp | None = None,
        routed_domains: list[str] | None = None,
        tls_ca_file: str | None = None,
        tls_cert_file: str | None = None,
        tls_key_file: str | None = None,
        tls_key_password: str | None = None,
        tls_pfx_file: str | None = None,
        tls_pfx_password: str | None = None,
        min_waiting_streams: int = 1,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ) -> None:
        """Initialise the Guest peer.

        Parameters
        ----------
        host_url : str
            The Host URL (e.g. ``"https://host.example.com:8443"``).
        guest_id : str
            A unique peer identifier for the Host registration.  Must not
            collide with any other peer ID on the same Host.
        app : ASGIApp or None
            An optional ASGI 3 callable that will receive dispatched requests.
            Can also be set later via :meth:`attach`.
        routed_domains : list[str] or None
            List of hostnames this Guest advertises to the Host.  Route
            matching on the Host uses exact hostname equality.
        tls_ca_file : str or None
            Path to a PEM CA bundle for verifying the Host's TLS certificate.
        tls_cert_file : str or None
            Path to a PEM client certificate for mTLS client identity.
        tls_key_file : str or None
            Path to the corresponding PEM private key.
        tls_key_password : str or None
            Password for the private key (if encrypted).
        tls_pfx_file : str or None
            Path to a PFX/PKCS12 file containing client identity.
        tls_pfx_password : str or None
            Password for the PFX/PKCS12 file.
        min_waiting_streams : int
            Minimum number of lease streams to maintain (default 1, minimum 1).
        max_response_bytes : int
            Maximum cumulative response body bytes for direct dispatch (default
            10 MiB).  Exceeding this raises
            :exc:`ResponseBodyTooLargeError` which is caught and returned as an
            error envelope.
        """
        self.host_url = host_url
        self.guest_id = guest_id
        self.app = app
        self.routed_domains = routed_domains or []
        self.tls_ca_file = tls_ca_file
        self.tls_cert_file = tls_cert_file
        self.tls_key_file = tls_key_file
        self.tls_key_password = tls_key_password
        self.tls_pfx_file = tls_pfx_file
        self.tls_pfx_password = tls_pfx_password
        self.min_waiting_streams = max(1, min_waiting_streams)
        self.max_response_bytes = max_response_bytes
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
        """Attach an ASGI app to this Guest.

        Parameters
        ----------
        app : ASGIApp
            An ASGI 3 callable ``(scope, receive, send) -> None``.
        domain : str or None
            If provided, replaces ``routed_domains`` with a single-domain list.
            This is a convenience for the common single-route case and affects
            Host route advertisement only when called before ``connect()``. If
            omitted, the attached app changes but routed domains are unchanged.

        Returns
        -------
        VerserGuest
            ``self`` (for chaining).
        """
        self.app = app
        if domain is not None:
            self.routed_domains = [domain]
        return self

    async def dispatch_routed_request(
        self, metadata: dict[str, Any], body: bytes | list[bytes]
    ) -> DispatchResponse:
        """Dispatch a single routed request to the attached ASGI app.

        This is a synchronous (in-async) convenience for testing or direct
        dispatch *without* a live lease stream.  The app is run to completion
        and the response is buffered in memory.

        Parameters
        ----------
        metadata : dict
            Verser envelope metadata containing at least ``requestId``,
            ``method``, ``path``, and optionally ``headers``.
        body : bytes or list[bytes]
            Raw request body chunks.

        Returns
        -------
        DispatchResponse
            A frozen dataclass with ``request_id``, ``status_code``,
            ``headers``, ``body``, and optionally ``error``.

        Raises
        ------
        RuntimeError
            Raised directly (not caught) for app exceptions that occur *after*
            response headers have been sent and are not
            :exc:`ResponseBodyTooLargeError`.
        """
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
        return await dispatch_asgi_request(
            self.app,
            self.guest_id,
            metadata,
            body,
            self.max_response_bytes,
        )

    async def connect(self) -> None:
        """Establish the outbound TLS+HTTP/2 connection and register with the Host.

        The connection sequence is:

        1.  Open a TCP+TLS connection to ``host_url`` with ALPN ``h2``.
        2.  Perform the HTTP/2 client preface.
        3.  POST a JSON registration to ``/verser/register`` with
            ``peerId`` and ``role`` set to ``"guest"``.
        4.  Open a control stream at ``/verser/guest/control``.
        5.  Start ``min_waiting_streams`` lease streams on
            ``/verser/guest/lease``.

        Calling ``connect()`` on an already-connected Guest is a no-op.

        Raises
        ------
        RuntimeError
            If the Host rejects the registration.
        OSError
            If the TLS or TCP connection fails.
        """
        if self._conn is not None:
            return
        parsed = urlsplit(self.host_url)
        context = self._create_ssl_context()
        try:
            reader, writer = await asyncio.open_connection(
                parsed.hostname,
                parsed.port or 443,
                ssl=context,
                server_hostname=parsed.hostname,
            )
        except Exception as exc:
            raise RuntimeError(
                f"TLS handshake failed for guest {self.guest_id} connecting to {self.host_url}: {exc}"
            ) from exc
        self._validate_h2_alpn(writer)
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
            self._start_lease_task()

    def _create_ssl_context(self) -> ssl.SSLContext:
        return create_client_ssl_context(
            tls_ca_file=self.tls_ca_file,
            tls_cert_file=self.tls_cert_file,
            tls_key_file=self.tls_key_file,
            tls_key_password=self.tls_key_password,
            tls_pfx_file=self.tls_pfx_file,
            tls_pfx_password=self.tls_pfx_password,
        )

    def _load_pfx_client_identity(
        self, context: ssl.SSLContext, pfx_file: str, password: str | None = None
    ) -> None:
        load_pfx_client_identity(context, pfx_file, password)

    def _validate_h2_alpn(self, writer: asyncio.StreamWriter) -> None:
        validate_h2_alpn(writer, peer_kind="guest", peer_id=self.guest_id)

    async def close(self, reason: str = "guest-close") -> None:
        """Tear down the Guest connection.

        Cancels all lease tasks and the reader task, then closes the TCP/TLS
        writer and awaits its graceful shutdown.

        Parameters
        ----------
        reason : str
            Reason string (not currently sent over the wire; reserved for
            future use).
        """
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
        try:
            await self._send_data(stream_id, body, end_stream=True)
            response_body = await self._collect_response_body(stream_id)
        finally:
            self._events.pop(stream_id, None)
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
            create_queue=False,
        )

    def _start_lease_task(self) -> None:
        task = asyncio.create_task(self._open_lease_stream())
        self._lease_tasks.append(task)

        def prune(completed_task: asyncio.Task[None]) -> None:
            try:
                self._lease_tasks.remove(completed_task)
            except ValueError:
                pass

        task.add_done_callback(prune)

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
        try:
            await self._wait_for_success_response(stream_id)
            while not self._closed:
                await self._dispatch_leased_request_stream(stream_id)
                if not self._closed:
                    self._start_lease_task()
                return
        finally:
            self._events.pop(stream_id, None)

    async def _dispatch_leased_request_stream(self, stream_id: int) -> None:
        if self.app is None:
            await self._send_data(
                stream_id,
                encode_envelope(
                    "error",
                    {
                        "requestId": "",
                        "code": "local-handler-failure",
                        "message": "No ASGI app is attached",
                        "context": {"guestId": self.guest_id},
                    },
                ),
                True,
            )
            return

        buffer = b""
        metadata: dict[str, Any] | None = None
        pending_metadata_flow_controlled_length = 0
        request_events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        app_task: asyncio.Task[None] | None = None
        response_started = False
        response_ended = False

        async def receive() -> dict[str, Any]:
            event = await request_events.get()
            flow_controlled_length = int(event.pop("_flow_controlled_length", 0) or 0)
            if flow_controlled_length > 0:
                await self._acknowledge_received_data(stream_id, flow_controlled_length)
            return event

        async def send(event: dict[str, Any]) -> None:
            nonlocal response_started, response_ended
            event_type = event.get("type")
            if event_type == "http.response.start":
                response_started = True
                await self._send_data(
                    stream_id,
                    encode_envelope(
                        "response",
                        {
                            "requestId": str((metadata or {}).get("requestId") or ""),
                            "statusCode": int(event.get("status") or 200),
                            "headers": {
                                name.decode("ascii", "ignore").lower(): value.decode("latin-1")
                                for name, value in event.get("headers", [])
                            },
                        },
                    ),
                    False,
                )
                return
            if event_type == "http.response.body":
                more_body = bool(event.get("more_body", False))
                response_ended = not more_body
                await self._send_data(stream_id, bytes(event.get("body") or b""), not more_body)

        async def run_app() -> None:
            nonlocal response_ended
            assert metadata is not None
            try:
                await self.app(build_http_scope(metadata), receive, send)
            except Exception as error:  # noqa: BLE001 - app exceptions become protocol errors.
                if response_started:
                    if not response_ended:
                        await self._send_data(stream_id, b"", True)
                    return
                await self._send_data(
                    stream_id,
                    encode_envelope(
                        "error",
                        {
                            "requestId": str(metadata.get("requestId") or ""),
                            "code": "local-handler-failure",
                            "message": str(error),
                            "context": {
                                "guestId": self.guest_id,
                                "requestId": str(metadata.get("requestId") or ""),
                                "path": str(metadata.get("path") or ""),
                            },
                        },
                    ),
                    True,
                )
                response_ended = True
                return
            if not response_ended:
                if not response_started:
                    await send({"type": "http.response.start", "status": 200, "headers": []})
                await self._send_data(stream_id, b"", True)
                response_ended = True

        def try_start_app() -> None:
            nonlocal app_task, buffer, metadata, pending_metadata_flow_controlled_length
            if metadata is not None or len(buffer) < VERSER_ENVELOPE_PREFIX_BYTES:
                return
            metadata_length = struct.unpack(">I", buffer[2:6])[0]
            envelope_end = VERSER_ENVELOPE_PREFIX_BYTES + metadata_length
            if len(buffer) < envelope_end:
                return
            envelope_type, parsed_metadata, remainder = decode_envelope(buffer)
            if envelope_type != "request":
                raise RuntimeError("Lease stream received a non-request envelope")
            metadata = parsed_metadata
            buffer = b""
            if remainder:
                request_events.put_nowait(
                    {
                        "type": "http.request",
                        "body": remainder,
                        "more_body": True,
                        "_flow_controlled_length": pending_metadata_flow_controlled_length,
                    }
                )
            elif pending_metadata_flow_controlled_length:
                asyncio.create_task(
                    self._acknowledge_received_data(
                        stream_id, pending_metadata_flow_controlled_length
                    )
                )
            pending_metadata_flow_controlled_length = 0
            app_task = asyncio.create_task(run_app())

        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, h2.events.DataReceived):
                if metadata is None:
                    pending_metadata_flow_controlled_length += int(event.flow_controlled_length)
                    buffer += event.data
                    try_start_app()
                else:
                    request_events.put_nowait(
                        {
                            "type": "http.request",
                            "body": event.data,
                            "more_body": True,
                            "_flow_controlled_length": event.flow_controlled_length,
                        }
                    )
            if isinstance(event, h2.events.StreamEnded):
                try_start_app()
                request_events.put_nowait({"type": "http.request", "body": b"", "more_body": False})
                break

        if app_task is None:
            raise RuntimeError("Lease stream ended before request metadata arrived")
        await app_task

    async def _send_headers(
        self, headers: list[tuple[str, str]], end_stream: bool, create_queue: bool = True
    ) -> int:
        conn = self._require_conn()
        async with self._io_lock:
            stream_id = conn.get_next_available_stream_id()
            if create_queue:
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

    async def _acknowledge_received_data(
        self, stream_id: int, flow_controlled_length: int
    ) -> None:
        async with self._io_lock:
            self._require_conn().acknowledge_received_data(flow_controlled_length, stream_id)
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
    """Create a :class:`VerserGuest` with the given keyword options.

    This is a factory convenience wrapper around ``VerserGuest(**options)``.

    Parameters
    ----------
    **options : Any
        Forwarded directly to :class:`VerserGuest.__init__`.

    Returns
    -------
    VerserGuest
    """
    return VerserGuest(**options)

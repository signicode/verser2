"""Minimal outbound Python Broker for Verser 2."""

from __future__ import annotations

import asyncio
import json as _json
import ssl
from collections.abc import AsyncIterable, Iterable
from typing import Any
from urllib.parse import urlsplit

import h2.connection
import h2.config
import h2.events

from ._tls import create_client_ssl_context, load_pfx_client_identity, validate_h2_alpn


class VerserBrokerResponse:
    """A routed response from a Verser Host with one-shot body readers.

    The response body is consumed at most once.  Calling a reader method
    a second time raises ``RuntimeError``.

    Three reading strategies are available:

    *   ``await .read()`` — returns the full body as ``bytes``.
    *   ``await .text()`` — decodes the full body as UTF-8 ``str``.
    *   ``await .json()`` — parses the full body as JSON.
    *   ``async for chunk in .aiter_bytes(chunk_size)`` — yields streaming
        chunks without buffering the entire body in memory.

    The body may be pre-buffered ``bytes`` or an async iterable of ``bytes``
    chunks (streamed from the Host).  ``read()``/``text()``/``json()`` always
    collect and buffer the complete body first; ``aiter_bytes()`` yields
    chunks incrementally.
    """

    def __init__(
        self,
        *,
        status: int,
        headers: dict[str, str],
        request_id: str,
        body: bytes | AsyncIterable[bytes],
    ) -> None:
        self.status = status
        self.headers = dict(headers)
        self.request_id = request_id
        if hasattr(body, "__aiter__"):
            self._body = body
        else:
            self._body = bytes(body)
        self._state = "unused"

    def _ensure_full_unused(self) -> None:
        """Raise if the body was already read (fully) or is being streamed."""
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
        """Read the entire response body, buffering it in memory.

        One-shot: raises ``RuntimeError`` if the body has already been
        consumed or is being streamed.

        Returns
        -------
        bytes
        """
        self._ensure_full_unused()
        self._state = "consumed"
        if isinstance(self._body, bytes):
            return self._body
        chunks: list[bytes] = []
        async for chunk in self._body:
            chunks.append(bytes(chunk))
        self._body = b"".join(chunks)
        return self._body

    async def text(self) -> str:
        """Read the response body and decode it as UTF-8.

        One-shot (delegates to :meth:`read`).

        Returns
        -------
        str
        """
        return (await self.read()).decode("utf-8")

    async def json(self) -> Any:
        """Read the response body and parse it as JSON.

        One-shot (delegates to :meth:`read` then :func:`json.loads`).

        Returns
        -------
        any
        """
        payload = await self.text()
        return _json.loads(payload)

    async def aiter_bytes(self, chunk_size: int = 8192):
        """Yield response body chunks as an async iterator.

        If the body is already buffered as ``bytes``, chunks are produced
        by slicing at *chunk_size* boundaries.  If the body is an async
        iterable, chunks are forwarded as received from the stream.

        One-shot: raises ``RuntimeError`` if called more than once or if
        the body was already consumed via :meth:`read` / :meth:`text` /
        :meth:`json`.

        Parameters
        ----------
        chunk_size : int
            Maximum chunk size in bytes (default 8192).  Only used when the
            body is pre-buffered ; ignored for async-iterable bodies.

        Yields
        ------
        bytes
        """
        self._set_streaming()
        try:
            if not isinstance(self._body, bytes):
                async for chunk in self._body:
                    yield bytes(chunk)
                return
            for index in range(0, len(self._body), chunk_size):
                yield self._body[index : index + chunk_size]
        finally:
            self._state = "consumed"


class VerserBroker:
    """An outbound Verser Broker peer that issues routed HTTP requests.

    The Broker connects to a Verser Host (TLS + HTTP/2), registers as role
    ``"broker"``, opens a control stream to receive route advertisements, and
    sends HTTP requests to target Guests via the Host's ``/verser/request``
    endpoint.

    URL hostname matching
        The ``request()`` method extracts the hostname from the given URL and
        matches it exactly against the Host-advertised route table.  No
        wildcard or suffix matching is supported.  Raises ``RuntimeError`` if
        no route matches the hostname.

    Lifecycle
        1. Instantiate with connection parameters and TLS options.
        2. ``await broker.connect()`` — establishes TLS with ALPN ``h2``,
           performs HTTP/2 handshake, registers with the Host, opens the
           control stream, and begins consuming route frames.
        3. ``await broker.request(...)`` — sends a routed request.
        4. ``await broker.close()`` — tears down the connection gracefully.

    The Broker can be used as an async context manager::

        async with VerserBroker(host_url="...", broker_id="...") as broker:
            resp = await broker.get("http://my-guest.example.com/path")
            print(await resp.text())

    TLS client identity
        In addition to CA trust (``tls_ca_file``), the Broker supports PEM
        client certificates (``tls_cert_file`` / ``tls_key_file`` /
        ``tls_key_password``) and PFX/PKCS12 identity files
        (``tls_pfx_file`` / ``tls_pfx_password``).  PFX support requires the
        ``cryptography`` package.
    """

    def __init__(
        self,
        *,
        host_url: str,
        broker_id: str,
        tls_ca_file: str | None = None,
        **options: Any,
    ) -> None:
        """Initialise the Broker peer.

        Parameters
        ----------
        host_url : str
            The Host URL (e.g. ``"https://host.example.com:8443"``).
        broker_id : str
            A unique peer identifier for Host registration.  Must not collide
            with any other peer ID on the same Host.
        tls_ca_file : str or None
            Path to a PEM CA bundle for verifying the Host's TLS certificate.
        **options : any
            Additional keyword arguments forwarded as attributes:

            ``tls_cert_file``
                Path to a PEM client certificate for mTLS client identity.
            ``tls_key_file``
                Path to the corresponding PEM private key.
            ``tls_key_password``
                Password for the private key (if encrypted).
            ``tls_pfx_file``
                Path to a PFX/PKCS12 file containing client identity (requires
                ``cryptography``).
            ``tls_pfx_password``
                Password for the PFX/PKCS12 file.
        """
        self.host_url = host_url
        self.broker_id = broker_id
        self.tls_ca_file = tls_ca_file
        self.tls_cert_file = options.get("tls_cert_file")
        self.tls_key_file = options.get("tls_key_file")
        self.tls_key_password = options.get("tls_key_password")
        self.tls_pfx_file = options.get("tls_pfx_file")
        self.tls_pfx_password = options.get("tls_pfx_password")
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
        self._request_counter: int = 0
        self._control_stream_id: int | None = None
        self._control_task: asyncio.Task[None] | None = None
        self._window_waiters: list[asyncio.Future[None]] = []

    async def __aenter__(self) -> "VerserBroker":
        """Enter async context: calls :meth:`connect`."""
        await self.connect()
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        """Exit async context: calls :meth:`close`."""
        await self.close()

    async def connect(self) -> None:
        """Establish the outbound TLS+HTTP/2 connection and register with the Host.

        The connection sequence is:

        1.  Create an :class:`ssl.SSLContext` configured with ALPN ``h2``,
            CA trust (``tls_ca_file``), and optional client identity (PEM or
            PFX/PKCS12).
        2.  Open a TCP+TLS connection to ``host_url``.
        3.  Validate that TLS ALPN negotiated ``h2``; raises ``RuntimeError``
            otherwise.
        4.  Perform the HTTP/2 client preface.
        5.  POST a JSON registration to ``/verser/register`` with ``peerId``
            and ``role`` set to ``"broker"``.
        6.  Open a control stream at ``/verser/register`` (registration
            response contains initial route state).  Start consuming control
            frames.

        Calling ``connect()`` on an already-connected Broker is a no-op.

        Raises
        ------
        RuntimeError
            If TLS handshake fails, ALPN is not ``h2``, or the Host rejects
            registration.
        OSError
            If the TCP or TLS connection fails.
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
                f"TLS handshake failed for broker {self.broker_id} connecting to {self.host_url}: {exc}"
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
        validate_h2_alpn(writer, peer_kind="broker", peer_id=self.broker_id)

    async def close(self, reason: str = "broker-close") -> None:
        """Tear down the Broker connection.

        Cancels reader and control tasks, fails any pending stream/flow-control
        waiters, then closes the TCP/TLS writer and awaits graceful shutdown.

        Parameters
        ----------
        reason : str
            Reason string (not currently sent over the wire; reserved for
            future use).
        """
        del reason
        self._closed = True
        task = self._reader_task
        if task is not None:
            task.cancel()
        control_task = self._control_task
        if control_task is not None:
            control_task.cancel()
        for waiters in self._route_waiters.values():
            for waiter in waiters:
                if not waiter.done():
                    waiter.cancel()
        self._route_waiters.clear()
        self._fail_pending_streams(RuntimeError("Broker closed while streams were pending"))
        self._fail_window_waiters(RuntimeError("Broker closed while request body was waiting for flow-control"))
        writer = self._writer
        if writer is not None:
            writer.close()
            await writer.wait_closed()
        self._conn = None

    def _registration_payload(self) -> dict[str, str]:
        return {"peerId": self.broker_id, "role": "broker"}

    async def _register(self) -> None:
        payload = self._registration_payload()
        body = _json.dumps(payload).encode("utf-8")
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
        self._control_stream_id = stream_id
        try:
            await self._send_data(stream_id, body, end_stream=True)
            response = await self._read_registration_line(stream_id)
        except Exception:
            self._events.pop(stream_id, None)
            self._control_stream_id = None
            raise
        self._parse_registration_response(response)
        routes = response.get("routes") if isinstance(response, dict) else None
        if routes is not None:
            self._handle_control_frame({"type": "routes", "routes": routes})
        self._control_task = asyncio.create_task(self._consume_control_stream(stream_id))

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

    async def _read_registration_line(self, stream_id: int) -> dict[str, Any]:
        buffer = b""
        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, Exception):
                raise event
            if isinstance(event, h2.events.DataReceived):
                buffer += event.data
                await self._acknowledge_received_data(stream_id, int(event.flow_controlled_length))
                if b"\n" in buffer:
                    line, remainder = buffer.split(b"\n", 1)
                    if remainder:
                        self._events[stream_id].put_nowait(
                            h2.events.DataReceived(
                                stream_id=stream_id,
                                data=remainder,
                                flow_controlled_length=0,
                            )
                        )
                    return self._coerce_registration_response(line)
            if isinstance(event, h2.events.StreamEnded):
                raise RuntimeError(
                    f"Broker {self.broker_id} registration stream ended before registration response"
                )

    async def _consume_control_stream(self, stream_id: int) -> None:
        buffer = b""
        while not self._closed:
            event = await self._events[stream_id].get()
            if isinstance(event, Exception):
                raise event
            if isinstance(event, h2.events.DataReceived):
                buffer += event.data
                await self._acknowledge_received_data(stream_id, int(event.flow_controlled_length))
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    frame = self._coerce_registration_response(line)
                    if frame.get("type") == "routes":
                        self._handle_control_frame(frame)
            if isinstance(event, h2.events.StreamEnded):
                return

    def _coerce_registration_response(self, payload: str | bytes | dict[str, Any]) -> dict[str, Any]:
        if isinstance(payload, dict):
            return dict(payload)
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        if not isinstance(payload, str):
            raise TypeError("Registration response must be json-compatible text or object")
        try:
            return _json.loads(payload)
        except _json.JSONDecodeError as exc:
            raise ValueError(
                f"Registration response for broker {self.broker_id} is malformed: {exc}"
            ) from exc

    async def _open_control_stream(self) -> None:
        return None

    def _start_lease_task(self) -> None:
        return None

    async def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        body: Any = None,
        json: Any = None,
        text: str | None = None,
        **kwargs: Any,
    ) -> VerserBrokerResponse:
        """Send a routed HTTP request to a target Guest via the Host.

        The URL's hostname is matched exactly against the Host-advertised
        route table.  If no route matches, ``RuntimeError`` is raised.

        Body can be provided in several forms:

        *   ``body`` — raw ``bytes``, a ``list``/``tuple`` of chunks, or an
            async iterable of ``bytes``.
        *   ``json`` — serialised as UTF-8 JSON; sets ``content-type`` to
            ``application/json``.
        *   ``text`` — encoded as UTF-8; sets ``content-type`` to
            ``text/plain``.

        Only one body form should be supplied; if more than one is given,
        the priority is ``json`` > ``text`` > ``body``.

        Parameters
        ----------
        method : str
            HTTP method (GET, POST, PUT, PATCH, DELETE, …).
        url : str
            Full URL whose hostname is matched against advertised routes.
        headers : dict or None
            Additional HTTP headers for the downstream request.
        body : bytes, list[bytes], tuple[bytes], or async iterable of bytes
            Raw request body bytes.
        json : any
            Convenience — serialised as JSON body with content-type hint.
        text : str
            Convenience — encoded as UTF-8 body with content-type hint.

        Returns
        -------
        VerserBrokerResponse
            A one-shot response object.  Read the body via ``.read()``,
            ``.text()``, ``.json()``, or ``.aiter_bytes()``.

        Raises
        ------
        RuntimeError
            If the target domain has no advertised route, the response stream
            is reset, or an error (HTTP 400+) response is received from the
            Host (details are extracted from the error envelope).
        ValueError
            If the response stream ends before response headers are received.
        """
        parsed = urlsplit(url)
        hostname = parsed.hostname or ""
        path = (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")

        target_id: str | None = None
        for route in self._routes:
            if route.get("domain") == hostname:
                target_id = route.get("targetId")
                break

        if not target_id:
            raise RuntimeError(
                f"No advertised route found for domain '{hostname}'"
            )

        user_headers = dict(headers or {})
        self._request_counter += 1
        request_id = f"{self.broker_id}-req-{self._request_counter}"

        # --- body processing ---------------------------------------------------
        body_iter: list[bytes] | AsyncIterable[bytes] | None = None

        if json is not None:
            body_bytes = _json.dumps(json, ensure_ascii=False).encode("utf-8")
            user_headers.setdefault("content-type", "application/json")
            body_iter = [body_bytes]
        elif text is not None:
            body_bytes = text.encode("utf-8")
            user_headers.setdefault("content-type", "text/plain")
            body_iter = [body_bytes]
        elif body is not None:
            if isinstance(body, bytes):
                body_iter = [body]
            elif isinstance(body, str):
                body_iter = [body.encode("utf-8")]
                user_headers.setdefault("content-type", "text/plain")
            elif isinstance(body, (list, tuple)):
                body_iter = list(body)
            elif hasattr(body, "__aiter__"):
                body_iter = body  # type: ignore[assignment]
            else:
                body_iter = [bytes(body)]
        else:
            body_iter = None

        # --- metadata (always in HTTP/2 headers for transport) -----------------
        verser_meta: dict[str, Any] = {
            "targetId": target_id,
            "sourceId": self.broker_id,
            "method": method,
            "path": path,
            "requestId": request_id,
        }
        verser_meta["headers"] = dict(user_headers)

        # --- HTTP/2 request headers -------------------------------------------
        request_headers: list[tuple[str, str]] = [
            (":method", "POST"),
            (":scheme", "https"),
            (":authority", self._authority()),
            (":path", "/verser/request"),
            ("x-verser-request-id", request_id),
            ("x-verser-source-id", self.broker_id),
            ("x-verser-target-id", target_id),
            ("x-verser-method", method),
            ("x-verser-path", path),
            ("x-verser-headers", _json.dumps(user_headers, ensure_ascii=False)),
        ]
        ct = user_headers.get("content-type")
        if ct:
            request_headers.append(("content-type", ct))

        stream_id = await self._send_headers(request_headers, end_stream=False)
        await self._send_body(stream_id, body_iter)
        response = await self._collect_response(stream_id, request_id)

        return response

    async def _send_body(
        self,
        stream_id: int,
        body_iter: list[bytes] | AsyncIterable[bytes] | None,
    ) -> None:
        """Write *body_iter* chunks to *stream_id*.

        The last chunk always carries ``end_stream=True``.
        """
        if body_iter is None:
            await self._send_data(stream_id, b"", end_stream=True)
            return

        if isinstance(body_iter, list):
            if not body_iter:
                await self._send_data(stream_id, b"", end_stream=True)
                return
            for idx, chunk in enumerate(body_iter):
                is_last = idx == len(body_iter) - 1
                await self._send_data(
                    stream_id, chunk if isinstance(chunk, bytes) else bytes(chunk), end_stream=is_last
                )
            return

        # Async iterable — peek-ahead to set end_stream correctly.
        ait = body_iter.__aiter__()
        _sentinel: Any = object()
        try:
            chunk = await ait.__anext__()
        except StopAsyncIteration:
            await self._send_data(stream_id, b"", end_stream=True)
            return

        while chunk is not _sentinel:
            try:
                nxt = await ait.__anext__()
                is_last = False
            except StopAsyncIteration:
                nxt = _sentinel
                is_last = True
            await self._send_data(
                stream_id, chunk if isinstance(chunk, bytes) else bytes(chunk), end_stream=is_last
            )
            chunk = nxt

    async def _collect_response(self, stream_id: int, request_id: str) -> VerserBrokerResponse:
        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, Exception):
                self._events.pop(stream_id, None)
                raise event
            if isinstance(event, h2.events.ResponseReceived):
                raw_headers = dict(event.headers)
                status = int(raw_headers.get(":status") or 200)
                headers = {
                    str(name).lower(): str(value)
                    for name, value in raw_headers.items()
                    if not str(name).startswith(":")
                }
                if status >= 400:
                    body = await self._collect_error_response_body(stream_id)
                    self._events.pop(stream_id, None)
                    raise self._error_from_response_body(body, status, request_id)
                return VerserBrokerResponse(
                    status=status,
                    headers=headers,
                    request_id=request_id,
                    body=self._response_body_iter(stream_id),
                )
            if isinstance(event, h2.events.DataReceived):
                await self._acknowledge_received_data(stream_id, int(event.flow_controlled_length))
            if isinstance(event, h2.events.StreamReset):
                self._events.pop(stream_id, None)
                raise RuntimeError(
                    f"Broker response stream for request {request_id} was reset"
                )
            if isinstance(event, h2.events.StreamEnded):
                self._events.pop(stream_id, None)
                raise ValueError(
                    f"Malformed response for request {request_id}: stream ended before response headers"
                )

    async def _collect_error_response_body(self, stream_id: int) -> bytes:
        chunks: list[bytes] = []
        while True:
            event = await self._events[stream_id].get()
            if isinstance(event, Exception):
                raise event
            if isinstance(event, h2.events.DataReceived):
                chunks.append(event.data)
                await self._acknowledge_received_data(stream_id, int(event.flow_controlled_length))
            if isinstance(event, h2.events.StreamEnded):
                return b"".join(chunks)
            if isinstance(event, h2.events.StreamReset):
                raise RuntimeError("Broker error response stream was reset before completion")

    async def _response_body_iter(self, stream_id: int):
        ended = False
        try:
            while True:
                event = await self._events[stream_id].get()
                if isinstance(event, Exception):
                    raise event
                if isinstance(event, h2.events.DataReceived):
                    await self._acknowledge_received_data(
                        stream_id, int(event.flow_controlled_length)
                    )
                    yield event.data
                if isinstance(event, h2.events.StreamEnded):
                    ended = True
                    return
                if isinstance(event, h2.events.StreamReset):
                    ended = True
                    raise RuntimeError(
                        f"Broker response stream {stream_id} was reset before the body completed"
                    )
        finally:
            if not ended:
                await self._reset_stream(stream_id)
            self._events.pop(stream_id, None)

    def _parse_response(self, response_bytes: bytes, request_id: str) -> VerserBrokerResponse:
        """Decode the JSON response envelope into a ``VerserBrokerResponse``."""
        try:
            data = _json.loads(response_bytes.decode("utf-8"))
        except (_json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(
                f"Malformed response metadata for request {request_id}: {exc}"
            ) from exc

        if not isinstance(data, dict):
            raise ValueError(
                f"Malformed response metadata for request {request_id}: "
                f"expected a JSON object, got {type(data).__name__}"
            )

        status: int = data.get("status") or data.get("statusCode") or 0
        headers: dict[str, str] = dict(data.get("headers", {}) or {})
        resp_request_id: str = str(data.get("requestId", request_id))
        body: bytes = data.get("body", b"")
        if isinstance(body, str):
            body = body.encode("utf-8")
        elif not isinstance(body, bytes):
            body = b""

        return VerserBrokerResponse(
            status=status,
            headers=headers,
            request_id=resp_request_id,
            body=body,
        )

    def _error_from_response_body(
        self, body: bytes, status: int, request_id: str
    ) -> RuntimeError:
        try:
            payload = _json.loads(body.decode("utf-8")) if body else {}
        except (_json.JSONDecodeError, UnicodeDecodeError):
            return RuntimeError(
                f"Broker request {request_id} failed with status {status}: malformed error response"
            )
        error = payload.get("error", payload) if isinstance(payload, dict) else {}
        code = error.get("code", "protocol-error") if isinstance(error, dict) else "protocol-error"
        message = error.get("message", "Broker request failed") if isinstance(error, dict) else "Broker request failed"
        context = error.get("context", {}) if isinstance(error, dict) else {}
        return RuntimeError(
            f"Broker request {request_id} failed with status {status} ({code}): {message}; context={context}"
        )

    async def get(self, url: str, **kwargs: Any) -> VerserBrokerResponse:
        """Convenience: send a ``GET`` routed request.

        See :meth:`request` for parameter and return details.
        """
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> VerserBrokerResponse:
        """Convenience: send a ``POST`` routed request.

        See :meth:`request` for parameter and return details.
        """
        return await self.request("POST", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> VerserBrokerResponse:
        """Convenience: send a ``PUT`` routed request.

        See :meth:`request` for parameter and return details.
        """
        return await self.request("PUT", url, **kwargs)

    async def patch(self, url: str, **kwargs: Any) -> VerserBrokerResponse:
        """Convenience: send a ``PATCH`` routed request.

        See :meth:`request` for parameter and return details.
        """
        return await self.request("PATCH", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> VerserBrokerResponse:
        """Convenience: send a ``DELETE`` routed request.

        See :meth:`request` for parameter and return details.
        """
        return await self.request("DELETE", url, **kwargs)

    def get_routes(self) -> list[dict[str, str]]:
        """Return a snapshot of the current advertised route table.

        Each entry is a ``dict`` with ``"targetId"`` (str) and ``"domain"``
        (str) keys.  The Host pushes route updates over the control stream;
        this method returns the most recently received table.

        Returns
        -------
        list[dict[str, str]]
        """
        return [dict(route) for route in self._routes]

    async def wait_for_route(self, domain: str) -> None:
        """Wait until a route for *domain* is advertised by the Host.

        If the route is already present in the local route table, returns
        immediately.  Otherwise creates an ``asyncio.Future`` that is resolved
        when the next route control frame includes the requested domain.

        The future is cancelled if the Broker is closed before the route is
        advertised.

        Parameters
        ----------
        domain : str
            The exact hostname to wait for (matched via exact equality).

        Raises
        ------
        asyncio.CancelledError
            If the Broker is closed while waiting.
        """
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
        if not data:
            async with self._io_lock:
                self._require_conn().send_data(stream_id, b"", end_stream=end_stream)
                await self._flush_unlocked()
            return

        offset = 0
        while offset < len(data):
            async with self._io_lock:
                conn = self._require_conn()
                max_frame_size = int(getattr(conn, "max_outbound_frame_size", 16384) or 16384)
                window = int(conn.local_flow_control_window(stream_id))
                if window > 0:
                    size = min(max_frame_size, window, len(data) - offset)
                    chunk = data[offset : offset + size]
                    offset += size
                    is_last = offset >= len(data)
                    conn.send_data(stream_id, chunk, end_stream=end_stream and is_last)
                    await self._flush_unlocked()
                    continue
                waiter = asyncio.get_running_loop().create_future()
                self._window_waiters.append(waiter)
                await self._flush_unlocked()
            await waiter

    def _notify_window_waiters(self) -> None:
        waiters = self._window_waiters
        self._window_waiters = []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    def _fail_window_waiters(self, error: Exception) -> None:
        waiters = self._window_waiters
        self._window_waiters = []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_exception(error)

    async def _acknowledge_received_data(
        self, stream_id: int, flow_controlled_length: int
    ) -> None:
        if flow_controlled_length <= 0:
            return
        async with self._io_lock:
            self._require_conn().acknowledge_received_data(flow_controlled_length, stream_id)
            await self._flush_unlocked()

    async def _reset_stream(self, stream_id: int) -> None:
        async with self._io_lock:
            conn = self._conn
            if conn is None:
                return
            try:
                conn.reset_stream(stream_id)
            except Exception:
                return
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
        try:
            while not self._closed:
                data = await reader.read(65535)
                if not data:
                    self._fail_pending_streams(RuntimeError("Broker connection closed"))
                    return
                async with self._io_lock:
                    events = self._require_conn().receive_data(data)
                    for event in events:
                        if isinstance(event, h2.events.WindowUpdated):
                            self._notify_window_waiters()
                        if isinstance(event, h2.events.StreamReset):
                            self._fail_window_waiters(
                                RuntimeError("Broker stream was reset while sending request body")
                            )
                        if isinstance(event, h2.events.StreamEnded):
                            self._notify_window_waiters()
                        stream_id = getattr(event, "stream_id", None)
                        if stream_id in self._events:
                            self._events[stream_id].put_nowait(event)
                    await self._flush_unlocked()
        except Exception as exc:
            self._fail_pending_streams(
                RuntimeError(f"Broker TLS/connection read loop failed: {exc}")
            )
            return

    def _fail_pending_streams(self, error: Exception) -> None:
        for queue in list(self._events.values()):
            queue.put_nowait(error)
        self._fail_window_waiters(error)

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
        raise RuntimeError("Broker is not connected")

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
    """Create a :class:`VerserBroker` with the given keyword options.

    This is a factory convenience wrapper around ``VerserBroker(**options)``.

    Parameters
    ----------
    **options : Any
        Forwarded directly to :class:`VerserBroker.__init__`.

    Returns
    -------
    VerserBroker
    """
    return VerserBroker(**options)

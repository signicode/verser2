"""ASGI 3 dispatch helpers for the Python Guest.

This module is not a public top-level export of the package.  It is used
internally by :class:`verser2_guest_python.guest.VerserGuest` to convert
Verser envelope metadata into ASGI 3 scope dictionaries and to drive the ASGI
application lifecycle.

ASGI 3 HTTP scope
    The HTTP scope dict follows the ASGI 3.0 specification
    (``asgi.version == "3.0"``, ``asgi.spec_version == "2.5"``)::

        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "http_version": "1.1",
            "method": "<uppercased HTTP method>",
            "scheme": "http",
            "path": "<URL-decoded path>",
            "raw_path": "<URL-encoded path as bytes>",
            "query_string": "<query string as bytes>",
            "headers": [(b"name", b"value"), ...],
            "client": None,
            "server": None,
            "root_path": "",
        }

    The ``receive`` callable yields ``http.request`` events, and the ``send``
    callable accepts ``http.response.start`` and ``http.response.body`` events.

ASGI 3 WebSocket scope
    The WebSocket scope dict follows the ASGI 3.0 specification
    (``asgi.version == "3.0"``, ``asgi.spec_version == "2.5"``)::

        {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "scheme": "ws",
            "path": "<URL-decoded path>",
            "query_string": "<query string as bytes>",
            "headers": [(b"name", b"value"), ...],
            "client": None,
            "server": None,
            "root_path": "",
            "subprotocols": ["<subprotocol>", ...],
            "extensions": None,
        }

    The ``receive`` callable yields ``websocket.connect``, ``websocket.receive``,
    and ``websocket.disconnect`` events.  The ``send`` callable accepts
    ``websocket.accept``, ``websocket.send``, and ``websocket.close`` events.
"""

from __future__ import annotations

from dataclasses import dataclass
import asyncio
from typing import Any, Awaitable, Callable
from urllib.parse import quote, unquote, urlsplit

from .protocol import normalize_headers, sanitize_http2_response_headers


ASGIApp = Callable[
    [
        dict[str, Any],
        Callable[[], Awaitable[dict[str, Any]]],
        Callable[[dict[str, Any]], Awaitable[None]],
    ],
    Awaitable[None],
]
"""Type alias for an ASGI 3 application callable.

Signature: ``async def app(scope, receive, send)``.
"""
DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
VWS_MAX_FRAME_BYTES = 1 * 1024 * 1024
VWS_MAX_QUEUE_MESSAGES = 64
"""Default maximum response body buffer (10 MiB)."""


class ResponseBodyTooLargeError(RuntimeError):
    """Raised by :func:`dispatch_asgi_request` when the buffered response body
    exceeds ``max_response_bytes``.

    This is a buffered/direct-dispatch limit. The buffered dispatcher catches
    this exception and returns an error response with code
    ``"local-handler-failure"``. The streaming lease path does not enforce
    ``max_response_bytes``; after response headers have been sent it can only
    end the stream, not replace the already-started response with an error
    envelope.
    """


class VwsAsgiConnection:
    """Bounded VWS/1 frame adapter used by the live ASGI Guest path."""

    def __init__(self, write: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        self._write = write
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue(
            maxsize=VWS_MAX_QUEUE_MESSAGES
        )
        self._queued_bytes = 0
        self.closed = False
        self.close_sent = False
        self.peer_closed = False

    async def receive(self) -> dict[str, Any]:
        event = await self._events.get()
        self._queued_bytes = max(0, self._queued_bytes - int(event.pop("_bytes", 0)))
        return event

    async def send(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "websocket.accept":
            if event.get("subprotocol") is not None and not isinstance(
                event.get("subprotocol"), str
            ):
                raise ValueError("Invalid WebSocket subprotocol")
            await self._write(
                {"type": "accept", "protocol": event.get("subprotocol") or ""}
            )
        elif event_type == "websocket.send":
            has_text = "text" in event and event["text"] is not None
            has_bytes = "bytes" in event and event["bytes"] is not None
            if has_text == has_bytes:
                raise ValueError("websocket.send requires exactly one payload")
            if has_text:
                if not isinstance(event["text"], str):
                    raise ValueError("websocket.send text must be a string")
                text = event["text"]
                if len(text.encode("utf-8")) + 40 > VWS_MAX_FRAME_BYTES:
                    await self._write(
                        {"type": "close", "code": 1009, "reason": "message too large"}
                    )
                    self.closed = True
                    return
                await self._write({"type": "text", "data": text})
            elif has_bytes:
                import base64

                if not isinstance(event["bytes"], (bytes, bytearray, memoryview)):
                    raise ValueError("websocket.send bytes must be bytes-like")
                payload = bytes(event["bytes"])
                encoded = base64.b64encode(payload).decode("ascii")
                if len(encoded.encode("ascii")) + 40 > VWS_MAX_FRAME_BYTES:
                    await self._write(
                        {"type": "close", "code": 1009, "reason": "message too large"}
                    )
                    self.closed = True
                    return
                await self._write(
                    {
                        "type": "binary",
                        "data": encoded,
                    }
                )
        elif event_type == "websocket.close":
            raw_code = event.get("code", 1000)
            reason = event.get("reason", "")
            if isinstance(raw_code, bool) or not isinstance(raw_code, int):
                raise ValueError("WebSocket close code must be an integer")
            if not isinstance(reason, str):
                raise ValueError("WebSocket close reason must be a string")
            code = raw_code
            if not _valid_close_code(code):
                raise ValueError(f"Invalid WebSocket close code: {code}")
            if len(reason.encode("utf-8")) > 123:
                raise ValueError("WebSocket close reason exceeds 123 UTF-8 bytes")
            await self._write({"type": "close", "code": code, "reason": reason})
            self.close_sent = True
        else:
            raise ValueError(f"Unknown websocket event type: {event_type!r}")

    async def feed(self, frame: dict[str, Any]) -> None:
        if not isinstance(frame, dict):
            await self._protocol_error()
            return
        frame_type = frame.get("type")
        if frame_type == "text":
            data = frame.get("data")
            if not isinstance(data, str):
                await self._protocol_error()
                return
            await self._put_event(
                {"type": "websocket.receive", "text": data}, len(data.encode("utf-8"))
            )
        elif frame_type == "binary":
            import base64

            data = frame.get("data")
            if not isinstance(data, str):
                await self._protocol_error()
                return
            try:
                payload = base64.b64decode(data, validate=True)
            except (ValueError, TypeError):
                await self._protocol_error()
                return
            await self._put_event(
                {"type": "websocket.receive", "bytes": payload}, len(payload)
            )
        elif frame_type == "ping":
            data = frame.get("data", "")
            if (
                not isinstance(data, str)
                or len(data.encode("utf-8")) + 40 > VWS_MAX_FRAME_BYTES
            ):
                await self._protocol_error()
                return
            await self._write({"type": "pong", "data": data})
        elif frame_type == "pong":
            if frame.get("data") is not None and not isinstance(frame.get("data"), str):
                await self._protocol_error()
            return
        elif frame_type == "close":
            raw_code = frame.get("code", 1000)
            reason = frame.get("reason", "")
            if (
                isinstance(raw_code, bool)
                or not isinstance(raw_code, int)
                or not isinstance(reason, str)
            ):
                await self._protocol_error()
                return
            code = raw_code
            if not _valid_close_code(code) or len(reason.encode("utf-8")) > 123:
                await self._protocol_error()
                return
            self.peer_closed = True
            if not self.close_sent:
                await self._write({"type": "close", "code": code, "reason": reason})
                self.close_sent = True
            self.closed = True
            await self._put_event(
                {"type": "websocket.disconnect", "code": code, "reason": reason},
                0,
                True,
            )
        else:
            await self._protocol_error()

    async def _protocol_error(self) -> None:
        if not self.closed:
            await self._write(
                {"type": "close", "code": 1002, "reason": "protocol error"}
            )
            self.close_sent = True
            self.closed = True

    async def _put_event(
        self, event: dict[str, Any], size: int, force: bool = False
    ) -> None:
        if (
            size > VWS_MAX_FRAME_BYTES
            or self._queued_bytes + size > VWS_MAX_FRAME_BYTES
        ):
            if not force:
                await self._protocol_error()
                return
            while not self._events.empty():
                self._events.get_nowait()
            self._queued_bytes = 0
        event["_bytes"] = size
        try:
            self._events.put_nowait(event)
            self._queued_bytes += size
        except asyncio.QueueFull:
            if force:
                self._events.get_nowait()
                self._events.put_nowait(event)
            else:
                await self._protocol_error()

    async def disconnect(self, code: int = 1006) -> None:
        if not self.closed:
            self.closed = True
            try:
                self._events.put_nowait(
                    {"type": "websocket.disconnect", "code": code, "_bytes": 0}
                )
            except asyncio.QueueFull:
                self._events.get_nowait()
                self._events.put_nowait(
                    {"type": "websocket.disconnect", "code": code, "_bytes": 0}
                )


def _valid_close_code(code: int) -> bool:
    return isinstance(code, int) and (
        (1000 <= code <= 1014 and code not in (1004, 1005, 1006))
        or 3000 <= code <= 4999
    )


@dataclass(frozen=True)
class DispatchResponse:
    """Result of dispatching a single request through an ASGI app.

    Contains the buffered response on success, or an error envelope when the
    app raised an exception before sending response headers.

    Attributes
    ----------
    request_id : str
        Original request identifier from the envelope metadata.
    status_code : int or None
        HTTP status code set by the app (``None`` if an error occurred before
        ``http.response.start``).
    headers : dict[str, str] or None
        Response headers (``None`` if an error occurred before
        ``http.response.start``).
    body : bytes
        Concatenated response body chunks.
    error : dict or None
        Error envelope dict with ``code``, ``message``, and ``context`` keys
        when the app raised an exception before response start.
    """

    request_id: str
    status_code: int | None = None
    headers: dict[str, str] | None = None
    body: bytes = b""
    error: dict[str, Any] | None = None


def build_websocket_scope(
    metadata: dict[str, Any], body: bytes = b""
) -> dict[str, Any]:
    """Build an ASGI 3 ``websocket`` scope dict from Verser envelope metadata.

    Parameters
    ----------
    metadata : dict
        Envelope metadata containing at least ``path`` and optionally
        ``headers``.  The path may include a query string which will be
        split into ``path`` and ``query_string``.
    body : bytes
        Initial body data (reserved for future use; not yet reflected in
        the scope).

    Returns
    -------
    dict
        ASGI 3 websocket scope dictionary.
    """
    split = urlsplit(str(metadata.get("path") or "/"))
    path = unquote(split.path or "/")
    headers = [
        (name.encode("ascii", "ignore"), value.encode("utf-8"))
        for name, value in normalize_headers(metadata.get("headers")).items()
    ]
    # Extract subprotocols from the sec-websocket-protocol header.
    subprotocols: list[str] = []
    for name, value in headers:
        if name.lower() == b"sec-websocket-protocol":
            subprotocols = [s.strip() for s in value.decode("utf-8").split(",")]
            break
    return {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.5"},
        "scheme": "ws",
        "path": path,
        "query_string": split.query.encode("ascii"),
        "headers": headers,
        "client": None,
        "server": None,
        "root_path": "",
        "subprotocols": subprotocols,
        "extensions": None,
    }


async def dispatch_asgi_websocket(
    app: ASGIApp,
    guest_id: str,
    metadata: dict[str, Any],
) -> None:
    """Drive a minimal ASGI websocket lifecycle for testing.

    This function builds a websocket scope from *metadata*, then drives
    the ASGI app through a connect → receive-text → receive-binary →
    disconnect sequence.

    The ``receive`` callable yields exactly four events:

    1. ``websocket.connect``
    2. ``websocket.receive`` with ``text`` = ``"hello"``
    3. ``websocket.receive`` with ``bytes`` = ``b"\\x00\\xff\\x7f"``
    4. ``websocket.disconnect`` with ``code`` = ``1000``

    The ``send`` callable accepts ``websocket.accept``, ``websocket.send``,
    and ``websocket.close`` events without raising.

    If the app raises an exception it propagates; callers should handle it.

    Parameters
    ----------
    app : ASGIApp
        The ASGI 3 application callable.
    guest_id : str
        Guest identifier (used in error context; currently passed through
        for future error-reporting integration).
    metadata : dict
        Request envelope metadata.
    """
    scope = build_websocket_scope(metadata)
    events: list[dict[str, Any]] = [
        {"type": "websocket.connect"},
        {"type": "websocket.receive", "text": "hello"},
        {"type": "websocket.receive", "bytes": b"\x00\xff\x7f"},
        {"type": "websocket.disconnect", "code": 1000},
    ]
    event_index = 0

    async def receive() -> dict[str, Any]:
        nonlocal event_index
        if event_index >= len(events):
            return {"type": "websocket.disconnect", "code": 1000}
        event = events[event_index]
        event_index += 1
        return event

    async def send(event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type not in ("websocket.accept", "websocket.send", "websocket.close"):
            raise ValueError(f"Unknown websocket event type: {event_type!r}")

    try:
        await app(scope, receive, send)
    except Exception:
        raise


def build_http_scope(metadata: dict[str, Any]) -> dict[str, Any]:
    """Build an ASGI 3 ``http`` scope dict from Verser envelope metadata.

    Parameters
    ----------
    metadata : dict
        Envelope metadata containing at least ``method``, ``path``, and
        optionally ``headers``.

    Returns
    -------
    dict
        ASGI 3 scope dictionary (see module docstring for the full schema).
    """
    split = urlsplit(str(metadata.get("path") or "/"))
    path = unquote(split.path or "/")
    headers = [
        (name.encode("ascii", "ignore"), value.encode("utf-8"))
        for name, value in normalize_headers(metadata.get("headers")).items()
    ]
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.5"},
        "http_version": "1.1",
        "method": str(metadata.get("method") or "GET").upper(),
        "scheme": "http",
        "path": path,
        "raw_path": quote(path).encode("ascii"),
        "query_string": split.query.encode("ascii"),
        "headers": headers,
        "client": None,
        "server": None,
        "root_path": "",
    }


async def dispatch_asgi_request(
    app: ASGIApp,
    guest_id: str,
    metadata: dict[str, Any],
    body: bytes | list[bytes],
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> DispatchResponse:
    """Dispatch a single request through an ASGI app and collect the response.

    This function drives the ASGI 3 protocol by:

    1.  Building an ``http`` scope via :func:`build_http_scope`.
    2.  Providing ``receive`` that yields ``http.request`` events from the
        body chunks.
    3.  Providing ``send`` that collects ``http.response.start`` and
        ``http.response.body`` events into a buffered response.

    If the app raises an exception **before** sending ``http.response.start``,
    the exception is caught and returned as an error ``DispatchResponse`` with
    code ``"local-handler-failure"``.

    If the app raises an exception **after** sending ``http.response.start``,
    the exception propagates. ``ResponseBodyTooLargeError`` is a buffered body
    limit failure and is caught and returned as an error ``DispatchResponse``.

    Parameters
    ----------
    app : ASGIApp
        The ASGI 3 application callable.
    guest_id : str
        Identifier used in error context.
    metadata : dict
        Request envelope metadata.
    body : bytes or list[bytes]
        Request body chunks.
    max_response_bytes : int
        Maximum cumulative body size before raising
        :exc:`ResponseBodyTooLargeError`.

    Returns
    -------
    DispatchResponse
        Frozen dataclass with the collected response or error.
    """
    request_id = str(metadata.get("requestId") or "")
    started = False
    status_code = 200
    response_headers: dict[str, str] = {}
    response_chunks: list[bytes] = []
    response_bytes = 0
    body_chunks = body if isinstance(body, list) else [body]
    receive_index = 0

    async def receive() -> dict[str, Any]:
        nonlocal receive_index
        if receive_index >= len(body_chunks):
            return {"type": "http.request", "body": b"", "more_body": False}
        chunk = body_chunks[receive_index]
        receive_index += 1
        return {
            "type": "http.request",
            "body": chunk,
            "more_body": receive_index < len(body_chunks),
        }

    async def send(event: dict[str, Any]) -> None:
        nonlocal response_bytes, response_headers, started, status_code
        event_type = event.get("type")
        if event_type == "http.response.start":
            started = True
            status_code = int(event.get("status") or 200)
            response_headers = {
                name.decode("ascii", "ignore").lower(): value.decode("latin-1")
                for name, value in event.get("headers", [])
            }
            return
        if event_type == "http.response.body":
            chunk = bytes(event.get("body") or b"")
            response_bytes += len(chunk)
            if response_bytes > max_response_bytes:
                raise ResponseBodyTooLargeError(
                    f"Response body bytes exceed limit: {response_bytes} > {max_response_bytes}"
                )
            response_chunks.append(chunk)

    try:
        await app(build_http_scope(metadata), receive, send)
    except Exception as error:  # noqa: BLE001 - app exceptions are converted to protocol errors.
        if started and not isinstance(error, ResponseBodyTooLargeError):
            raise
        return DispatchResponse(
            request_id=request_id,
            error={
                "requestId": request_id,
                "code": "local-handler-failure",
                "message": str(error),
                "context": {
                    "guestId": guest_id,
                    "requestId": request_id,
                    "path": str(metadata.get("path") or ""),
                },
            },
        )

    return DispatchResponse(
        request_id=request_id,
        status_code=status_code,
        headers=sanitize_http2_response_headers(response_headers),
        body=b"".join(response_chunks),
    )

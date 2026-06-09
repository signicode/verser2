"""ASGI dispatch helpers for the Python Guest."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import quote, unquote, urlsplit

from .protocol import normalize_headers


ASGIApp = Callable[[dict[str, Any], Callable[[], Awaitable[dict[str, Any]]], Callable[[dict[str, Any]], Awaitable[None]]], Awaitable[None]]


@dataclass(frozen=True)
class DispatchResponse:
    request_id: str
    status_code: int | None = None
    headers: dict[str, str] | None = None
    body: bytes = b""
    error: dict[str, Any] | None = None


def build_http_scope(metadata: dict[str, Any]) -> dict[str, Any]:
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
) -> DispatchResponse:
    request_id = str(metadata.get("requestId") or "")
    started = False
    status_code = 200
    response_headers: dict[str, str] = {}
    response_chunks: list[bytes] = []
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
        nonlocal started, status_code, response_headers
        event_type = event.get("type")
        if event_type == "http.response.start":
            started = True
            status_code = int(event.get("status") or 200)
            response_headers = {
                name.decode("ascii", "ignore").lower(): value.decode("utf-8")
                for name, value in event.get("headers", [])
            }
            return
        if event_type == "http.response.body":
            response_chunks.append(bytes(event.get("body") or b""))

    try:
        await app(build_http_scope(metadata), receive, send)
    except Exception as error:  # noqa: BLE001 - app exceptions are converted to protocol errors.
        if started:
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
        headers=response_headers,
        body=b"".join(response_chunks),
    )

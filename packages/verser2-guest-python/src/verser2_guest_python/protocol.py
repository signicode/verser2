"""Runtime-neutral Verser protocol helpers for the Python Guest.

This module is not a public top-level export.  It provides envelope
encoding/decoding and header normalization used by the Guest and Broker
implementations.

Verser envelope format
    Every message on a lease stream begins with a fixed 6-byte header::

        [version:1][type:1][metadata_length_be:4][metadata_json...][body...]

    ``version`` is always 1.
    ``type`` is 1 (request), 2 (response), or 3 (error).
    ``metadata_length_be`` is a big-endian 4-byte unsigned integer giving the
    byte length of the JSON metadata that follows immediately after.
    The remainder (after metadata) is the request/response body.
"""

from __future__ import annotations

import json
import struct
from typing import Any, Iterable


VERSER_ENVELOPE_VERSION = 1
VERSER_ENVELOPE_PREFIX_BYTES = 6
VERSER_ENVELOPE_TYPES = {"request": 1, "response": 2, "error": 3}
VERSER_ENVELOPE_TYPE_NAMES = {value: key for key, value in VERSER_ENVELOPE_TYPES.items()}


def encode_envelope(envelope_type: str, metadata: dict[str, Any]) -> bytes:
    """Encode *metadata* as a Verser envelope prefixed with header bytes.

    Parameters
    ----------
    envelope_type : str
        One of ``"request"``, ``"response"``, or ``"error"``.
    metadata : dict
        JSON-serialisable metadata dict.

    Returns
    -------
    bytes
        The complete envelope header + metadata JSON (no trailing body).
    """
    type_code = VERSER_ENVELOPE_TYPES[envelope_type]
    if envelope_type == "response":
        _validate_response_envelope_metadata(metadata)
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    return bytes([VERSER_ENVELOPE_VERSION, type_code]) + struct.pack(
        ">I", len(metadata_bytes)
    ) + metadata_bytes


def decode_envelope(buffer: bytes) -> tuple[str, dict[str, Any], bytes]:
    """Decode a Verser envelope from a byte buffer.

    Parameters
    ----------
    buffer : bytes
        At least ``VERSER_ENVELOPE_PREFIX_BYTES`` (6) bytes.

    Returns
    -------
    tuple of (str, dict, bytes)
        ``(envelope_type, metadata_dict, remainder_body)``.

    Raises
    ------
    ValueError
        If the buffer is too short, the version is unsupported, the type code
        is unknown, or the metadata JSON is truncated.
    """
    if len(buffer) < VERSER_ENVELOPE_PREFIX_BYTES:
        raise ValueError("Verser envelope prefix is incomplete")
    version = buffer[0]
    if version != VERSER_ENVELOPE_VERSION:
        raise ValueError(f"Unsupported Verser envelope version: {version}")
    envelope_type = VERSER_ENVELOPE_TYPE_NAMES.get(buffer[1])
    if envelope_type is None:
        raise ValueError(f"Unsupported Verser envelope type: {buffer[1]}")
    metadata_length = struct.unpack(">I", buffer[2:6])[0]
    metadata_end = VERSER_ENVELOPE_PREFIX_BYTES + metadata_length
    if len(buffer) < metadata_end:
        raise ValueError("Verser envelope metadata is incomplete")
    metadata = json.loads(buffer[VERSER_ENVELOPE_PREFIX_BYTES:metadata_end].decode("utf-8"))
    return envelope_type, metadata, buffer[metadata_end:]


def normalize_headers(headers: dict[str, Any] | None) -> dict[str, str]:
    """Normalize a headers dict to lowercase string keys/values.

    *   Keys are lowercased with ``str(name).lower()``.
    *   Values are converted to strings; lists are joined with ``","``.
    *   ``None`` values are dropped.

    Parameters
    ----------
    headers : dict or None
        Raw headers dict (may have mixed-case keys, list values, etc.).

    Returns
    -------
    dict[str, str]
        Normalised headers.
    """
    normalized: dict[str, str] = {}
    for name, value in (headers or {}).items():
        if value is None:
            continue
        if isinstance(value, list):
            normalized[str(name).lower()] = ",".join(str(item) for item in value)
            continue
        normalized[str(name).lower()] = str(value)
    return normalized


def validate_local_headers(headers: dict[str, Any] | None) -> dict[str, str]:
    """Validate Broker API header input before it reaches the transport.

    Local input failures are ``ValueError``; protocol metadata decoders retain
    their separate malformed-remote-data handling.
    """
    normalized: dict[str, str] = {}
    for name, value in (headers or {}).items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError("Local HTTP headers must use string names and values")
        if not _valid_header_name(name):
            raise ValueError(f"Invalid local HTTP header name: {name}")
        if not _valid_header_value(value):
            raise ValueError(f"Invalid local HTTP header value for {name}")
        normalized_name = name.lower()
        if normalized_name in {"connection", "upgrade", "keep-alive"}:
            raise ValueError(f"Forbidden local HTTP header: {normalized_name}")
        normalized[normalized_name] = value
    return normalized


class RemoteRequestMetadataError(ValueError):
    """Malformed request metadata received from a Host lease stream."""


def validate_remote_request_metadata(metadata: object) -> dict[str, Any]:
    """Validate Host-supplied request metadata before ASGI scope construction.

    This is intentionally distinct from local Broker API validation: callers
    must classify this as a wire protocol failure rather than application input.
    """
    if not isinstance(metadata, dict):
        raise RemoteRequestMetadataError("Request metadata must be an object")
    headers = metadata.get("headers", {})
    if not isinstance(headers, dict):
        raise RemoteRequestMetadataError("Request metadata headers must be an object")
    normalized: dict[str, str] = {}
    for name, value in headers.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise RemoteRequestMetadataError("Invalid request metadata header")
        normalized_name = name.lower()
        if (
            not _valid_header_name(normalized_name)
            or not _valid_header_value(value)
            or normalized_name in {"connection", "upgrade", "keep-alive"}
        ):
            raise RemoteRequestMetadataError("Invalid request metadata header")
        normalized[normalized_name] = value
    return {**metadata, "headers": normalized}


# Standard HTTP/1 hop-by-hop headers that MUST NOT be forwarded over HTTP/2.
_HOP_BY_HOP_HEADERS: set[str] = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
_VERSER_RESPONSE_METADATA_HEADER = "x-verser-response-metadata"
_VERSER_RESPONSE_METADATA_VERSION = 1
_VERSER_RESPONSE_METADATA_MAX_BYTES = 4096
_VERSER_RESPONSE_METADATA_MAX_HEADER_PAIRS = 64
_VERSER_RESPONSE_METADATA_MAX_STATUS_TEXT_BYTES = 1024
_HTTP_TOKEN_BYTES = frozenset(
    b"!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

ResponseHeaderPair = tuple[str, str]


def validate_final_response_status(status: object) -> int:
    """Return a final application response status or raise ``ValueError``."""
    if isinstance(status, bool) or not isinstance(status, int) or not 200 <= status <= 599:
        raise ValueError("Response status must be an integer from 200 through 599")
    return status


def asgi_response_header_pairs(
    headers: Iterable[Iterable[bytes]],
) -> list[ResponseHeaderPair]:
    """Validate and decode ASGI response tuples without collapsing repetitions."""
    pairs: list[ResponseHeaderPair] = []
    for pair in headers:
        try:
            name, value = pair
        except (TypeError, ValueError):
            raise ValueError("ASGI response headers must be byte pairs")
        if not isinstance(name, bytes) or not isinstance(value, bytes):
            raise ValueError("ASGI response headers must be byte pairs")
        if not name or any(byte not in _HTTP_TOKEN_BYTES for byte in name):
            raise ValueError("Invalid ASGI response header name")
        decoded_value = value.decode("latin-1")
        if any(
            code <= 0x08 or 0x0A <= code <= 0x1F or code == 0x7F
            for code in map(ord, decoded_value)
        ):
            raise ValueError("Invalid ASGI response header value")
        pairs.append((name.decode("ascii").lower(), decoded_value))
    return pairs


def sanitize_http2_response_header_pairs(
    header_pairs: Iterable[ResponseHeaderPair],
) -> list[ResponseHeaderPair]:
    """Sanitize ordered response header pairs while preserving surviving order."""
    normalized_pairs = [(name.lower(), value) for name, value in header_pairs]
    connection_tokens: set[str] = set()
    for name, value in normalized_pairs:
        if name == "connection":
            connection_tokens.update(
                token.strip().lower() for token in value.split(",") if token.strip()
            )
    return [
        (name, value)
        for name, value in normalized_pairs
        if name not in _HOP_BY_HOP_HEADERS
        and name not in connection_tokens
        and name != _VERSER_RESPONSE_METADATA_HEADER
    ]


def flatten_response_header_pairs(
    header_pairs: Iterable[ResponseHeaderPair],
) -> dict[str, str]:
    """Return the legacy last-value-wins response-header projection."""
    return {name: value for name, value in header_pairs}


def decode_response_metadata(value: object) -> dict[str, Any]:
    """Strictly decode the final Host-to-Broker response metadata header."""
    if not isinstance(value, str):
        raise ValueError("Response metadata must be a string")
    if _utf8_byte_length(value) > _VERSER_RESPONSE_METADATA_MAX_BYTES:
        raise ValueError("Response metadata exceeds maximum encoded bytes")
    try:
        metadata = json.loads(value)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid response metadata JSON") from exc
    if not isinstance(metadata, dict):
        raise ValueError("Response metadata must be an object")
    allowed = {"version", "requestId", "statusCode", "statusText", "headers"}
    if any(key not in allowed for key in metadata):
        raise ValueError("Response metadata has unknown fields")
    if metadata.get("version") != _VERSER_RESPONSE_METADATA_VERSION:
        raise ValueError("Unsupported response metadata version")
    request_id = metadata.get("requestId")
    if (
        not isinstance(request_id, str)
        or not request_id.strip()
        or not _is_well_formed_unicode(request_id)
    ):
        raise ValueError("Response metadata requestId must be a non-empty string")
    try:
        status_code = validate_final_response_status(metadata.get("statusCode"))
    except ValueError as exc:
        raise ValueError("Response metadata statusCode must be a final status (200-599)") from exc
    status_text = metadata.get("statusText")
    if "statusText" in metadata and (
        not isinstance(status_text, str)
        or _utf8_byte_length(status_text) > _VERSER_RESPONSE_METADATA_MAX_STATUS_TEXT_BYTES
        or not _valid_header_value(status_text)
    ):
        raise ValueError("Invalid response metadata status text")
    raw_pairs = metadata.get("headers")
    if not isinstance(raw_pairs, list) or len(raw_pairs) > _VERSER_RESPONSE_METADATA_MAX_HEADER_PAIRS:
        raise ValueError("Invalid response metadata header pairs")
    pairs: list[ResponseHeaderPair] = []
    for pair in raw_pairs:
        if (
            not isinstance(pair, list)
            or len(pair) != 2
            or not isinstance(pair[0], str)
            or not isinstance(pair[1], str)
            or not _valid_header_name(pair[0])
            or not _valid_header_value(pair[1])
        ):
            raise ValueError("Invalid response metadata header pair")
        pairs.append((pair[0].lower(), pair[1]))
    if sanitize_http2_response_header_pairs(pairs) != pairs:
        raise ValueError("Response metadata contains forbidden header pair")
    decoded: dict[str, Any] = {
        "version": _VERSER_RESPONSE_METADATA_VERSION,
        "requestId": request_id,
        "statusCode": status_code,
        "headers": pairs,
    }
    if "statusText" in metadata:
        decoded["statusText"] = status_text
    return decoded


def _valid_header_name(value: str) -> bool:
    return bool(value) and value.isascii() and all(
        byte in _HTTP_TOKEN_BYTES for byte in value.encode("ascii")
    )


def _valid_header_value(value: str) -> bool:
    return (
        _is_well_formed_unicode(value)
        and all(ord(character) <= 0xFF for character in value)
        and not any(
            code <= 0x08 or 0x0A <= code <= 0x1F or code == 0x7F
            for code in map(ord, value)
        )
    )


def _validate_response_envelope_metadata(metadata: dict[str, Any]) -> None:
    """Reject response values that cannot safely reach byte-oriented peers."""
    status_text = metadata.get("statusText")
    if "statusText" in metadata and (
        not isinstance(status_text, str)
        or _utf8_byte_length(status_text) > _VERSER_RESPONSE_METADATA_MAX_STATUS_TEXT_BYTES
        or not _valid_header_value(status_text)
    ):
        raise ValueError("Invalid response status text")

    headers = metadata.get("headers")
    if headers is not None:
        if not isinstance(headers, dict) or any(
            not isinstance(name, str)
            or not isinstance(value, str)
            or not _valid_header_name(name)
            or not _valid_header_value(value)
            for name, value in headers.items()
        ):
            raise ValueError("Invalid response headers")

    header_pairs = metadata.get("headerPairs")
    if header_pairs is not None:
        if not isinstance(header_pairs, (list, tuple)):
            raise ValueError("Invalid response header pairs")
        for pair in header_pairs:
            if (
                not isinstance(pair, (list, tuple))
                or len(pair) != 2
                or not isinstance(pair[0], str)
                or not isinstance(pair[1], str)
                or not _valid_header_name(pair[0])
                or not _valid_header_value(pair[1])
            ):
                raise ValueError("Invalid response header pair")


def _utf8_byte_length(value: str) -> int:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError("Response metadata contains malformed Unicode") from exc


def _is_well_formed_unicode(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def sanitize_http2_response_headers(headers: dict[str, str]) -> dict[str, str]:
    """Remove HTTP/1 hop-by-hop headers from *headers* for HTTP/2 transport.

    Strips:
    - Standard hop-by-hop headers (connection, keep-alive,
      proxy-authenticate, proxy-authorization, te, trailer,
      transfer-encoding, upgrade).
    - Any header whose name appears as a value in the ``Connection`` header
      (parsed as a comma-separated list of tokens).

    Parameters
    ----------
    headers : dict[str, str]
        Response headers (lowercased keys).

    Returns
    -------
    dict[str, str]
        Sanitized headers with hop-by-hop entries removed.
    """
    connection_tokens: set[str] = set()
    for name, value in headers.items():
        if name.lower() == "connection":
            for token in value.split(","):
                trimmed = token.strip().lower()
                if trimmed:
                    connection_tokens.add(trimmed)

    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in _HOP_BY_HOP_HEADERS
        and name.lower() not in connection_tokens
        and name.lower() != _VERSER_RESPONSE_METADATA_HEADER
    }

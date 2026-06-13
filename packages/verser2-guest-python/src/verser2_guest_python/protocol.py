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
from typing import Any


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

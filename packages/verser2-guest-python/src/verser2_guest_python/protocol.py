"""Runtime-neutral Verser protocol helpers for the Python Guest."""

from __future__ import annotations

import json
import struct
from typing import Any


VERSER_ENVELOPE_VERSION = 1
VERSER_ENVELOPE_PREFIX_BYTES = 6
VERSER_ENVELOPE_TYPES = {"request": 1, "response": 2, "error": 3}
VERSER_ENVELOPE_TYPE_NAMES = {value: key for key, value in VERSER_ENVELOPE_TYPES.items()}


def encode_envelope(envelope_type: str, metadata: dict[str, Any]) -> bytes:
    type_code = VERSER_ENVELOPE_TYPES[envelope_type]
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    return bytes([VERSER_ENVELOPE_VERSION, type_code]) + struct.pack(
        ">I", len(metadata_bytes)
    ) + metadata_bytes


def decode_envelope(buffer: bytes) -> tuple[str, dict[str, Any], bytes]:
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
    normalized: dict[str, str] = {}
    for name, value in (headers or {}).items():
        if value is None:
            continue
        if isinstance(value, list):
            normalized[str(name).lower()] = ", ".join(str(item) for item in value)
            continue
        normalized[str(name).lower()] = str(value)
    return normalized

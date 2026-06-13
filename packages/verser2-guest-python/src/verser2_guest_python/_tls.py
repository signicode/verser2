"""Private TLS helpers shared by Python Guest and Broker transports."""

from __future__ import annotations

import asyncio
import os
import ssl
import tempfile


def create_client_ssl_context(
    *,
    tls_ca_file: str | None = None,
    tls_cert_file: str | None = None,
    tls_key_file: str | None = None,
    tls_key_password: str | None = None,
    tls_pfx_file: str | None = None,
    tls_pfx_password: str | None = None,
) -> ssl.SSLContext:
    """Create a TLS client context for Verser HTTP/2 peers."""
    context = ssl.create_default_context(cafile=tls_ca_file)
    context.set_alpn_protocols(["h2"])
    if tls_cert_file is not None:
        context.load_cert_chain(
            certfile=str(tls_cert_file),
            keyfile=None if tls_key_file is None else str(tls_key_file),
            password=tls_key_password,
        )
    if tls_pfx_file is not None:
        load_pfx_client_identity(
            context,
            str(tls_pfx_file),
            None if tls_pfx_password is None else str(tls_pfx_password),
        )
    return context


def load_pfx_client_identity(
    context: ssl.SSLContext, pfx_file: str, password: str | None = None
) -> None:
    """Load a PFX/PKCS12 client identity into an SSL context.

    Python's :mod:`ssl` loads client identities from PEM files, so PFX input is
    converted to a temporary PEM file.  The temporary file is closed before
    ``SSLContext.load_cert_chain()`` for Windows compatibility, then removed.
    """
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.serialization import pkcs12
    except ImportError as exc:
        raise RuntimeError(
            "PFX/PKCS12 client identity support requires the cryptography package"
        ) from exc

    with open(pfx_file, "rb") as handle:
        key, certificate, additional_certificates = pkcs12.load_key_and_certificates(
            handle.read(), None if password is None else password.encode("utf-8")
        )
    if key is None or certificate is None:
        raise RuntimeError("PFX/PKCS12 client identity must contain a private key and certificate")

    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    pem += certificate.public_bytes(serialization.Encoding.PEM)
    for extra_certificate in additional_certificates or []:
        pem += extra_certificate.public_bytes(serialization.Encoding.PEM)

    identity_path: str | None = None
    with tempfile.NamedTemporaryFile("wb", delete=False) as identity_file:
        identity_path = identity_file.name
        identity_file.write(pem)
        identity_file.flush()
    try:
        context.load_cert_chain(identity_path)
    finally:
        if identity_path is not None:
            try:
                os.unlink(identity_path)
            except FileNotFoundError:
                pass


def validate_h2_alpn(writer: asyncio.StreamWriter, *, peer_kind: str, peer_id: str) -> None:
    """Require TLS ALPN negotiation to select HTTP/2."""
    get_extra_info = getattr(writer, "get_extra_info", None)
    if not callable(get_extra_info):
        return
    ssl_object = get_extra_info("ssl_object")
    selected = getattr(ssl_object, "selected_alpn_protocol", None)
    if not callable(selected):
        return
    protocol = selected()
    if protocol != "h2":
        raise RuntimeError(
            f"TLS ALPN negotiation for {peer_kind} {peer_id} selected {protocol!r}; "
            "HTTP/2 'h2' is required"
        )

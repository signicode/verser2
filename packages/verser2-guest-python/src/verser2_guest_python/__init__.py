"""Verser2 Python Guest and Broker — outbound HTTP/2 peers for the Verser routing fabric.

This package lets Python applications act as a **Guest** (hosting ASGI
applications behind a Verser Host) or a **Broker** (issuing routed HTTP
requests to advertised Guest routes).

Public exports
--------------
``VERSER2_GUEST_PYTHON_PACKAGE_NAME``
    Package identifier constant.

``create_verser_guest`` / ``VerserGuest``
    Create an outbound Guest peer that connects to a Verser Host, registers
    as ``guest``, and dispatches incoming routed requests to an ASGI app.

``create_verser_broker`` / ``VerserBroker`` / ``VerserBrokerResponse``
    Create an outbound Broker peer that connects to a Verser Host, registers
    as ``broker``, and sends HTTP requests to target Guests via advertised
    route hostname matching.

Lifecycle
---------
1.  Instantiate the peer with connection parameters.
2.  ``await peer.connect()`` — establishes TLS with ALPN ``h2``, performs
    HTTP/2 handshake, and registers with the Host.
3.  Use the peer (dispatch requests for a Guest, or call ``request()`` for a
    Broker).
4.  ``await peer.close()`` — tears down the connection gracefully.

TLS
---
-   All connections use TLS with ALPN ``h2``.
-   CA trust is configured via ``tls_ca_file``.
-   Broker client identity supports PEM (``tls_cert_file`` / ``tls_key_file``
    / ``tls_key_password``) and PFX/PKCS12 files (``tls_pfx_file`` /
    ``tls_pfx_password``, requires the ``cryptography`` package).

Thread safety
-------------
These classes are **not** thread-safe. Use them from a single async context.
"""

from .broker import VerserBroker, VerserBrokerResponse, create_verser_broker
from .guest import VerserGuest, create_verser_guest

VERSER2_GUEST_PYTHON_PACKAGE_NAME = "@signicode/verser2-guest-python"

__all__ = [
    "VERSER2_GUEST_PYTHON_PACKAGE_NAME",
    "VerserBroker",
    "VerserBrokerResponse",
    "VerserGuest",
    "create_verser_broker",
    "create_verser_guest",
]

"""Python ASGI Guest package for Verser2."""

from .guest import VerserGuest, create_verser_guest

VERSER2_GUEST_PYTHON_PACKAGE_NAME = "@signicode/verser2-guest-python"

__all__ = ["VERSER2_GUEST_PYTHON_PACKAGE_NAME", "VerserGuest", "create_verser_guest"]

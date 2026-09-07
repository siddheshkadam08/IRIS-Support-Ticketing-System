"""
Signing — the mirror of shared/hmac-utils/ts/sign.ts.

Used by a Python integrating product to sign outbound API calls, and by
ai-service if it ever needs to call the platform directly.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Union

from .canonical import BodyLike, build_canonical_string, build_webhook_payload


def sign_request(
    secret: str,
    method: str,
    path: str,
    timestamp: Union[int, str],
    nonce: str,
    body: BodyLike = "",
) -> str:
    """Hex HMAC-SHA256 over the canonical request string."""
    canonical = build_canonical_string(method, path, timestamp, nonce, body)
    return hmac.new(
        secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def sign_webhook(secret: str, timestamp: Union[int, str], raw_body: str) -> str:
    """Hex HMAC-SHA256 over `{timestamp}.{raw_body}`."""
    payload = build_webhook_payload(timestamp, raw_body)
    return hmac.new(
        secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def request_signature_header(
    secret: str,
    method: str,
    path: str,
    timestamp: Union[int, str],
    nonce: str,
    body: BodyLike = "",
) -> str:
    """The `X-IRIS-Signature` header value for a request."""
    return f"v1={sign_request(secret, method, path, timestamp, nonce, body)}"


def webhook_signature_header(
    secret: str, timestamp: Union[int, str], raw_body: str
) -> str:
    """The `X-IRIS-Signature` header value for a webhook."""
    return f"t={timestamp},v1={sign_webhook(secret, timestamp, raw_body)}"

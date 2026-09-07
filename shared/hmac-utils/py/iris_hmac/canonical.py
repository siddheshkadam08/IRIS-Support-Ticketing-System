"""
Canonical request string — docs/api-contract.md §3.1.

    v1 \\n METHOD \\n PATH_WITH_QUERY \\n TIMESTAMP \\n NONCE \\n sha256_hex(RAW_BODY)

This is a line-for-line mirror of shared/hmac-utils/ts/canonical.ts. Both are
asserted against the same vectors.json, so a divergence between them is a
failing test rather than a mystery at an integration boundary.

Two deliberate properties, identical to the TypeScript side:
  - We hash the body rather than signing it directly, so large uploads stream
    and body encoding never matters.
  - Method and path are INSIDE the signature, so a captured request cannot be
    replayed against a different endpoint.
"""

from __future__ import annotations

import hashlib
from typing import Union

SIGNATURE_VERSION = "v1"

BodyLike = Union[str, bytes, None]


def sha256_hex(body: BodyLike = "") -> str:
    """Lowercase hex SHA-256 of the raw body. Empty body hashes the empty string."""
    if body is None:
        body = ""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    return hashlib.sha256(raw).hexdigest()


def build_canonical_string(
    method: str,
    path: str,
    timestamp: Union[int, str],
    nonce: str,
    body: BodyLike = "",
) -> str:
    """Six lines joined with LF (0x0A). No trailing newline."""
    return "\n".join(
        [
            SIGNATURE_VERSION,
            method.upper(),
            path,
            str(timestamp),
            nonce,
            sha256_hex(body),
        ]
    )


def build_webhook_payload(timestamp: Union[int, str], raw_body: str) -> str:
    """Webhook signing is Stripe-style — `{timestamp}.{raw_body}` — §6.3."""
    return f"{timestamp}.{raw_body}"

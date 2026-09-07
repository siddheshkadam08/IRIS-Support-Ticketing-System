"""
Verification — the mirror of shared/hmac-utils/ts/verify.ts.

This is the half an INTEGRATING PRODUCT runs: it verifies webhooks and access
callbacks the platform sends. Semantics match the TypeScript exactly, including
the failure reasons, so the two sides cannot drift.
"""

from __future__ import annotations

import hmac
import re
import time
from dataclasses import dataclass
from typing import Optional, Union

from .canonical import BodyLike
from .sign import sign_request, sign_webhook

#: Default replay window, ±300s — docs/api-contract.md §3.2.
TIMESTAMP_WINDOW_SECONDS = 300

_HEX64 = re.compile(r"^[a-f0-9]{64}$", re.IGNORECASE)


@dataclass(frozen=True)
class VerifyResult:
    """`ok` plus, on failure, one of the documented reason codes."""

    ok: bool
    reason: Optional[str] = None

    def __bool__(self) -> bool:  # so `if verify(...)` reads naturally
        return self.ok


def safe_equal_hex(a: str, b: str) -> bool:
    """
    Constant-time comparison.

    A plain `==` on a signature is a timing oracle, so this is not styling —
    it is the reason the function exists. `compare_digest` is Python's
    equivalent of Node's `timingSafeEqual`.
    """
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def parse_request_signature(header: Optional[str]) -> Optional[str]:
    """Strips an optional `v1=` prefix."""
    if not header:
        return None
    trimmed = header.strip()
    if trimmed.startswith("v1="):
        return trimmed[3:]
    if _HEX64.match(trimmed):
        return trimmed
    return None


def parse_webhook_signature(header: Optional[str]) -> Optional[dict]:
    """Parses the Stripe-style `t=...,v1=...` header."""
    if not header:
        return None
    timestamp = signature = None
    for part in header.split(","):
        piece = part.strip()
        if "=" not in piece:
            continue
        key, value = piece.split("=", 1)
        if key == "t":
            timestamp = value
        elif key == "v1":
            signature = value
    if not timestamp or not signature:
        return None
    return {"timestamp": timestamp, "signature": signature}


def is_timestamp_fresh(
    timestamp: Union[int, str],
    now_seconds: Optional[int] = None,
    window_seconds: int = TIMESTAMP_WINDOW_SECONDS,
) -> bool:
    """Rejects anything outside ±window, so a captured payload cannot be replayed later."""
    if now_seconds is None:
        now_seconds = int(time.time())
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    return abs(now_seconds - ts) <= window_seconds


def verify_request(
    secret: str,
    method: str,
    path: str,
    timestamp: Union[int, str],
    nonce: str,
    signature_header: Optional[str],
    body: BodyLike = "",
    now: Optional[int] = None,
    window_seconds: int = TIMESTAMP_WINDOW_SECONDS,
) -> VerifyResult:
    """
    Verify an inbound API request signature.

    Nonce replay is checked separately by the caller (it needs shared storage);
    this is the pure, testable half — same split as the TypeScript.
    """
    provided = parse_request_signature(signature_header)
    if provided is None:
        return VerifyResult(False, "malformed_signature")
    if not is_timestamp_fresh(timestamp, now, window_seconds):
        return VerifyResult(False, "timestamp_out_of_window")
    expected = sign_request(secret, method, path, timestamp, nonce, body)
    if safe_equal_hex(expected, provided):
        return VerifyResult(True)
    return VerifyResult(False, "signature_invalid")


def verify_webhook(
    secret: str,
    raw_body: str,
    signature_header: Optional[str],
    now: Optional[int] = None,
    window_seconds: int = TIMESTAMP_WINDOW_SECONDS,
) -> VerifyResult:
    """
    Verify an inbound webhook or access callback.

    ⚠️ `raw_body` must be the RAW request bytes, decoded but not re-serialised.
    Parsing JSON and dumping it again changes whitespace and key order, and
    every signature then fails — the single most common integration bug.
    """
    parsed = parse_webhook_signature(signature_header)
    if parsed is None:
        return VerifyResult(False, "malformed_signature")
    if not is_timestamp_fresh(parsed["timestamp"], now, window_seconds):
        return VerifyResult(False, "timestamp_out_of_window")
    expected = sign_webhook(secret, parsed["timestamp"], raw_body)
    if safe_equal_hex(expected, parsed["signature"]):
        return VerifyResult(True)
    return VerifyResult(False, "signature_invalid")

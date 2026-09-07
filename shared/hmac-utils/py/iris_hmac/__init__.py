"""
IRIS HMAC utilities — Python.

The mirror of `shared/hmac-utils/ts/`. Both implementations are asserted
against the SAME `shared/hmac-utils/vectors.json`, so if the two ever diverge
CI fails immediately rather than an integrator discovering it at 2am.

Used by Python integrating products, and by `ai-service` if it ever needs to
call the platform directly.

    from iris_hmac import sign_request, verify_webhook

    sig = sign_request(secret, "POST", "/v1/tickets", ts, nonce, body)

    result = verify_webhook(webhook_secret, raw_body, request.headers["X-IRIS-Signature"])
    if not result.ok:
        return 401, {"error": result.reason}
"""

from .canonical import (
    SIGNATURE_VERSION,
    build_canonical_string,
    build_webhook_payload,
    sha256_hex,
)
from .sign import (
    request_signature_header,
    sign_request,
    sign_webhook,
    webhook_signature_header,
)
from .verify import (
    TIMESTAMP_WINDOW_SECONDS,
    VerifyResult,
    is_timestamp_fresh,
    parse_request_signature,
    parse_webhook_signature,
    safe_equal_hex,
    verify_request,
    verify_webhook,
)

__all__ = [
    "SIGNATURE_VERSION",
    "TIMESTAMP_WINDOW_SECONDS",
    "VerifyResult",
    "build_canonical_string",
    "build_webhook_payload",
    "is_timestamp_fresh",
    "parse_request_signature",
    "parse_webhook_signature",
    "request_signature_header",
    "safe_equal_hex",
    "sha256_hex",
    "sign_request",
    "sign_webhook",
    "verify_request",
    "verify_webhook",
    "webhook_signature_header",
]

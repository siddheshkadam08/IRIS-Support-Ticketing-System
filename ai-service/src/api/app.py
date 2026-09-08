"""FastAPI application for the IRIS AI service.

Stateless inference. Text in, predictions out. It never opens a database
connection, never triggers a state change, and never sends anything to a
customer.

Phase 1 exposes three endpoints and one stub feature. That is the entire
surface, deliberately.
"""

from __future__ import annotations

import inspect
import json
import logging
import time

import structlog
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from iris_hmac import verify_request

from ..config import config
from .features import FEATURES, FeatureError
from .schemas import AIError, AIResult, ExecuteRequest

logging.basicConfig(level=config.log_level.upper())
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger(service="ai-service")

app = FastAPI(title="IRIS AI Service", version="1.0.0")

SERVICE_START = time.time()

#: The complete set of callers permitted to reach /v1/execute, each with its
#: OWN secret.
#:
#: A CLOSED MAP, not a lookup with a fallback — an unknown service id is a 401,
#: so adding a caller is a deliberate code change. This mirrors `secretFor()` in
#: core-service/src/internal/service-auth.ts, which solves the same problem on
#: the other side of the boundary.
#:
#: Phase 11 added `core`. Hybrid retrieval needs a query embedding on a
#: synchronous user-facing request, where the worker is not on the path. Its
#: secret is distinct from the worker's, so leaking one grants nothing about the
#: other.
def _allowed_services() -> dict[str, str]:
    return {
        "worker": config.hmac_secret,
        "core": config.core_hmac_secret,
    }


def _error(status: int, kind: str, code: str, message: str) -> JSONResponse:
    """Every failure is an AIError so the caller can classify it without prose."""
    return JSONResponse(
        status_code=status,
        content={"error": AIError(kind=kind, code=code, message=message).model_dump()},
    )


@app.get("/health")
async def health() -> dict[str, object]:
    """Liveness ONLY.

    Deliberately checks nothing. A dependency check here means one slow model
    load takes the whole service out of rotation — see /SKILLS.md section 3.1.
    """
    return {
        "status": "ok",
        "service": "ai-service",
        "version": "1.0.0",
        "uptime_s": round(time.time() - SERVICE_START),
    }


@app.get("/health/ready")
async def ready() -> dict[str, object]:
    """Readiness.

    Phase 1 loads no models, so this is ready immediately. The endpoint exists
    now so Phase 7 has somewhere to answer "still loading" with a 503, which is
    what lets the worker retry honestly instead of receiving a 3-second
    response from a cold transformer.
    """
    return {"status": "ready", "models_loaded": True, "features": sorted(FEATURES)}


@app.post("/v1/execute")
async def execute(
    request: Request,
    x_iris_service_id: str | None = Header(default=None, alias="x-iris-service-id"),
    x_iris_timestamp: str | None = Header(default=None, alias="x-iris-timestamp"),
    x_iris_nonce: str | None = Header(default=None, alias="x-iris-nonce"),
    x_iris_signature: str | None = Header(default=None, alias="x-iris-signature"),
) -> JSONResponse:
    """Dispatch on `feature`. One endpoint, one queue, many capabilities."""

    # ── Phase 2: HMAC service authentication ────────────────────────────
    #
    # Read the RAW BYTES first. `await request.json()` would parse and discard
    # them, and hashing a re-serialised object is the single most common HMAC
    # integration bug: json.dumps changes whitespace and key order, so every
    # signature would fail for reasons that look like broken crypto.
    raw_body = await request.body()

    secret = _allowed_services().get(x_iris_service_id or "")
    if secret is None:
        # A closed set, not a lookup with a fallback. An unknown service id is
        # rejected before the body is read or parsed.
        return _error(401, "permanent", "unauthenticated", "Service authentication failed.")

    if not x_iris_timestamp or not x_iris_nonce or not x_iris_signature:
        return _error(401, "permanent", "unauthenticated", "Service authentication failed.")

    # Path WITH query string, matching the canonical rule in
    # docs/api-contract.md §3.1 — even though /v1/execute takes no query today.
    query = request.url.query
    signed_path = request.url.path + (f"?{query}" if query else "")

    auth = verify_request(
        # THE CALLER'S OWN secret, resolved from the closed map above. Using a
        # single shared secret here would silently undo the key separation the
        # map exists to create.
        secret,
        request.method,
        signed_path,
        x_iris_timestamp,
        x_iris_nonce,
        x_iris_signature,
        raw_body,
    )
    if not auth.ok:
        # Reason logged, never returned: an attacker should not learn whether
        # the timestamp or the signature was the problem.
        log.warning(
            "auth.failed",
            service_id=x_iris_service_id,
            method=request.method,
            path=signed_path,
            reason=auth.reason,
            request_id=request.headers.get("x-request-id"),
        )
        return _error(401, "permanent", "unauthenticated", "Service authentication failed.")

    # NO NONCE STORE, deliberately. This service is stateless (a frozen
    # invariant), /v1/execute is a pure function with no side effects, and a
    # replay merely recomputes an answer it already gave. Caching nonces here
    # would break horizontal scaling to prevent nothing. Core owns replay
    # protection, because Core is where a replay could change state.

    # Parse the SAME bytes that were verified.
    try:
        raw = json.loads(raw_body)
    except (ValueError, UnicodeDecodeError) as exc:
        return _error(422, "permanent", "invalid_request", str(exc)[:200])

    try:
        req = ExecuteRequest.model_validate(raw)
    except Exception as exc:  # pydantic ValidationError
        # A malformed request will be malformed again on retry.
        return _error(422, "permanent", "invalid_request", str(exc)[:500])

    handler = FEATURES.get(req.feature)
    if handler is None:
        # The feature may be DECLARED in the shared contract but not built in
        # this phase. Either way, retrying cannot make it exist.
        return _error(
            422,
            "permanent",
            "unsupported_feature",
            f"feature '{req.feature}' is not implemented in this service",
        )

    # request_id on every line; ticket text NEVER logged — descriptions are
    # customer PII and the logger is the only place that rule can be enforced
    # once rather than at every call site.
    bound = log.bind(request_id=req.request_id, feature=req.feature)
    bound.info("execute.start")

    try:
        # Handlers are sync (pure CPU) or async (network-bound). Awaiting only
        # what is awaitable keeps the stub a plain function while letting
        # classification do real I/O without blocking the event loop.
        outcome = handler(req)
        result: AIResult = await outcome if inspect.isawaitable(outcome) else outcome
    except FeatureError as exc:
        bound.warning("execute.failed", code=exc.code, kind=exc.kind)
        return _error(422 if exc.kind == "permanent" else 503, exc.kind, exc.code, exc.message)
    except Exception as exc:  # unexpected — treat as temporary, let BullMQ retry
        bound.error("execute.error", error=type(exc).__name__)
        return _error(500, "temporary", "internal_error", "unexpected failure")

    bound.info("execute.ok", latency_ms=result.latency_ms)

    # exclude_none keeps optional fields absent rather than null, matching the
    # schema's "optional" rather than "nullable and always present".
    return JSONResponse(status_code=200, content=result.model_dump(exclude_none=True))

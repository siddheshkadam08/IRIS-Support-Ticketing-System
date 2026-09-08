"""Behaviour of the Phase 1 AI service.

These run the REAL FastAPI app — no mocked handlers — so what is asserted here
is what the worker will actually receive.
"""

from __future__ import annotations

import json
import time
import uuid

from conftest import CORE_TEST_SECRET, TEST_SECRET
from iris_hmac import request_signature_header


def signed(payload: dict, *, secret: str = TEST_SECRET, timestamp: int | None = None,
           service_id: str = "worker", path: str = "/v1/execute") -> tuple[str, dict]:
    """Serialise ONCE, sign those bytes, return them with matching headers.

    The same discipline as worker/src/signing.ts: the string that is signed is
    the string that is sent. Signing a re-serialised object would change
    whitespace and key order and fail verification for reasons that look like
    broken crypto.
    """
    body = json.dumps(payload)
    ts = int(time.time()) if timestamp is None else timestamp
    nonce = str(uuid.uuid4())
    return body, {
        "content-type": "application/json",
        "x-iris-service-id": service_id,
        "x-iris-timestamp": str(ts),
        "x-iris-nonce": nonce,
        "x-iris-signature": request_signature_header(secret, "POST", path, ts, nonce, body),
    }


def _execute(client, payload, **kw):
    """Sign and POST. Every business test below is unchanged apart from this."""
    body, headers = signed(payload, **kw)
    return client.post("/v1/execute", content=body, headers=headers)


def noop_request(description: str = "Cannot export the Q3 emissions report.") -> dict:
    return {
        "feature": "noop",
        "request_id": "req_test_1",
        "input": {"subject": "Q3 export fails", "description": description},
    }


# ── health ───────────────────────────────────────────────────────────────


def test_health_is_liveness_only_and_needs_no_auth(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai-service"
    assert "uptime_s" in body


def test_ready_reports_loaded_features(client):
    res = client.get("/health/ready")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ready"
    assert body["features"] == [
        "classification",
        "embedding",
        "noop",
        "rag",
        "reranking",
        "summary",
    ], (
        "readiness must report exactly what is built — the stub since Phase 1, "
        "classification since Phase 4, summary since Phase 5, embedding since "
        "Phase 10, reranking since Phase 12, rag since Phase 13"
    )


# ── the stub ─────────────────────────────────────────────────────────────


def test_noop_returns_the_description_length(client):
    description = "Cannot export the Q3 emissions report."
    res = _execute(client, noop_request(description))
    assert res.status_code == 200

    body = res.json()
    assert body["feature"] == "noop"
    assert body["status"] == "succeeded"
    assert body["data"] == {"ok": True, "received_chars": len(description)}
    # Explainability: core-service persists these on ai_execution. Without
    # them, "why did it decide that in March?" is unanswerable after a swap.
    assert body["provider"] == "stub"
    assert body["model"] == "stub-noop"
    assert body["model_version"]
    assert body["fallback_used"] is False


def test_noop_char_count_is_exact_for_unicode(client):
    description = "Rapport trimestriel — échec de l'export ✅"
    res = _execute(client, noop_request(description))
    assert res.json()["data"]["received_chars"] == len(description)


# ── permanent failures ───────────────────────────────────────────────────


def test_empty_description_is_a_permanent_422(client):
    res = _execute(client, noop_request(""))
    assert res.status_code == 422
    err = res.json()["error"]
    assert err["code"] == "invalid_input"
    assert err["kind"] == "permanent", "retrying an empty description changes nothing"


def test_whitespace_only_description_is_also_invalid(client):
    res = _execute(client, noop_request("   \n\t  "))
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_input"


def test_declared_but_unbuilt_feature_is_permanent(client):
    """A feature in the shared contract but not built here fails permanently.

    The example has moved as capabilities landed — `classification` (Phase 4),
    then `summary` (Phase 5). `sentiment` carries the same meaning today:
    declared in the contract, not implemented in this service. The assertion
    itself is unchanged.
    """
    payload = noop_request()
    payload["feature"] = "sentiment"
    res = _execute(client, payload)
    assert res.status_code == 422
    err = res.json()["error"]
    assert err["code"] == "unsupported_feature"
    assert err["kind"] == "permanent"


def test_undeclared_feature_is_rejected_by_the_schema(client):
    payload = noop_request()
    payload["feature"] = "telepathy"
    res = _execute(client, payload)
    assert res.status_code == 422
    assert res.json()["error"]["kind"] == "permanent"


def test_malformed_request_is_permanent(client):
    res = _execute(client, {"feature": "noop"})  # no request_id, no input
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_request"


# ── the data boundary ────────────────────────────────────────────────────


def test_tenant_identifier_in_the_payload_is_refused(client):
    """extra='forbid' turns the data-boundary rule into a 422.

    A refactor that starts sending product_id "just for logging" fails here
    rather than quietly handing the AI service a tenant identifier.
    """
    payload = noop_request()
    payload["product_id"] = "prod_carbon"
    res = _execute(client, payload)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_request"


def test_raiser_identity_inside_input_is_refused(client):
    payload = noop_request()
    payload["input"]["raiser_email"] = "someone@example.com"
    res = _execute(client, payload)
    assert res.status_code == 422


# ── HMAC service authentication (Phase 2) ────────────────────────────────
#
# These replace the Phase 1 shared-key tests. The intent is preserved — an
# unauthenticated caller gets 401 and learns nothing — but the mechanism is now
# a per-request signature over (method, path, timestamp, nonce, sha256(body)).


def test_unsigned_request_is_rejected(client):
    res = client.post("/v1/execute", json=noop_request())
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "unauthenticated"
    # Permanent: the worker must not burn five BullMQ retries on a config fault.
    assert res.json()["error"]["kind"] == "permanent"


def test_wrong_secret_is_rejected(client):
    res = _execute(client, noop_request(), secret="a-completely-different-secret")
    assert res.status_code == 401


class TestCallerAllowlist:
    """Phase 11 — core-service became a second permitted caller.

    Hybrid retrieval needs a query embedding on a synchronous user request,
    where the worker is not on the path. Adding a caller is only safe if the
    two credentials stay SEPARATE, so these tests assert the separation rather
    than the feature.
    """

    def test_core_may_call_with_its_OWN_secret(self, client):
        res = _execute(client, noop_request(), service_id="core", secret=CORE_TEST_SECRET)
        assert res.status_code == 200

    def test_the_worker_still_works_unchanged(self, client):
        res = _execute(client, noop_request(), service_id="worker", secret=TEST_SECRET)
        assert res.status_code == 200

    def test_CORE_CANNOT_USE_THE_WORKER_SECRET(self, client):
        """The point of two secrets, asserted.

        If this passed, the credentials would be interchangeable and leaking
        either would grant the other's access — which is exactly the
        escalation key separation exists to prevent.
        """
        res = _execute(client, noop_request(), service_id="core", secret=TEST_SECRET)
        assert res.status_code == 401

    def test_THE_WORKER_CANNOT_USE_THE_CORE_SECRET(self, client):
        res = _execute(client, noop_request(), service_id="worker", secret=CORE_TEST_SECRET)
        assert res.status_code == 401

    def test_an_unknown_caller_is_rejected_even_with_a_valid_secret(self, client):
        # A closed map, not a lookup with a fallback.
        res = _execute(client, noop_request(), service_id="gateway", secret=TEST_SECRET)
        assert res.status_code == 401


def test_unknown_service_id_is_rejected(client):
    res = _execute(client, noop_request(), service_id="gateway")
    assert res.status_code == 401


def test_stale_timestamp_is_rejected(client):
    res = _execute(client, noop_request(), timestamp=int(time.time()) - 400)
    assert res.status_code == 401


def test_future_timestamp_is_rejected(client):
    res = _execute(client, noop_request(), timestamp=int(time.time()) + 400)
    assert res.status_code == 401


def test_tampered_body_is_rejected(client):
    """Sign one payload, send another."""
    body, headers = signed(noop_request("original description"))
    # A single character, so the test isolates CONTENT rather than length —
    # a length change could in principle be caught by something other than the
    # signature.
    tampered = body.replace("original description", "0riginal description")
    assert len(tampered) == len(body)
    assert tampered != body
    res = client.post("/v1/execute", content=tampered, headers=headers)
    assert res.status_code == 401


def test_signature_for_another_path_is_rejected(client):
    """Method and path are inside the canonical string."""
    body, headers = signed(noop_request(), path="/v1/something-else")
    res = client.post("/v1/execute", content=body, headers=headers)
    assert res.status_code == 401


def test_partial_headers_are_rejected(client):
    body, headers = signed(noop_request())
    for missing in ("x-iris-timestamp", "x-iris-nonce", "x-iris-signature"):
        partial = {k: v for k, v in headers.items() if k != missing}
        res = client.post("/v1/execute", content=body, headers=partial)
        assert res.status_code == 401, missing


def test_auth_failure_reveals_nothing_about_why(client):
    """One message for every failure mode; the reason goes to the log only."""
    stale = _execute(client, noop_request(), timestamp=int(time.time()) - 400).json()
    bad_sig = _execute(client, noop_request(), secret="wrong").json()
    assert stale["error"] == bad_sig["error"]


def test_auth_is_checked_before_the_body_is_validated(client):
    """An unauthenticated caller must not learn anything from validation."""
    res = client.post("/v1/execute", json={"garbage": True})
    assert res.status_code == 401


def test_a_replayed_nonce_is_ACCEPTED_because_python_is_stateless(client):
    """Deliberate, and not an oversight.

    /v1/execute is a pure function with no side effects: a replay recomputes an
    answer it already gave. A nonce cache here would break the stateless
    invariant and horizontal scaling in order to prevent nothing.

    Core owns replay protection, because Core is where a replay could change
    state — and even there UNIQUE(event_id, feature) is the real guarantee.
    """
    body, headers = signed(noop_request())
    first = client.post("/v1/execute", content=body, headers=headers)
    second = client.post("/v1/execute", content=body, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["data"] == second.json()["data"]

"""
Python HMAC tests.

These assert against the SAME shared/hmac-utils/vectors.json that the
TypeScript suite uses. That is the entire point: if the two implementations
ever diverge, one of the suites goes red immediately instead of an integrator
discovering it at an integration boundary.

Those vectors are also PUBLISHED to integrators in docs/api-contract.md §3.3.
If a test here fails, we have broken every integrator's signing code — fix the
implementation, never the vector.

    pytest shared/hmac-utils/py -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from iris_hmac import (  # noqa: E402
    build_canonical_string,
    request_signature_header,
    safe_equal_hex,
    sha256_hex,
    sign_request,
    sign_webhook,
    verify_request,
    verify_webhook,
    webhook_signature_header,
)

VECTORS = json.loads(
    (Path(__file__).parents[1] / "vectors.json").read_text(encoding="utf-8")
)
R = VECTORS["request_v1"]
W = VECTORS["webhook_v1"]


# ── published request vector ─────────────────────────────────────────────
class TestPublishedRequestVector:
    def test_body_hashes_to_documented_sha256(self):
        assert sha256_hex(R["body"]) == R["body_sha256"]

    def test_body_is_documented_byte_length(self):
        # The body contains an em dash; a mis-encoded file would change this.
        assert len(R["body"].encode("utf-8")) == R["body_bytes"]

    def test_builds_documented_canonical_string(self):
        canonical = build_canonical_string(
            R["method"], R["path"], R["timestamp"], R["nonce"], R["body"]
        )
        assert canonical == R["canonical"]
        assert len(canonical.split("\n")) == 6

    def test_produces_documented_signature(self):
        assert (
            sign_request(
                R["client_secret"],
                R["method"],
                R["path"],
                R["timestamp"],
                R["nonce"],
                R["body"],
            )
            == R["signature"]
        )

    def test_header_form_is_v1_prefixed(self):
        assert request_signature_header(
            R["client_secret"],
            R["method"],
            R["path"],
            R["timestamp"],
            R["nonce"],
            R["body"],
        ) == f"v1={R['signature']}"


# ── published webhook vector ─────────────────────────────────────────────
class TestPublishedWebhookVector:
    def test_produces_documented_signature(self):
        assert sign_webhook(W["webhook_secret"], W["timestamp"], W["body"]) == W["signature"]

    def test_header_form_is_stripe_style(self):
        assert (
            webhook_signature_header(W["webhook_secret"], W["timestamp"], W["body"])
            == f"t={W['timestamp']},v1={W['signature']}"
        )


# ── verification ─────────────────────────────────────────────────────────
class TestVerification:
    # Vectors use a fixed timestamp, so pin "now" rather than skewing the window.
    NOW = R["timestamp"]

    def _verify(self, secret=None, **overrides):
        args = {
            "method": R["method"],
            "path": R["path"],
            "timestamp": R["timestamp"],
            "nonce": R["nonce"],
            "body": R["body"],
            "signature_header": f"v1={R['signature']}",
            "now": self.NOW,
        }
        args.update(overrides)
        return verify_request(secret or R["client_secret"], **args)

    def test_accepts_valid_signature_in_window(self):
        assert self._verify().ok is True

    def test_rejects_tampered_body(self):
        result = self._verify(body=R["body"].replace("high", "low"))
        assert (result.ok, result.reason) == (False, "signature_invalid")

    def test_rejects_replay_against_different_path(self):
        result = self._verify(path="/v1/tickets/tkt_123/comments")
        assert (result.ok, result.reason) == (False, "signature_invalid")

    def test_rejects_replay_with_different_method(self):
        result = self._verify(method="DELETE")
        assert (result.ok, result.reason) == (False, "signature_invalid")

    def test_rejects_stale_timestamp(self):
        result = self._verify(now=self.NOW + 301)
        assert (result.ok, result.reason) == (False, "timestamp_out_of_window")

    def test_rejects_future_timestamp(self):
        result = self._verify(now=self.NOW - 301)
        assert (result.ok, result.reason) == (False, "timestamp_out_of_window")

    def test_rejects_wrong_secret(self):
        result = self._verify(secret="sk_test_wrong")
        assert (result.ok, result.reason) == (False, "signature_invalid")

    @pytest.mark.parametrize("header", [None, "", "garbage"])
    def test_rejects_missing_or_malformed_header(self, header):
        result = self._verify(signature_header=header)
        assert (result.ok, result.reason) == (False, "malformed_signature")

    def test_verifies_webhook_as_an_integrating_product_would(self):
        header = webhook_signature_header(W["webhook_secret"], W["timestamp"], W["body"])
        result = verify_webhook(W["webhook_secret"], W["body"], header, now=W["timestamp"])
        assert result.ok is True

    def test_rejects_webhook_whose_raw_body_was_reserialised(self):
        """The classic integration bug: parsing JSON and dumping it again."""
        header = webhook_signature_header(W["webhook_secret"], W["timestamp"], W["body"])
        reserialised = json.dumps(json.loads(W["body"]), indent=2)
        result = verify_webhook(W["webhook_secret"], reserialised, header, now=W["timestamp"])
        assert (result.ok, result.reason) == (False, "signature_invalid")

    def test_rejects_webhook_with_stale_timestamp(self):
        header = webhook_signature_header(W["webhook_secret"], W["timestamp"], W["body"])
        result = verify_webhook(
            W["webhook_secret"], W["body"], header, now=W["timestamp"] + 301
        )
        assert (result.ok, result.reason) == (False, "timestamp_out_of_window")


class TestSafeEqualHex:
    @pytest.mark.parametrize(
        "a,b,expected",
        [("abc", "abc", True), ("abc", "abd", False), ("abc", "abcd", False), ("", "", True)],
    )
    def test_is_length_safe_and_value_correct(self, a, b, expected):
        assert safe_equal_hex(a, b) is expected


# ── cross-language agreement ─────────────────────────────────────────────
def test_python_agrees_with_typescript_on_every_vector():
    """
    The guarantee shared/SKILLS.md makes: both languages produce the published
    signature. Asserting it explicitly here means the claim is enforced, not
    just documented.
    """
    assert (
        sign_request(
            R["client_secret"], R["method"], R["path"], R["timestamp"], R["nonce"], R["body"]
        )
        == R["signature"]
    ), "Python request signature diverged from the published vector"

    assert (
        sign_webhook(W["webhook_secret"], W["timestamp"], W["body"]) == W["signature"]
    ), "Python webhook signature diverged from the published vector"

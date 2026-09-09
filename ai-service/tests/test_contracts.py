"""Python is checked against the SAME contract artifact as TypeScript.

shared/contracts/ai/ai-contracts.schema.json is authoritative. The TypeScript
suite validates the shared fixtures with AJV; this one validates them with
jsonschema, and additionally validates what the real pydantic models actually
serialise. If the two language views of a contract ever diverge, one of the
suites goes red immediately.

This mirrors how shared/hmac-utils/vectors.json already keeps the TS and Python
HMAC implementations honest.
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator

from test_execute import signed


@pytest.fixture(scope="module")
def schema(contracts_dir):
    return json.loads((contracts_dir / "ai-contracts.schema.json").read_text(encoding="utf8"))


@pytest.fixture(scope="module")
def cases(contracts_dir):
    payload = json.loads(
        (contracts_dir / "fixtures" / "cases.json").read_text(encoding="utf8")
    )
    return payload["cases"]


def validator_for(schema: dict, definition: str) -> Draft202012Validator:
    """Compile one $def. The schema uses only internal $refs, so no resolver."""
    return Draft202012Validator({**schema, "$ref": f"#/$defs/{definition}"})


def test_schema_is_itself_valid(schema):
    Draft202012Validator.check_schema(schema)


def test_schema_uses_only_internal_refs(schema):
    """No external $ref means both languages load one self-contained file."""

    def refs(node):
        if isinstance(node, list):
            for item in node:
                yield from refs(item)
        elif isinstance(node, dict):
            for key, value in node.items():
                if key == "$ref" and isinstance(value, str):
                    yield value
                else:
                    yield from refs(value)

    found = set(refs(schema))
    assert found, "expected the schema to use $refs"
    for ref in found:
        assert ref.startswith("#/$defs/"), f"external $ref not allowed: {ref}"
        assert ref.removeprefix("#/$defs/") in schema["$defs"], f"unresolved: {ref}"


def test_python_agrees_with_typescript_on_every_shared_fixture(schema, cases):
    """The same fixtures the AJV suite runs, validated by jsonschema."""
    assert len(cases) > 10
    for case in cases:
        v = validator_for(schema, case["def"])
        is_valid = v.is_valid(case["payload"])
        assert is_valid == case["valid"], (
            f"{case['name']}: expected valid={case['valid']}, got {is_valid} — "
            f"{[e.message for e in v.iter_errors(case['payload'])]}"
        )


def test_the_features_this_service_implements_are_declared_in_the_contract(schema):
    from src.api.features import FEATURES

    declared = set(schema["$defs"]["ai_feature"]["enum"])
    assert set(FEATURES).issubset(declared)
    # Phase 1 implemented the stub alone; Phase 4 added classification, Phase 5
    # added summary, Phase 10 added embedding, Phase 12 added reranking,
    # Phase 13 added rag and Phase 15 added copilot. The assertion that matters
    # is unchanged and above: everything this service implements must be
    # DECLARED in the shared contract.
    #
    # NOTE that `embedding` being declared here says nothing about the QUEUE.
    # It is deliberately absent from SUPPORTED_AI_FEATURES on the Core side,
    # because it travels on /internal/embeddings/* and never on ai.jobs.
    #
    # NOTE the same is true of `copilot`, and more sharply: the queue path
    # APPLIES results to tickets, and a draft customer reply must never reach a
    # result handler. It runs synchronously inside an authenticated admin
    # request and persists nothing.
    #
    # NOTE `screenshot` (Phase 19) is the first MULTIMODAL feature and the first
    # queue feature added since Phase 5. Unlike embedding, reranking, rag and
    # copilot it IS present in SUPPORTED_AI_FEATURES on the Core side, because
    # it genuinely travels on ai.jobs: it is triggered by a durable outbox fact,
    # it is slow, it costs money and it must survive a provider outage. Its
    # output is evidence — it has no field for a priority, severity, assignment
    # or status — so the queue path applying its result mutates no ticket
    # decision.
    assert set(FEATURES) == {
        "noop",
        "classification",
        "summary",
        "embedding",
        "reranking",
        "rag",
        "copilot",
        "screenshot",
    }


def test_a_real_noop_response_validates_against_the_shared_schema(schema, client):
    """Not a hand-written fixture: the actual HTTP response the worker sees."""
    body, headers = signed(
        {
            "feature": "noop",
            "request_id": "req_contract_1",
            "input": {"subject": None, "description": "hello world"},
        }
    )
    res = client.post("/v1/execute", content=body, headers=headers)
    assert res.status_code == 200
    validator_for(schema, "ai_result").validate(res.json())
    validator_for(schema, "noop_data").validate(res.json()["data"])


def test_a_real_error_response_is_a_valid_ai_error(schema, client):
    body, headers = signed(
        {
            "feature": "noop",
            "request_id": "req_contract_2",
            "input": {"subject": None, "description": ""},
        }
    )
    res = client.post("/v1/execute", content=body, headers=headers)
    assert res.status_code == 422
    validator_for(schema, "ai_error").validate(res.json()["error"])


def test_pydantic_execute_request_accepts_the_shared_valid_fixtures(schema, cases):
    """The models must accept every payload the contract calls valid."""
    from pydantic import ValidationError

    from src.api.schemas import ExecuteRequest

    checked = 0
    for case in cases:
        if case["def"] != "ai_execute_request":
            continue
        checked += 1
        if case["valid"]:
            ExecuteRequest.model_validate(case["payload"])
        else:
            with pytest.raises(ValidationError):
                ExecuteRequest.model_validate(case["payload"])
    assert checked >= 4, "expected execute-request fixtures in both directions"

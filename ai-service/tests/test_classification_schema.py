"""The per-request enum-constrained schema — Phase 4.

The property under test is that the taxonomy becomes a JSON-Schema `enum`, so
an out-of-taxonomy answer is impossible to EXPRESS rather than merely
discouraged by the prompt. That is the difference between a rule and a request.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.api.classification_schema import (
    ClassificationSchemaError,
    build_classification_schema,
    json_schema_for,
)

CATEGORIES = ["login_access", "reports", "billing"]
ISSUE_TYPES = ["Bug", "Question", "Feature Request"]
IMPACTS = ["Single User", "Multiple Users", "Entire Customer"]


def build():
    return build_classification_schema(
        categories=CATEGORIES, issue_types=ISSUE_TYPES, impacts=IMPACTS
    )


def valid_payload(**over):
    payload = {
        "category": "reports",
        "category_confidence": 0.9,
        "category_runner_up": "billing",
        "category_runner_up_confidence": 0.3,
        "issue_type": "Bug",
        "issue_type_confidence": 0.85,
        "impact": "Multiple Users",
        "impact_confidence": 0.8,
        "priority_factors": {
            "security_or_data_loss": False,
            "system_down": True,
            "hours_until_deadline": 20.0,
            "regulatory_impact": False,
            "workaround_available": False,
            "cosmetic_only": False,
            "priority_factor_confidence": 0.75,
        },
        "sentiment": "Frustrated (a report they depend on stopped working)",
        "keywords_tags": ["reports", "export"],
        "rationale": "The user cannot export a report, which is a functional defect.",
    }
    payload.update(over)
    return payload


class TestSchemaGeneration:
    def test_enum_values_come_from_the_request_taxonomy(self):
        schema = json_schema_for(build())
        assert schema["properties"]["category"]["enum"] == CATEGORIES
        assert schema["properties"]["issue_type"]["enum"] == ISSUE_TYPES
        assert schema["properties"]["impact"]["enum"] == IMPACTS

    def test_a_different_product_gets_a_different_constraint(self):
        # The whole reason the model is built per request.
        other = build_classification_schema(
            categories=["hardware", "software"], issue_types=["Task"], impacts=["One"]
        )
        assert json_schema_for(other)["properties"]["category"]["enum"] == [
            "hardware",
            "software",
        ]

    def test_a_single_value_vocabulary_emits_const_not_enum(self):
        """Pydantic collapses a one-member Literal to `const`.

        Worth pinning rather than discovering later: the constraint is if
        anything stricter, but the SHAPE differs, so any future code that reads
        the schema must handle both.
        """
        one = build_classification_schema(
            categories=["only_one"], issue_types=["Task"], impacts=["One"]
        )
        prop = json_schema_for(one)["properties"]["category"]
        assert prop.get("const") == "only_one"
        assert "enum" not in prop

    def test_required_fields_are_marked_required(self):
        required = set(json_schema_for(build())["required"])
        for field in (
            "category",
            "category_confidence",
            "issue_type",
            "issue_type_confidence",
            "impact",
            "impact_confidence",
            "priority_factors",
            "sentiment",
            "rationale",
        ):
            assert field in required, f"{field} must be required"

    def test_runner_up_is_optional(self):
        # null means "nothing was close", which is a real and common answer.
        assert "category_runner_up" not in set(json_schema_for(build())["required"])

    def test_the_18_frozen_fields_and_no_others(self):
        props = json_schema_for(build())["properties"]
        assert set(props) == {
            "category",
            "category_confidence",
            "category_runner_up",
            "category_runner_up_confidence",
            "issue_type",
            "issue_type_confidence",
            "impact",
            "impact_confidence",
            "priority_factors",
            "sentiment",
            "keywords_tags",
            "rationale",
        }

    def test_excluded_reference_fields_are_absent(self):
        # Reference parity is not a goal; a consumer for each field is.
        props = json_schema_for(build())["properties"]
        for excluded in ("product", "environment", "module", "subject", "recommendation"):
            assert excluded not in props


class TestEmptyTaxonomy:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"categories": [], "issue_types": ISSUE_TYPES, "impacts": IMPACTS},
            {"categories": CATEGORIES, "issue_types": [], "impacts": IMPACTS},
            {"categories": CATEGORIES, "issue_types": ISSUE_TYPES, "impacts": []},
        ],
    )
    def test_an_empty_vocabulary_is_refused(self, kwargs):
        # A classifier with no categories cannot classify. Failing loudly here
        # beats emitting a schema the model can satisfy with anything.
        with pytest.raises(ClassificationSchemaError):
            build_classification_schema(**kwargs)


class TestValidation:
    def test_accepts_a_well_formed_payload(self):
        parsed = build().model_validate(valid_payload())
        assert parsed.category == "reports"
        assert parsed.priority_factors.system_down is True

    def test_REJECTS_AN_INVENTED_CATEGORY(self):
        # The single most important assertion in this file.
        with pytest.raises(ValidationError):
            build().model_validate(valid_payload(category="not_a_real_category"))

    def test_rejects_an_invented_issue_type(self):
        with pytest.raises(ValidationError):
            build().model_validate(valid_payload(issue_type="Catastrophe"))

    def test_rejects_an_invented_impact(self):
        with pytest.raises(ValidationError):
            build().model_validate(valid_payload(impact="The Entire Planet"))

    def test_rejects_an_invented_runner_up(self):
        with pytest.raises(ValidationError):
            build().model_validate(valid_payload(category_runner_up="made_up"))

    @pytest.mark.parametrize("bad", [-0.1, 1.1, 2.0])
    def test_rejects_a_confidence_outside_0_1(self, bad):
        with pytest.raises(ValidationError):
            build().model_validate(valid_payload(category_confidence=bad))

    def test_accepts_the_confidence_boundaries(self):
        for ok in (0.0, 1.0):
            assert build().model_validate(valid_payload(category_confidence=ok))

    def test_rejects_a_missing_required_field(self):
        payload = valid_payload()
        del payload["category"]
        with pytest.raises(ValidationError):
            build().model_validate(payload)

    def test_rejects_extra_fields(self):
        # extra="forbid": a model that volunteers `priority` must not have it
        # quietly accepted and then ignored.
        with pytest.raises(ValidationError):
            build().model_validate(valid_payload(priority="Critical"))

    def test_accepts_a_null_deadline(self):
        payload = valid_payload()
        payload["priority_factors"]["hours_until_deadline"] = None
        assert build().model_validate(payload).priority_factors.hours_until_deadline is None

    def test_accepts_a_null_runner_up(self):
        parsed = build().model_validate(
            valid_payload(category_runner_up=None, category_runner_up_confidence=None)
        )
        assert parsed.category_runner_up is None

    @pytest.mark.parametrize("token,expected", [("yes", True), ("no", False), ("true", True)])
    def test_bool_like_strings_are_coerced(self, token, expected):
        """Pydantic coerces a BOUNDED set of boolean-ish strings.

        Verified against pydantic 2.10: yes/no/true/false/1/0 coerce, and
        anything else is rejected. Accepted deliberately — a model that writes
        "yes" instead of true is formatting sloppily, not asserting something
        different, and spending a repair call on it would cost more than it
        protects. The bound is what makes this safe: the set is closed.
        """
        payload = valid_payload()
        payload["priority_factors"]["system_down"] = token
        parsed = build().model_validate(payload)
        assert parsed.priority_factors.system_down is expected

    @pytest.mark.parametrize("junk", ["maybe", "banana", "system is down", 2, []])
    def test_rejects_a_priority_factor_that_is_not_boolean_at_all(self, junk):
        payload = valid_payload()
        payload["priority_factors"]["system_down"] = junk
        with pytest.raises(ValidationError):
            build().model_validate(payload)

    def test_keywords_default_to_empty(self):
        payload = valid_payload()
        del payload["keywords_tags"]
        assert build().model_validate(payload).keywords_tags == []

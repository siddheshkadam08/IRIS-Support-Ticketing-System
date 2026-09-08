"""The enum-constrained classification output schema — Phase 4.

WHY THIS IS BUILT PER REQUEST rather than declared once.

Every product has its own taxonomy, so the set of legal `category` values is
only known when a request arrives. Building a Pydantic model whose enum fields
are `Literal[...]` over *this* request's taxonomy turns those values into a
JSON-Schema `enum`, which STRUCTURALLY constrains the model rather than merely
asking it politely in a prompt not to invent one.

That is the difference between a rule and a request. The prompt also lists the
allowed values — belt and braces — but only the enum makes an out-of-taxonomy
answer impossible to express.

Building a model per request is cheap: it is a schema definition, not a network
call, and it happens once per classification.

⚠️ This schema is NOT the security boundary. Core re-validates every enum
against its own copy of the taxonomy after Python returns (see
core-service/src/internal/ai.service.ts). This layer exists to make the model's
job easy; Core's exists because the model is untrusted.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model


class ClassificationSchemaError(ValueError):
    """The taxonomy is unusable, so no schema can be built.

    A CALLER problem, not a model failure — the product configured an empty or
    missing vocabulary. It must surface as a permanent error: retrying cannot
    make a category list appear.
    """


class PriorityFactorsOut(BaseModel):
    """Facts extracted from the ticket text — never a judgement.

    Each field is answerable by reading the ticket. Note what is NOT here:
    priority, severity, urgency, routing. Those are Core's decisions, computed
    from these facts, and asking the model for them directly is the exact
    inversion this architecture exists to prevent.
    """

    model_config = ConfigDict(extra="forbid")

    security_or_data_loss: bool = Field(
        description="True if the ticket describes a security breach or loss/corruption of data."
    )
    system_down: bool = Field(
        description=(
            "True ONLY if the functionality is completely unavailable or erroring — not "
            "merely slow or degraded. 'Performance is slow' is NOT system_down; "
            "'nothing loads at all' IS."
        )
    )
    hours_until_deadline: float | None = Field(
        default=None,
        description=(
            "Estimated hours until a stated hard deadline, if the text describes one — "
            "'due today' ~= 6, 'due tomorrow' ~= 20, 'in 2 days' ~= 48, 'next week' ~= 150. "
            "If a deadline problem is described with no timeframe given, estimate 20-24. "
            "null ONLY if no deadline is mentioned at all."
        ),
    )
    regulatory_impact: bool = Field(
        description=(
            "True ONLY if a SPECIFIC named regulator or regulatory filing is mentioned "
            "(e.g. SEC, ESMA, FERC, HMRC). Generic domain jargon alone does not count."
        )
    )
    workaround_available: bool = Field(
        description="Default false unless the text explicitly states or clearly implies one exists."
    )
    cosmetic_only: bool = Field(
        description=(
            "True ONLY for purely visual issues with zero functional or business effect. "
            "False for anything affecting functionality, data, or output correctness."
        )
    )
    priority_factor_confidence: float = Field(
        ge=0.0, le=1.0, description="Your confidence in the factor extraction above."
    )


def build_classification_schema(
    *,
    categories: list[str],
    issue_types: list[str],
    impacts: list[str],
) -> type[BaseModel]:
    """Build the per-request output model.

    Raises ClassificationSchemaError when any vocabulary is empty — an empty
    `Literal[()]` is not a valid type, and more importantly a classifier with no
    categories cannot classify. Failing here, loudly, beats emitting a schema
    the model can satisfy with anything.
    """
    for name, values in (
        ("categories", categories),
        ("issue_types", issue_types),
        ("impacts", impacts),
    ):
        if not values:
            raise ClassificationSchemaError(f"taxonomy.{name} is empty — cannot build a schema")

    category_literal = Literal[tuple(categories)]  # type: ignore[valid-type]
    issue_type_literal = Literal[tuple(issue_types)]  # type: ignore[valid-type]
    impact_literal = Literal[tuple(impacts)]  # type: ignore[valid-type]

    return create_model(
        "ClassificationOutput",
        __config__=ConfigDict(extra="forbid"),
        # ── Signals ──────────────────────────────────────────────────────
        category=(category_literal, Field(description="The functional area this ticket belongs to.")),
        category_confidence=(float, Field(ge=0.0, le=1.0)),
        # Runner-up for CATEGORY ONLY: it is the single field the routing band
        # reads, so it is the only one where a near-tie changes what happens.
        category_runner_up=(
            category_literal | None,
            Field(default=None, description="Second-best category, or null if nothing was close."),
        ),
        category_runner_up_confidence=(float | None, Field(default=None, ge=0.0, le=1.0)),
        issue_type=(issue_type_literal, Field(description="The kind of work this ticket represents.")),
        issue_type_confidence=(float, Field(ge=0.0, le=1.0)),
        impact=(impact_literal, Field(description="How many people this affects.")),
        impact_confidence=(float, Field(ge=0.0, le=1.0)),
        # ── Priority factors ─────────────────────────────────────────────
        priority_factors=(PriorityFactorsOut, Field(description="Facts that feed the priority engine.")),
        # ── Narrative ────────────────────────────────────────────────────
        sentiment=(
            str,
            Field(
                description=(
                    "A full line, never a bare word: an emotional-tone label plus a short "
                    "parenthetical reason grounded in the text, e.g. 'Frustrated/Urgent (a "
                    "business-critical blocker with a stated deadline)' or 'Neutral (a routine "
                    "how-to question)'."
                )
            ),
        ),
        keywords_tags=(
            list[str],
            Field(default_factory=list, description="3-6 short, searchable, lowercase tags."),
        ),
        rationale=(
            str,
            Field(description="One or two sentences explaining why you chose these values."),
        ),
    )


def json_schema_for(model: type[BaseModel]) -> dict[str, Any]:
    """The JSON Schema sent to the provider as `response_format`.

    ⚠️ A vocabulary with exactly ONE value emits `{"const": "x"}` rather than
    `{"enum": ["x"]}` — Pydantic collapses a single-member Literal. The
    constraint is if anything stricter, so this is a shape difference rather
    than a hole, but anything inspecting the schema must accept both forms.
    """
    return model.model_json_schema()


def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """The same schema, adjusted for OpenAI/Azure STRICT structured outputs.

    Strict mode imposes two rules Pydantic's default output does not satisfy:

      1. `required` must list EVERY key in `properties`. Pydantic omits fields
         that have defaults, which is correct JSON Schema and rejected here:
         `'required' is required to be supplied and to be an array including
         every key in properties. Missing 'hours_until_deadline'.` (verified
         live against gpt-4.1, api-version 2024-12-01-preview).
      2. every object must set `additionalProperties: false`.

    THIS DOES NOT CHANGE THE CONTRACT. The four affected fields —
    `hours_until_deadline`, `category_runner_up`,
    `category_runner_up_confidence`, `keywords_tags` — are already nullable or
    list-typed unions, so "required, and may be null" expresses exactly what
    "optional" expressed before. Strict mode's own convention for an optional
    field is a required nullable one; this is the same 18 fields, serialised
    the way the provider demands.

    Two further strict-mode rules, each found the same way — by being rejected:

      3. a `$ref` may carry NO sibling keywords. Pydantic attaches the field
         description next to the ref for `priority_factors`:
         `$ref cannot have keywords {'description'}`. The description is not
         lost in any meaningful sense — it lives on the definition itself and
         in the system prompt.
      4. `default` is not an accepted keyword. It is also meaningless once
         every field is required.

    Applied recursively so `$defs` (PriorityFactorsOut) is covered too.
    """

    # Keywords strict mode rejects outright, wherever they appear.
    UNSUPPORTED = ("default",)

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            # A $ref must stand alone.
            if "$ref" in node:
                for key in [k for k in node if k != "$ref"]:
                    del node[key]
                return

            for key in UNSUPPORTED:
                node.pop(key, None)

            if node.get("type") == "object" or "properties" in node:
                props = node.get("properties")
                if isinstance(props, dict):
                    node["required"] = list(props.keys())
                    node["additionalProperties"] = False

            for value in list(node.values()):
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    schema = model.model_json_schema()
    walk(schema)
    return schema

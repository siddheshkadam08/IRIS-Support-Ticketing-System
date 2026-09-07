"""Pydantic mirrors of shared/contracts/ai/ai-contracts.schema.json.

The JSON Schema is the authoritative artifact; these models are checked against
it by tests/test_contracts.py using the same fixtures the TypeScript suite uses.
That is what makes "one contract, two languages" true rather than aspirational:
if this file and shared/types/ai.ts ever disagree, one of the suites goes red
immediately instead of an integrator discovering it at a boundary.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AIFeature = Literal["noop", "classification", "sentiment", "keywords", "summary", "rag"]


class Strict(BaseModel):
    """Rejects unknown fields, mirroring additionalProperties:false.

    This is the data boundary made executable. A well-meaning caller that adds
    `product_id` to the payload gets a 422, not a silent tenant-identifier leak
    into the AI service.
    """

    model_config = ConfigDict(extra="forbid")


class TaxonomyCategory(Strict):
    value: str
    label: str


class Taxonomy(Strict):
    categories: list[TaxonomyCategory]
    severities: list[str]


class Thresholds(Strict):
    auto_route_p1: float = Field(ge=0, le=1)
    auto_route_margin: float = Field(ge=0, le=1)
    triage_floor: float = Field(ge=0, le=1)


class ExecuteInput(Strict):
    subject: str | None
    description: str
    # Only features that classify receive these. The stub gets neither.
    taxonomy: Taxonomy | None = None
    thresholds: Thresholds | None = None


class ExecuteRequest(Strict):
    """Exactly what crosses into this service.

    Note what has no field here and never will without a written decision:
    product_id, product_tenant_id, raiser identity, reference, metadata, any
    secret, any token. This service cannot identify the tenant, so it cannot
    leak one tenant into another's answer even if fully compromised.
    """

    feature: AIFeature
    request_id: str
    input: ExecuteInput


class AIError(Strict):
    # `kind` alone carries retryability. temporary -> the caller (BullMQ)
    # retries; permanent -> retrying returns the same answer.
    kind: Literal["temporary", "permanent"]
    code: str
    message: str


class AIResult(Strict):
    feature: AIFeature
    status: Literal["succeeded", "failed"]
    data: dict[str, Any]
    confidence: float | None = None
    provider: str | None = None
    model: str | None = None
    model_version: str | None = None
    prompt_version: str | None = None
    latency_ms: int | None = None
    fallback_used: bool = False
    error: AIError | None = None

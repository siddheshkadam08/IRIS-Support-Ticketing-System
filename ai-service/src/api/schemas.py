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

AIFeature = Literal[
    "noop", "classification", "sentiment", "keywords", "summary", "rag", "embedding",
    "reranking", "copilot",
]


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
    """The allowed values a classifying feature may choose from.

    `issue_types` and `impacts` are Phase 4 additions. They are optional so a
    `noop` job — and any Core that predates Phase 4 — still validates; the
    classification feature checks for them itself and fails loudly rather than
    silently classifying against an empty vocabulary.

    NOTE what is deliberately absent: `core_categories`. That list only feeds
    Core's deterministic priority engine, so sending it here would widen the
    data boundary to carry something this service cannot use.
    """

    categories: list[TaxonomyCategory]
    severities: list[str]
    issue_types: list[str] | None = None
    impacts: list[str] | None = None


class Thresholds(Strict):
    """Core's confidence-routing thresholds.

    Transported for completeness and NEVER read by this service — routing is
    Core's decision and is computed there. Nothing in the classification path
    references these values.

    `auto_route_p1` is deliberately NOT capped at 1. A value above 1.0 is the
    documented way to make AUTO_ROUTE unreachable for a product, which is the
    controlled-rollout control used while the model's self-reported confidence
    is still uncalibrated. The original `le=1` encoded an assumption that the
    threshold is always a probability; it is a comparison bound, and "higher
    than any attainable confidence" is a legitimate setting. Capping it here
    would have turned that safety control into a 422 — a permanent failure on
    every ticket — for a field this service does not even use.

    The other two stay bounded: neither has an equivalent out-of-range meaning.
    """

    auto_route_p1: float = Field(ge=0)
    auto_route_margin: float = Field(ge=0, le=1)
    triage_floor: float = Field(ge=0, le=1)


class RerankCandidate(Strict):
    """One already-authorized candidate, Phase 12.

    ⚠️ NOTE WHAT IS ABSENT AND MUST STAY ABSENT: source_id, product_id,
    reference, raiser identity, retrieval score. Core numbers its own
    candidates and sends ORDINALS, so the model ranks 1..N and is
    structurally incapable of naming a document Core did not supply. There is
    no field here in which to name one.

    `kind` is the kind of EVIDENCE, not a tenant identifier: a written article
    answers a question differently from a past ticket, and withholding that
    would make the ranking harder for no security gain.
    """

    ordinal: int = Field(ge=1, le=10)
    kind: Literal["article", "ticket"]
    title: str
    excerpt: str


class RagEvidence(Strict):
    """One already-authorized source, Phase 13.

    ⚠️ NOTE WHAT IS ABSENT AND MUST STAY ABSENT: source_id, product_id,
    product_tenant_id, reference, raiser identity, retrieval score, URL. Core
    numbers its own evidence and sends ORDINALS, so the model cites 1..N and a
    citation to anything else is unrepresentable rather than merely invalid.

    `source_type` is the kind of EVIDENCE, not a tenant identifier: a curated
    article grounds a claim differently from a past ticket, and withholding
    that would weaken the answer for no security gain.
    """

    source_number: int = Field(ge=1, le=5)
    source_type: Literal["kb_article", "resolved_ticket"]
    title: str
    excerpt: str


class TicketComment(Strict):
    """One PUBLIC comment on the current ticket.

    `author` is a ROLE, not a person: no name, no email, no user id, no raiser
    reference. The model needs to know who said what, not who they are.
    """

    author: Literal["customer", "support"]
    body: str


class TicketContext(Strict):
    """The current ticket, Phase 15 Copilot only.

    ⚠️ NOTE WHAT IS ABSENT AND MUST STAY ABSENT: ticket id, reference,
    product_id, product_tenant_id, raiser identity, assignee, attachments,
    metadata, audit history — and INTERNAL COMMENTS. An internal note is
    "never leaves the platform" by the schema's own comment, and the surest way
    to keep it out of a customer reply is to never put it in the prompt.
    """

    subject: str | None
    description: str
    status: str
    category: str | None
    severity: str | None
    public_comments: list[TicketComment] = Field(default_factory=list, max_length=6)


class CopilotEvidence(Strict):
    """One already-authorized source, Phase 15.

    Same identifier-free shape as Phase 12 and 13: the model cites source
    NUMBERS, so naming a document Core did not supply is unrepresentable.

    `kind` matters to the prompt — a help article is documented guidance, a past
    ticket is one thing that happened once.
    """

    source_number: int = Field(ge=1, le=5)
    kind: Literal["kb_article", "historical_ticket"]
    title: str
    excerpt: str


class ExecuteInput(Strict):
    subject: str | None
    description: str
    # Only features that classify receive these. The stub gets neither.
    taxonomy: Taxonomy | None = None
    thresholds: Thresholds | None = None
    # Phase 12 reranking only. Bounded here as well as in Core, so an oversized
    # list is a 422 at the boundary rather than a large provider bill.
    candidates: list[RerankCandidate] | None = Field(default=None, max_length=10)
    # Phase 13 RAG only. Same bounding rationale, and the same identifier-free
    # shape: the model cites source NUMBERS, so it cannot name a document Core
    # did not supply.
    evidence: list[RagEvidence] | None = Field(default=None, max_length=5)
    # Phase 15 Copilot only. Same bounding and identifier-free rationale.
    ticket_context: TicketContext | None = None
    copilot_evidence: list[CopilotEvidence] | None = Field(default=None, max_length=5)


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

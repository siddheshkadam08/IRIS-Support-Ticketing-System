"""The feature registry — the whole of Phase 1's "AI".

One dict is how a single queue and a single endpoint serve many capabilities.
Phase 7 adds "classification": run_classification here and nothing around it
changes: not the queue, not the worker, not the Core endpoints, not the job
contract.

Phase 1 implements the stub and NOTHING else. No LLM, no classification, no
embeddings, no RAG, no prompts, no model routing, no reranking.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from ..config import config

# Mirrors SUMMARY_TARGET_WORDS in shared/types/summary.ts — the prompt target,
# deliberately well inside the hard ceiling Core enforces.
SUMMARY_TARGET_WORDS = 40
from .classification_schema import ClassificationSchemaError, build_classification_schema
from .prompts import PROMPT_VERSION, build_system_prompt, build_user_prompt
from .summary import (
    SUMMARY_PROMPT_VERSION,
    SummaryOutput,
)
from .summary import build_system_prompt as build_summary_system_prompt
from .summary import build_user_prompt as build_summary_user_prompt
from .embedding import run_embedding
from .copilot import run_copilot
from .rag import run_rag
from .screenshot import (
    SCREENSHOT_PROMPT_VERSION,
    SCREENSHOT_SYSTEM_PROMPT,
    ScreenshotOutput,
    build_screenshot_user_prompt,
)
from .reranking import run_reranking
from .schemas import AIResult, ExecuteRequest


class FeatureError(Exception):
    """A failure the caller must be able to classify without parsing prose."""

    def __init__(self, code: str, message: str, kind: str = "permanent") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.kind = kind


def run_noop(req: ExecuteRequest) -> AIResult:
    """The Phase 1 proof.

    It does something trivial but VERIFIABLE end to end: `received_chars` must
    equal the description length, so a green pipeline proves the description
    actually travelled Core -> worker -> here and back, rather than proving
    that two services can exchange an empty 200.

    It touches no ticket state, which is what makes "an AI failure leaves the
    ticket unchanged" a testable assertion rather than a hope.
    """
    started = time.perf_counter()

    if not req.input.description or not req.input.description.strip():
        # Permanent: the same empty description will be empty next time too.
        raise FeatureError("invalid_input", "description must not be empty", "permanent")

    return AIResult(
        feature="noop",
        status="succeeded",
        data={"ok": True, "received_chars": len(req.input.description)},
        provider="stub",
        model="stub-noop",
        model_version=config.model_version,
        latency_ms=int((time.perf_counter() - started) * 1000),
        fallback_used=False,
    )


# ── Phase 3 Step 6: where the inference timeout goes ─────────────────────
#
# THERE IS NO TIMEOUT HERE, AND THAT IS CORRECT TODAY. `run_noop` is pure CPU
# over a string already in memory: no socket, no subprocess, no model, nothing
# that can block. A timeout around it would guard against nothing while
# implying a bound that does not exist.
#
# The boundary that DOES exist is the caller's: worker/src/ai-client.ts aborts
# at AI_TIMEOUT_MS (10s), so this service can never hold a worker slot open.
#
# WHEN A REAL PROVIDER ARRIVES, the timeout belongs HERE, inside the handler,
# and it must be STRICTLY SHORTER than the worker's 10s — the frozen design
# says 8s. The ordering is the whole point:
#
#   Python stops first  -> the worker gets a deterministic 5xx it can classify
#                          -> BullMQ owns the retry
#
#   Worker stops first  -> the provider call is still running, unowned, while
#                          a retry starts a second one. Two concurrent calls
#                          per attempt, neither cancellable, billed twice.
#
# Two further requirements for that change, neither satisfiable today:
#
#   1. The timeout must CANCEL the provider call, not merely stop waiting for
#      it. `asyncio.wait_for` cancels an awaitable; a blocking SDK call in a
#      thread cannot be cancelled at all and needs the provider's own
#      client-side timeout instead.
#   2. Handlers are currently SYNCHRONOUS and are called directly on the event
#      loop (see app.py). A blocking provider call added as-is would stall the
#      whole service, not just its own request. An async handler signature, or
#      run_in_threadpool, is a prerequisite.
#
# Recorded rather than pre-built: a timeout wrapping a stub proves nothing and
# would have to be rewritten around whichever of the two shapes the provider
# turns out to need.

async def run_classification(req: ExecuteRequest) -> AIResult:
    """Extract classification SIGNALS from the ticket text.

    What this function deliberately does NOT do: decide priority, decide
    severity, decide routing, or touch any ticket state. It returns facts and
    confidences; Core turns those into decisions (see
    core-service/src/internal/classification.rules.ts). That split is the whole
    architecture, and the easiest place to erode it is here.
    """
    started = time.perf_counter()

    if not req.input.description or not req.input.description.strip():
        # Permanent: an empty description is empty on every retry too.
        raise FeatureError("invalid_input", "description must not be empty", "permanent")

    taxonomy = req.input.taxonomy
    if taxonomy is None:
        raise FeatureError(
            "invalid_input", "classification requires a taxonomy", "permanent"
        )

    categories = [c.value for c in taxonomy.categories]
    issue_types = list(taxonomy.issue_types or [])
    impacts = list(taxonomy.impacts or [])

    try:
        schema_model = build_classification_schema(
            categories=categories, issue_types=issue_types, impacts=impacts
        )
    except ClassificationSchemaError as exc:
        # The PRODUCT is misconfigured, not the model misbehaving. Permanent:
        # retrying cannot make a vocabulary appear.
        raise FeatureError("invalid_input", str(exc), "permanent") from exc

    if not config.classification_enabled:
        # Honest unavailability rather than a fake answer. Temporary, so the
        # job survives until a credential is configured — and so an
        # unconfigured deployment never silently writes a made-up
        # classification onto a real ticket.
        raise FeatureError(
            "provider_not_configured",
            "no classification provider credential is configured",
            "temporary",
        )

    from ..integrations.llm_client import (
        LLMPermanentError,
        LLMTemporaryError,
        OpenRouterClient,
    )

    client = OpenRouterClient(
        completions=_completions(),
        model=config.classification_model,
        budget_seconds=config.classification_budget_seconds,
    )

    try:
        result = await client.generate_structured(
            system_prompt=build_system_prompt(
                categories=categories, issue_types=issue_types, impacts=impacts
            ),
            user_prompt=build_user_prompt(
                subject=req.input.subject, description=req.input.description
            ),
            response_model=schema_model,
            request_id=req.request_id,
        )
    except LLMTemporaryError as exc:
        raise FeatureError(exc.code, str(exc), "temporary") from exc
    except LLMPermanentError as exc:
        raise FeatureError(exc.code, str(exc), "permanent") from exc

    payload = result.value.model_dump()

    return AIResult(
        feature="classification",
        status="succeeded",
        data=payload,
        # The weakest-link composite is computed by CORE, from these same
        # numbers. Reporting one here too would be a second source of truth for
        # a value Core must own.
        confidence=None,
        provider=config.classification_provider,
        model=config.classification_model_id,
        model_version=config.classification_model_version,
        prompt_version=PROMPT_VERSION,
        latency_ms=int((time.perf_counter() - started) * 1000),
        fallback_used=result.used_repair,
    )


async def run_summary(req: ExecuteRequest) -> AIResult:
    """Summarise the ticket for a support agent.

    INFORMATIONAL ONLY. It returns one string. It has no taxonomy, no
    thresholds and no decision to make — everything that could influence
    priority, severity or routing is absent from the contract by construction.

    Shares the classification provider client, budget and bounded-repair
    behaviour exactly. Nothing here is summary-specific except the prompt and
    the one-field schema; a second timeout or retry mechanism for this feature
    would be a second retry owner.
    """
    started = time.perf_counter()

    if not req.input.description or not req.input.description.strip():
        # Permanent: an empty description is empty on every retry too.
        raise FeatureError("invalid_input", "description must not be empty", "permanent")

    if not config.classification_enabled:
        # Honest unavailability rather than a fabricated summary. Temporary, so
        # the job survives until a credential is configured.
        raise FeatureError(
            "provider_not_configured",
            "no AI provider credential is configured",
            "temporary",
        )

    from ..integrations.llm_client import (
        LLMPermanentError,
        LLMTemporaryError,
        OpenRouterClient,
    )

    client = OpenRouterClient(
        completions=_completions(),
        model=config.classification_model,
        budget_seconds=config.classification_budget_seconds,
    )

    try:
        result = await client.generate_structured(
            system_prompt=build_summary_system_prompt(target_words=SUMMARY_TARGET_WORDS),
            user_prompt=build_summary_user_prompt(
                subject=req.input.subject, description=req.input.description
            ),
            response_model=SummaryOutput,
            request_id=req.request_id,
        )
    except LLMTemporaryError as exc:
        raise FeatureError(exc.code, str(exc), "temporary") from exc
    except LLMPermanentError as exc:
        raise FeatureError(exc.code, str(exc), "permanent") from exc

    return AIResult(
        feature="summary",
        status="succeeded",
        # Core validates and bounds this before anything is persisted; Python
        # returning it is not the same as Core accepting it.
        data=result.value.model_dump(),
        confidence=None,
        provider=config.classification_provider,
        model=config.classification_model_id,
        model_version=config.classification_model_version,
        prompt_version=SUMMARY_PROMPT_VERSION,
        latency_ms=int((time.perf_counter() - started) * 1000),
        fallback_used=result.used_repair,
    )




async def run_screenshot(req: ExecuteRequest) -> AIResult:
    """Interpret ONE screenshot attached to a ticket.

    ⚠️ EVIDENCE, NOT A DECISION. The output carries observations, a hint,
    possible causes and suggested steps, and no priority, severity, routing or
    reply — `ScreenshotOutput` has no field for them.

    Shares the provider client, the single wall-clock budget and the one bounded
    repair round with every other feature. Nothing here is screenshot-specific
    except the prompt, the schema and the image block: a second timeout or a
    retry of its own would be a second retry owner, and BullMQ is the only one.
    """
    started = time.perf_counter()

    image = req.input.image
    if image is None:
        # Permanent: Core promised an image and did not send one, and the same
        # request will be missing it on every retry.
        raise FeatureError("invalid_input", "screenshot requires an image", "permanent")

    if not config.classification_enabled:
        # Honest unavailability rather than a fabricated interpretation.
        # Temporary, so the job survives until a credential is configured.
        raise FeatureError(
            "provider_not_configured",
            "no AI provider credential is configured",
            "temporary",
        )

    from ..integrations.llm_client import (
        LLMPermanentError,
        LLMTemporaryError,
        OpenRouterClient,
    )

    client = OpenRouterClient(
        completions=_completions(),
        model=config.classification_model,
        budget_seconds=config.classification_budget_seconds,
    )

    try:
        result = await client.generate_structured(
            system_prompt=SCREENSHOT_SYSTEM_PROMPT,
            user_prompt=build_screenshot_user_prompt(
                subject=req.input.subject, description=req.input.description
            ),
            response_model=ScreenshotOutput,
            request_id=req.request_id,
            # THE ONLY PLACE AN IMAGE ENTERS A PROVIDER CALL.
            image=image,
        )
    except LLMTemporaryError as exc:
        raise FeatureError(exc.code, str(exc), "temporary") from exc
    except LLMPermanentError as exc:
        raise FeatureError(exc.code, str(exc), "permanent") from exc

    value = result.value.model_dump()

    return AIResult(
        feature="screenshot",
        status="succeeded",
        # Core validates and bounds this before anything is persisted; this
        # service returning it is not the same as Core accepting it.
        data=value,
        # ⚠️ THE MODEL'S OWN REPORTED SIGNAL, surfaced through the `confidence`
        # column the execution ledger already has. It is not a calibrated
        # probability and nothing downstream may present it as one.
        confidence=value.get("confidence"),
        provider=config.classification_provider,
        model=config.classification_model_id,
        model_version=config.classification_model_version,
        prompt_version=SCREENSHOT_PROMPT_VERSION,
        latency_ms=int((time.perf_counter() - started) * 1000),
        fallback_used=result.used_repair,
    )


def _completions():
    """The provider's chat-completions handle.

    ⚠️ DELIBERATELY httpx, NOT the `openai` SDK.

    Two reasons, one forced and one preferred:

    1. FORCED. openai 1.6.1 passes `proxies=` to httpx, which httpx 0.28
       removed — `TypeError: AsyncClient.__init__() got an unexpected keyword
       argument 'proxies'`. This repo pins httpx 0.28.1 and uses it elsewhere,
       so the SDK would force either a global SDK upgrade or an httpx downgrade
       for a client that makes exactly one kind of request.

    2. PREFERRED. The SDK retries twice by default. Disabling that
       (`max_retries=0`) is easy to write and easy to lose in a future upgrade,
       and losing it silently turns one worker attempt into three provider
       calls — BullMQ would no longer be the only retry owner and nothing would
       say so. httpx has no retry to disable.

    The wire format is unchanged: an OpenAI-compatible POST to
    /chat/completions against OpenRouter's base URL, which is what the design
    freeze specified.
    """
    if _COMPLETIONS_FACTORY is not None:
        return _COMPLETIONS_FACTORY()

    # CACHED for the process lifetime, so the pooled connections inside it are
    # actually reused. Rebuilding the transport per call would create a new
    # connection pool each time and reintroduce the per-request TLS handshake
    # this exists to avoid — the pool has to outlive the request to be a pool.
    global _COMPLETIONS  # noqa: PLW0603 — a process-lifetime singleton
    if _COMPLETIONS is not None:
        return _COMPLETIONS
    from ..integrations.llm_client import HttpxChatCompletions

    provider = config.classification_provider
    if provider == "azure":
        _COMPLETIONS = HttpxChatCompletions(
            base_url=config.azure_endpoint,
            api_key=config.azure_api_key,
            timeout_seconds=config.classification_budget_seconds,
            provider="azure",
            azure_deployment=config.azure_deployment,
            azure_api_version=config.azure_api_version,
        )
    else:
        _COMPLETIONS = HttpxChatCompletions(
            base_url=config.openrouter_base_url,
            api_key=config.openrouter_api_key,
            timeout_seconds=config.classification_budget_seconds,
        )
    return _COMPLETIONS


_COMPLETIONS_FACTORY: Callable[[], object] | None = None

# The process-lifetime provider transport. See _completions().
_COMPLETIONS: object | None = None


def set_completions_factory(factory: Callable[[], object] | None) -> None:
    """Test seam: substitute the provider handle. Never used in production."""
    global _COMPLETIONS_FACTORY, _COMPLETIONS  # noqa: PLW0603 — module-level test seam
    _COMPLETIONS_FACTORY = factory
    _COMPLETIONS = None  # drop any cached real transport


# Handlers may be sync (pure CPU, like the stub) or async (anything that makes
# a network call). app.py awaits whatever is awaitable — see its dispatch.
#
# This is the prerequisite the Phase 3 Step 6 note in this file predicted: a
# blocking provider call added to a SYNC handler would stall the whole event
# loop, not just its own request.
FEATURES: dict[str, Callable[[ExecuteRequest], Any]] = {
    "noop": run_noop,
    "classification": run_classification,
    "summary": run_summary,
    # Phase 10. Not a prediction: a measurement of the input, with no prompt,
    # no schema and nothing to distrust in what comes back beyond its shape.
    "embedding": run_embedding,
    # Phase 12. Reorders an already-authorized candidate list. It ranks
    # ORDINALS, so it cannot name a document Core did not supply.
    "reranking": run_reranking,
    # Phase 13. Writes a grounded answer over an already-authorized evidence
    # set and cites source NUMBERS, so it cannot name a document Core did not
    # supply.
    "rag": run_rag,
    # Phase 19. Interprets ONE already-authorized image and returns structured
    # evidence. It has no field in which to express a priority, severity,
    # assignment or status, so it cannot make a ticket decision.
    "screenshot": run_screenshot,
    # Phase 15. Drafts a customer reply for a human to review, edit and send.
    # It returns TEXT — this service cannot send anything to anyone.
    "copilot": run_copilot,
}

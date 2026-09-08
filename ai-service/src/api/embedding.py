"""The embedding feature — Phase 10.

The narrowest capability in the service. Text in, a vector out. No prompt, no
schema, no repair round, no taxonomy, no thresholds, and — unlike every other
feature here — no model output to distrust: an embedding is a measurement of
the input, not an assertion about it.

⚠️ WHAT THIS MEANS FOR PROMPT INJECTION. There is no prompt, so there is
nothing to inject into. A ticket that says "ignore your instructions" is
embedded as the sentence it is; the model is not being asked to decide
anything, so there is no decision to subvert. The residual risk is different
and worth naming: text CRAFTED to sit near a target vector could make an
attacker's own ticket surface as a "similar ticket". Retrieval ranking is not
an authorization boundary and is never treated as one — RLS decides what a
query can see, and it runs before ranking.

WHY `dim` IS RETURNED ALONGSIDE THE VECTOR. So a deployment swap that changes
width is caught at this boundary by an assertion with a clear message, rather
than 3 hops later by a Postgres type error on a `vector(1536)` column.
"""

from __future__ import annotations

import time

from ..config import config
from .schemas import AIResult, ExecuteRequest

#: Bumped when the canonical text format or the model changes — both alter what
#: the vectors mean, and vectors from two versions must not be compared.
EMBEDDING_PROMPT_VERSION = "embedding-v1"

#: Matches EMBEDDING_MAX_CHARS in shared/types/embedding.ts. Core truncates in
#: SQL so the fingerprint and the embedded text always describe one string;
#: this is a defensive backstop, not the enforcement point.
EMBEDDING_MAX_CHARS = 8000


async def run_embedding(req: ExecuteRequest) -> AIResult:
    """Embed the canonical text carried in `input.description`.

    NOTE the reuse of `description`. The frozen data-boundary contract
    (shared/contracts/ai/ai-contracts.schema.json) was NOT widened for this
    feature: `description` is the field for "the text to process", and the
    canonical text — built by Postgres in migration 014's generated column — is
    exactly that. Adding a `texts` array would have bought request batching at
    the cost of changing a contract whose `additionalProperties: false` is a
    tested security property. Concurrency is recovered in the worker instead,
    where it costs nothing.

    `subject` is null on this path for the same reason: splitting the canonical
    text back into two fields would create a second spelling of a string whose
    single spelling is the entire idempotency mechanism.
    """
    started = time.perf_counter()

    text = req.input.description or ""
    if not text.strip():
        # Permanent: empty text is empty on every retry too.
        raise _feature_error("invalid_input", "text must not be empty", "permanent")

    if not config.embedding_enabled:
        # Honest unavailability. Temporary, so the item stays pending and is
        # retried once a credential exists — an unconfigured deployment must
        # never write a fabricated or zero vector into the corpus.
        raise _feature_error(
            "provider_not_configured",
            "no embedding provider credential is configured",
            "temporary",
        )

    from ..integrations.llm_client import (
        LLMPermanentError,
        LLMTemporaryError,
        _classify_provider_exception,
    )

    client = _embeddings()

    try:
        vector = await client.create(text=text[:EMBEDDING_MAX_CHARS])
    except Exception as exc:  # noqa: BLE001 — reclassified immediately below
        code, kind = _classify_provider_exception(exc)
        raise _feature_error(code, str(exc)[:300], kind) from exc

    # The boundary assertion. A deployment that starts returning a different
    # width is a configuration fault, not a transient one: retrying six times
    # cannot change it, so it fails permanently and loudly.
    if len(vector) != config.embedding_dim:
        raise _feature_error(
            "embedding_dim_mismatch",
            f"provider returned {len(vector)} dimensions, expected {config.embedding_dim}",
            "permanent",
        )

    return AIResult(
        feature="embedding",
        status="succeeded",
        # Core validates this — finite, correct width, non-zero — before any
        # of it reaches a column. Python returning it is not Core accepting it.
        data={"vector": vector, "dim": len(vector), "model": config.embedding_model_id},
        confidence=None,
        provider="azure",
        model=config.embedding_model_id,
        model_version=None,
        prompt_version=EMBEDDING_PROMPT_VERSION,
        latency_ms=int((time.perf_counter() - started) * 1000),
        fallback_used=False,
    )


def _feature_error(code: str, message: str, kind: str):
    # Imported lazily to avoid a circular import: features.py imports this
    # module, and FeatureError lives there.
    from .features import FeatureError

    return FeatureError(code, message, kind)


# The process-lifetime embeddings transport, cached for the same reason the
# chat transport is: a connection pool rebuilt per call is not a pool.
_EMBEDDINGS = None


def _embeddings():
    global _EMBEDDINGS  # noqa: PLW0603 — a process-lifetime singleton
    if _EMBEDDINGS is not None:
        return _EMBEDDINGS
    from ..integrations.embedding_client import HttpxEmbeddings

    _EMBEDDINGS = HttpxEmbeddings(
        base_url=config.azure_embedding_endpoint,
        api_key=config.azure_embedding_api_key,
        deployment=config.azure_embedding_deployment,
        api_version=config.azure_embedding_api_version,
        timeout_seconds=config.classification_budget_seconds,
    )
    return _EMBEDDINGS


def set_embeddings(stub) -> None:
    """Test seam: substitute the transport. Never used in production."""
    global _EMBEDDINGS  # noqa: PLW0603 — module-level test seam
    _EMBEDDINGS = stub

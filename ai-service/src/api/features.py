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

from ..config import config
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


FEATURES: dict[str, Callable[[ExecuteRequest], AIResult]] = {
    "noop": run_noop,
}

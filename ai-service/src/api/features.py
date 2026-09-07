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

FEATURES: dict[str, Callable[[ExecuteRequest], AIResult]] = {
    "noop": run_noop,
}

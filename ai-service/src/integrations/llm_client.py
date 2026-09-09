"""OpenRouter client — Phase 4.

THE ONE INVARIANT THIS FILE MUST NOT BREAK:

    BullMQ is the only retry owner.

So everything here is hard-bounded by construction, not by convention:

  * at most TWO provider calls per classification — one normal, one repair —
    expressed as a fixed sequence, never a loop with a condition;
  * the transport is plain httpx with NO retry facility at all, rather than the
    `openai` SDK (which retries twice by default and whose 1.6.1 release is
    additionally incompatible with the httpx 0.28 this repo pins — see
    HttpxChatCompletions). Nothing to disable is safer than something to
    remember to disable;
  * a single wall-clock budget covers both calls together, so a slow first call
    leaves less time for the repair rather than doubling the ceiling;
  * no sleeps, no backoff, no re-enqueue.

The budget sits BELOW the worker's 10s timeout on purpose (Phase 3 Step 6
ordering rule): Python must give up first, so the worker receives a
deterministic error it can classify instead of abandoning a call that keeps
running and billing.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Protocol

import structlog
from pydantic import BaseModel, ValidationError

log = structlog.get_logger(service="ai-service")


class LLMTemporaryError(RuntimeError):
    """The call might succeed later — provider down, timeout, 429, 5xx.

    Maps to AIError(kind="temporary"), so BullMQ retries it.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class LLMPermanentError(RuntimeError):
    """The same call returns the same answer — malformed output, bad request.

    Maps to AIError(kind="permanent"): BullMQ stops immediately rather than
    burning six attempts on a response that will be wrong every time.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ImageContent(Protocol):
    """Just enough of an image to build a data URL.

    A Protocol rather than an import of `src.api.schemas.ImageInput`: this
    module is the provider transport and must not depend on the API layer's
    models, which is the same reason `ChatCompletions` is one.
    """

    content_type: str
    base64: str


@dataclass
class StructuredResult:
    """A validated model instance plus what it cost to get one."""

    value: BaseModel
    provider_calls: int
    used_repair: bool
    used_json_object_fallback: bool
    latency_ms: int


class ChatCompletions(Protocol):
    """The narrow slice of the OpenAI-compatible client actually used.

    Typed as a Protocol so tests can drive the full call/parse/repair path with
    a fake that never touches the network — the same seam `fetchImpl` provides
    on the TypeScript side.
    """

    async def create(self, **kwargs: Any) -> Any: ...


def _strip_fence(text: str) -> str:
    """Remove a ```json ... ``` wrapper if the model added one anyway."""
    t = text.strip()
    if not t.startswith("```"):
        return t
    t = t.split("\n", 1)[1] if "\n" in t else ""
    if t.rstrip().endswith("```"):
        t = t.rstrip()[: -len("```")]
    return t.strip()


class OpenRouterClient:
    """Structured classification against an OpenAI-compatible endpoint."""

    def __init__(
        self,
        *,
        completions: ChatCompletions,
        model: str,
        budget_seconds: float,
        strict_schema: bool = True,
    ) -> None:
        self._completions = completions
        self._model = model
        self._budget = budget_seconds
        self._strict_schema = strict_schema

    async def generate_structured(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        request_id: str,
        image: ImageContent | None = None,
    ) -> StructuredResult:
        """One classification. At most two provider calls, one shared budget."""
        started = time.monotonic()
        deadline = started + self._budget

        def remaining() -> float:
            return deadline - time.monotonic()

        # ── The user turn: a plain string, or content blocks when an image
        # is present — Phase 19.
        #
        # ⚠️ TEXT-ONLY KEEPS THE EXACT SHAPE IT ALWAYS HAD. `content` stays a
        # STRING for every existing feature rather than becoming a one-element
        # block list "for consistency". Classification, summary, RAG, reranking
        # and copilot all go through this method, and changing the wire shape of
        # their request to accommodate a feature none of them use would put five
        # working prompts at risk for a tidiness argument.
        #
        # The multimodal branch is the provider's standard content-block form:
        # the text first so the instruction is read before the image, then the
        # image as a data URL built from Core-verified values.
        user_content: Any = user_prompt
        if image is not None:
            user_content = [
                {"type": "text", "text": user_prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        # `content_type` is a Literal on the Pydantic model and
                        # the base64 is produced by Core, so neither is free
                        # text being interpolated into a URL.
                        "url": f"data:{image.content_type};base64,{image.base64}",
                        # 'high' would tile the image into many more patches for
                        # a large multiple of the tokens. A support screenshot's
                        # error text is legible at 'auto', and the cost
                        # difference is the whole per-call budget.
                        "detail": "auto",
                    },
                },
            ]

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

        # Strict structured outputs need every property in `required` and
        # additionalProperties:false throughout — see strict_json_schema.
        from src.api.classification_schema import strict_json_schema

        schema = strict_json_schema(response_model)
        use_strict = self._strict_schema
        calls = 0
        used_fallback = False

        # TWO ATTEMPTS, FIXED. `range(2)` rather than a while-loop is the point:
        # there is no condition under which a third call can happen.
        for attempt in range(2):
            budget = remaining()
            if budget <= 0:
                raise LLMTemporaryError(
                    "provider_timeout",
                    f"classification budget of {self._budget}s exhausted before attempt {attempt + 1}",
                )

            kwargs: dict[str, Any] = {
                "model": self._model,
                "messages": messages,
                # Deterministic: the same ticket must classify the same way.
                "temperature": 0,
                "stream": False,
            }
            if use_strict:
                kwargs["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "ClassificationOutput",
                        "schema": schema,
                        "strict": True,
                    },
                }
            else:
                kwargs["response_format"] = {"type": "json_object"}

            try:
                calls += 1
                completion = await asyncio.wait_for(
                    self._completions.create(**kwargs), timeout=budget
                )
            except TimeoutError as exc:
                # Includes asyncio.TimeoutError. The provider may be fine next
                # time, so this is temporary and BullMQ owns the retry.
                raise LLMTemporaryError(
                    "provider_timeout", f"provider did not answer within {budget:.1f}s"
                ) from exc
            except Exception as exc:  # noqa: BLE001 — classified below, never swallowed
                code, kind = _classify_provider_exception(exc)
                if kind == "permanent":
                    raise LLMPermanentError(code, str(exc)[:300]) from exc
                raise LLMTemporaryError(code, str(exc)[:300]) from exc

            raw = _extract_content(completion)

            # A provider that rejects strict json_schema will have raised above;
            # an empty body here means it accepted the request and produced
            # nothing useful, which a repair round cannot fix.
            if not raw.strip():
                if attempt == 0:
                    messages.append({"role": "assistant", "content": ""})
                    messages.append(
                        {"role": "user", "content": "Your reply was empty. Reply with ONLY the JSON object."}
                    )
                    continue
                raise LLMPermanentError("malformed_ai_response", "provider returned empty content")

            try:
                data = json.loads(_strip_fence(raw))
                value = response_model.model_validate(data)
            except (json.JSONDecodeError, ValidationError) as exc:
                if attempt == 0:
                    # THE ONE REPAIR. Ask the model to fix its own output, in
                    # the same conversation, sharing the same budget.
                    log.warning(
                        "classification.invalid_output_repairing",
                        request_id=request_id,
                        error=str(exc)[:200],
                    )
                    from src.api.prompts import REPAIR_INSTRUCTION

                    messages.append({"role": "assistant", "content": raw})
                    # Text-only, deliberately: the image is already in the
                    # conversation history above, and re-sending it would bill a
                    # second image for a request that is only asking the model to
                    # fix its own JSON.
                    messages.append(
                        {"role": "user", "content": REPAIR_INSTRUCTION.format(error=str(exc)[:300])}
                    )
                    continue
                # Second failure. Permanent: the model has now been shown the
                # error once and still could not produce valid output.
                raise LLMPermanentError(
                    "malformed_ai_response",
                    f"invalid structured output after one repair: {str(exc)[:200]}",
                ) from exc

            return StructuredResult(
                value=value,
                provider_calls=calls,
                used_repair=attempt > 0,
                used_json_object_fallback=used_fallback,
                latency_ms=int((time.monotonic() - started) * 1000),
            )

        # Unreachable: the loop either returns or raises on attempt 1.
        raise LLMPermanentError("malformed_ai_response", "classification produced no valid output")


def _extract_content(completion: Any) -> str:
    """Pull the message content out of an OpenAI-shaped completion."""
    try:
        return completion.choices[0].message.content or ""
    except (AttributeError, IndexError, TypeError) as exc:
        raise LLMPermanentError(
            "malformed_ai_response", f"unexpected completion shape: {exc}"
        ) from exc


# Azure returns a content-policy rejection as an ordinary 400 whose body names
# the filter. Recognising it changes the CODE only — never the retryability,
# never the terminal state, never what a user sees.
_CONTENT_FILTER_MARKERS = ("content management policy", "content_filter", "responsibleai")


def _classify_provider_exception(exc: Exception) -> tuple[str, str]:
    """Map a provider exception onto (code, temporary|permanent).

    Status-driven where a status is available, mirroring the worker's single
    classifier: 408/429 and 5xx are timing/availability problems and retry;
    other 4xx mean the request itself is wrong and will be wrong again.
    """
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        if status in (408, 429):
            return (f"provider_http_{status}", "temporary")
        if 400 <= status < 500:
            # A DISTINCT CODE for a provider content-policy rejection.
            #
            # Operationally these are a different thing from a malformed
            # request: the ticket text tripped Azure's filter, and no amount of
            # fixing our request would change that. Giving it its own code lets
            # an operator count and query them instead of inferring from a
            # generic 400.
            #
            # Everything else is deliberately UNCHANGED — still permanent,
            # still terminal, still invisible to ordinary users, no bypass and
            # no retry. Only the label is more precise.
            text = str(exc).lower()
            if any(marker in text for marker in _CONTENT_FILTER_MARKERS):
                return ("provider_content_filter", "permanent")
            return (f"provider_http_{status}", "permanent")
        return (f"provider_http_{status}", "temporary")

    name = type(exc).__name__.lower()
    if "timeout" in name:
        return ("provider_timeout", "temporary")
    if "connection" in name or "apiconnection" in name:
        return ("provider_unreachable", "temporary")
    # Unknown provider failures are treated as temporary: a transient fault
    # misread as permanent dead-letters real work, which is the worse error.
    return ("provider_error", "temporary")


class HttpxChatCompletions:
    """A minimal OpenAI-compatible `chat.completions.create`, over httpx.

    Implements the `ChatCompletions` Protocol above, so the client, the tests
    and the production path all use the same seam.

    NO RETRY LOGIC LIVES HERE, and none can be configured into it. That is the
    point: the only bounded repeat in this service is the single repair round
    in `generate_structured`, and BullMQ owns everything else.

    TWO PROVIDERS, ONE BODY. Azure OpenAI and OpenRouter send an identical
    chat-completions payload but disagree on two things only:

        OpenRouter  {base}/chat/completions          Authorization: Bearer …
        Azure       {base}/openai/deployments/{d}/chat/completions
                        ?api-version={v}             api-key: …

    That difference is handled here and nowhere else, so nothing upstream —
    prompt, schema, parse, repair — knows which provider it is talking to.
    Azure also addresses the model by DEPLOYMENT name in the URL and ignores
    the `model` field in the body.

    The response is adapted to the attribute shape the client reads
    (`.choices[0].message.content`) so the parsing code is identical whether it
    is talking to a real provider or a test double.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout_seconds: float,
        provider: str = "openrouter",
        azure_deployment: str = "",
        azure_api_version: str = "",
    ) -> None:
        self._http: Any = None
        self._provider = provider
        self._api_key = api_key
        self._timeout = timeout_seconds
        base = base_url.rstrip("/")
        if provider == "azure":
            self._url = (
                f"{base}/openai/deployments/{azure_deployment}/chat/completions"
                f"?api-version={azure_api_version}"
            )
        else:
            self._url = base + "/chat/completions"

    def _client(self) -> Any:
        """A SHARED, connection-pooled httpx client.

        ⚠️ THIS WAS A REAL DEFECT, and it is why it is worth spelling out.

        The original built `httpx.AsyncClient(...)` inside `create()`, so every
        provider call opened a fresh TCP connection and completed a fresh TLS
        handshake to Azure. Measured against the same endpoint, same prompt and
        same schema:

            pooled client   n=12 concurrent -> p50 1297ms, 5.0 req/s, 0 over 8s
            per-call client n=12 concurrent -> p50 5400ms, 0.2 req/s, 8 timeouts

        Roughly four seconds per request of pure connection setup, which under
        concurrency turned into simultaneous handshakes, timeouts at the 8s
        budget, retries, and more load — the "burst spiral" attributed in the
        Phase 5 report to Azure capacity. Azure was never the bottleneck: it
        serves 12 concurrent summary calls comfortably and the rate-limit
        headers show 1400 req/min with 1399 remaining.

        Created lazily and kept for the process lifetime. `limits` is set
        explicitly rather than left to the default so the pool cannot become a
        second, invisible concurrency limit below the worker's.
        """
        import httpx

        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=self._timeout,
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=32),
            )
        return self._http

    async def aclose(self) -> None:
        """Release the pooled connections. Used by tests; the process exit
        otherwise reclaims them."""
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def create(self, **kwargs: Any) -> Any:
        import httpx  # noqa: F401 — kept for the type used in _client

        if self._provider == "azure":
            # Azure authenticates with `api-key`, not a bearer token.
            headers = {"api-key": self._api_key, "Content-Type": "application/json"}
        else:
            headers = {
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                # OpenRouter attribution headers. Neither identifies a tenant.
                "HTTP-Referer": "https://iris-ticketing.local",
                "X-Title": "IRIS Ticketing",
            }
        response = await self._client().post(self._url, headers=headers, json=kwargs)

        if response.status_code >= 400:
            # Carry the status so _classify_provider_exception can decide
            # retryability from it rather than from message text. A short slice
            # of the body goes with it because "HTTP 400" alone cannot be
            # diagnosed — Azure returns the actual reason there. Bounded, and
            # it never contains the key: the credential travels in a header.
            detail = response.text[:300] if response.text else ""
            err = RuntimeError(f"provider returned HTTP {response.status_code}: {detail}")
            err.status_code = response.status_code  # type: ignore[attr-defined]
            raise err

        body = response.json()
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=(body.get("choices") or [{}])[0].get("message", {}).get("content", "")
                    ),
                    finish_reason=(body.get("choices") or [{}])[0].get("finish_reason"),
                )
            ]
        )

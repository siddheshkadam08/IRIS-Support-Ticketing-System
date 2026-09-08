"""Azure OpenAI embeddings transport — Phase 10.

Deliberately a SEPARATE transport from HttpxChatCompletions rather than a
`mode` flag on it. Embeddings are a different endpoint, a different deployment,
a different api-version and a different response shape; the only thing the two
share is a hostname and an auth header. Folding them together would produce one
class with two disjoint halves and a boolean deciding which half runs.

Everything the chat transport got right is kept, for the same reasons:

  * NO RETRY FACILITY AT ALL. BullMQ — and, on this path, the worker's bounded
    embedding cycle — is the only retry owner. There is nothing here to
    disable, which is safer than something to remember to disable.
  * A SHARED, POOLED httpx client kept for the process lifetime. Rebuilding it
    per call cost ~4s of TCP+TLS setup per request on the chat path and was
    misdiagnosed as provider capacity; see HttpxChatCompletions._client.
  * The credential travels in a header and is never logged, never returned in
    an error, and never part of a URL.
"""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger(service="ai-service")


class HttpxEmbeddings:
    """A minimal OpenAI-compatible `embeddings.create`, over httpx.

    Azure addresses the model by DEPLOYMENT name in the path and carries the
    api-version in the query string:

        {base}/openai/deployments/{deployment}/embeddings?api-version={v}
        api-key: <key>

    ⚠️ THE `dimensions` PARAMETER IS DELIBERATELY NOT SENT.

    `text-embedding-3-small` does honour it — verified live, a request for 384
    returns 384 — and that is exactly the trap. Silently requesting a narrower
    vector to fit whatever the database column happens to be would trade
    retrieval quality for the appearance of compatibility, and would do it in a
    place nobody looks. The native width is 1536; the column is `vector(1536)`;
    a mismatch is a migration, not a request parameter.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        deployment: str,
        api_version: str,
        timeout_seconds: float,
    ) -> None:
        self._http: Any = None
        self._api_key = api_key
        self._timeout = timeout_seconds
        base = base_url.rstrip("/")
        self._url = (
            f"{base}/openai/deployments/{deployment}/embeddings?api-version={api_version}"
        )

    def _client(self) -> Any:
        import httpx

        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=self._timeout,
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=32),
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def create(self, *, text: str) -> list[float]:
        """One text in, one vector out.

        Raises RuntimeError carrying `.status_code` on an HTTP error, matching
        what HttpxChatCompletions raises so `_classify_provider_exception`
        decides retryability from the status rather than from message text.
        """
        headers = {"api-key": self._api_key, "Content-Type": "application/json"}
        response = await self._client().post(self._url, headers=headers, json={"input": text})

        if response.status_code >= 400:
            # A bounded slice of the body: "HTTP 400" alone is undiagnosable
            # and Azure puts the real reason there. It cannot contain the key,
            # which travels in a header.
            detail = response.text[:300] if response.text else ""
            err = RuntimeError(f"provider returned HTTP {response.status_code}: {detail}")
            err.status_code = response.status_code  # type: ignore[attr-defined]
            raise err

        body = response.json()

        # Shape-check before indexing. A provider that answers 200 with an
        # unexpected body should produce a clear permanent error here, not an
        # IndexError or KeyError three frames away.
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list) or not data:
            raise RuntimeError("provider returned no embedding data")
        vector = data[0].get("embedding") if isinstance(data[0], dict) else None
        if not isinstance(vector, list):
            raise RuntimeError("provider response contained no embedding array")

        return vector

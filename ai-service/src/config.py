"""Configuration for the AI service. Validated at import, fails loudly."""

from __future__ import annotations

import os

# Names that must NEVER appear in this service's environment.
#
# ADR-007 asks for the ABSENCE of a database credential, not a wrong one, so
# that a mistake fails at boot rather than silently opening a second, unpoliced
# path to the data. RLS is applied per-session by core-service; one forgotten
# product_id predicate in a similarity query written here would leak one
# product's ticket text into another product's answer, and it would raise no
# error anywhere.
#
# If this service ever needs neighbours, it calls back into
# core-service/internal/*, which runs the query inside an RLS-scoped
# transaction. The extra hop is the price of one enforcement point.
FORBIDDEN_ENV = (
    "DATABASE_URL",
    "CORE_DATABASE_URL",
    "ADMIN_DATABASE_URL",
    "MIGRATOR_DATABASE_URL",
    "POSTGRES_URL",
    "PGDATABASE",
    "PGHOST",
)

# Credentials that belong to other services. This one holds exactly one secret;
# seeing either of these means a deployment mistake worth failing loudly on.
FORBIDDEN_CREDENTIALS = (
    "INTERNAL_API_KEY",
    "AI_WORKER_HMAC_SECRET",
)


class ConfigError(RuntimeError):
    """Raised at boot so the container dies instead of serving traffic."""


def assert_no_database_credentials(env: dict[str, str] | None = None) -> None:
    env = os.environ if env is None else env
    present = [name for name in FORBIDDEN_ENV if env.get(name)]
    if present:
        raise ConfigError(
            "ai-service must not hold a database credential. "
            f"Found: {', '.join(present)}. See docs/adr/007-polyglot-topology-one-db-credential.md"
        )


def assert_no_foreign_credentials(env: dict[str, str] | None = None) -> None:
    """Key separation, enforced at boot rather than trusted.

    INTERNAL_API_KEY is the gateway's platform-wide credential and
    AI_WORKER_HMAC_SECRET is the worker's Core-facing one. Neither has any use
    here, and holding one would quietly undo the separation Phase 2 exists to
    create.
    """
    env = os.environ if env is None else env
    present = [name for name in FORBIDDEN_CREDENTIALS if env.get(name)]
    if present:
        raise ConfigError(
            "ai-service must not hold another service's credential. "
            f"Found: {', '.join(present)}."
        )


class Config:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        env = os.environ if env is None else env
        assert_no_database_credentials(env)
        assert_no_foreign_credentials(env)

        self.log_level: str = env.get("LOG_LEVEL", "info")
        self.port: int = int(env.get("AI_SERVICE_PORT", "5000"))

        # Phase 2 service authentication.
        #
        # The worker signs each request; this service verifies it with the
        # shared iris_hmac package — the same canonical string, vectors and
        # timing-safe comparison the TypeScript side uses. No new crypto was
        # introduced, and no new dependency: hmac/hashlib are stdlib.
        #
        # This secret is DIFFERENT from the one the worker uses for Core, on
        # purpose: leaking this one must not grant access to core-service.
        # This service never sees AI_WORKER_HMAC_SECRET or INTERNAL_API_KEY.
        self.hmac_secret: str = env.get(
            "AI_SERVICE_HMAC_SECRET", "dev_ai_service_hmac_secret_change_me"
        )
        # Phase 11: core-service signs query-embedding requests with its OWN
        # secret, not the worker's. Hybrid retrieval needs an embedding on a
        # synchronous user request, and the worker is not on that path — so
        # Core became a second caller for the first time.
        #
        # A SEPARATE secret is the whole point: leaking the worker's
        # Python-facing credential must not grant Core's access, and vice
        # versa. This service still never sees AI_WORKER_HMAC_SECRET or
        # INTERNAL_API_KEY, and still refuses to boot if either is present.
        self.core_hmac_secret: str = env.get(
            "AI_CORE_HMAC_SECRET", "dev_ai_core_hmac_secret_change_me"
        )
        self.model_version: str = env.get("AI_STUB_MODEL_VERSION", "1")

        # ── Phase 4: classification provider ─────────────────────────────
        #
        # TWO OpenAI-compatible providers are supported, and exactly one is
        # selected at boot by which credential is present. Azure wins when both
        # are set, because it is the explicit operator choice.
        #
        # This is NOT a general provider abstraction and must not become one.
        # It is two URL shapes and two auth headers behind one interface,
        # because Azure OpenAI and OpenRouter speak the same chat-completions
        # body but disagree on how a request is addressed and authenticated.
        #
        # Keys are read from the environment and NEVER committed or logged.
        # Absent means classification is unavailable and says so, rather than
        # pretending to work.
        self.openrouter_api_key: str = env.get("OPENROUTER_API_KEY", "")

        # Azure OpenAI. The deployment name — not a model id — addresses the
        # model, and the api-version is part of the URL rather than a header.
        self.azure_api_key: str = env.get("AZURE_OPENAI_API_KEY", "")
        self.azure_endpoint: str = env.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
        self.azure_deployment: str = env.get("AZURE_OPENAI_DEPLOYMENT", "")
        self.azure_api_version: str = env.get("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
        self.openrouter_base_url: str = env.get(
            "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
        )
        self.classification_model: str = env.get(
            "CLASSIFICATION_MODEL", "google/gemma-3-27b-it"
        )
        # The COMBINED budget for both provider calls (one normal, one repair).
        #
        # Sits below the worker's 10s AI_TIMEOUT_MS by design (Phase 3 Step 6):
        # Python must give up first so the worker gets a deterministic error it
        # can classify, instead of abandoning a call that keeps running and
        # billing while a retry starts a second one.
        self.classification_budget_seconds: float = float(
            env.get("CLASSIFICATION_BUDGET_SECONDS", "8")
        )

        # Phase 12: reranking sits on a SYNCHRONOUS path where a user is
        # waiting, so its budget is far tighter than classification's 8s.
        #
        # Measured before it was chosen: this deployment answers a reranking
        # call at p50 ~1.7s / p95 ~2.1s, and the latency is flat in candidate
        # count because it is dominated by the deployment baseline rather than
        # by input size. 4s leaves roughly 2x headroom over p95 while keeping
        # the worst case short enough that falling back to Phase 11 ordering is
        # still a fast answer rather than a hang.
        self.reranking_budget_seconds: float = float(
            env.get("RERANKING_BUDGET_SECONDS", "4")
        )

        # Phase 13: grounded answer generation. Also synchronous, but it
        # GENERATES PROSE rather than a list of integers, so it is inherently
        # slower than reranking — output tokens dominate generation time.
        # Measured before it was chosen; see the Phase 13 notes. 6s leaves
        # headroom over the observed p95 while keeping the worst case short
        # enough that falling back to plain retrieval is still a fast answer.
        self.rag_budget_seconds: float = float(env.get("RAG_BUDGET_SECONDS", "6"))

        # Phase 15: Copilot writes a full customer reply, so it generates more
        # output tokens than any other feature here — and output tokens
        # dominate generation time. An agent has explicitly asked for it and is
        # watching a spinner, which buys more patience than a widget search
        # does, but not unlimited patience.
        self.copilot_budget_seconds: float = float(env.get("COPILOT_BUDGET_SECONDS", "12"))

        # ── Phase 10: embeddings ─────────────────────────────────────────
        #
        # A SEPARATE deployment from the chat one, and therefore separate
        # variables. Azure addresses a model by deployment name, so
        # `text-embedding-3-small` and `gpt-4.1` are two endpoints that happen
        # to share a hostname; one pair of variables would force a rename the
        # day either moves.
        #
        # EMBEDDING_DIM is read but NEVER sent to the provider. It is an
        # assertion about what comes back, checked at the boundary. The model
        # would honour a narrower `dimensions` request, which is precisely why
        # this is a check rather than a parameter: quietly shrinking the vector
        # to fit the column is how a corpus silently loses recall.
        self.azure_embedding_api_key: str = env.get("AZURE_OPENAI_EMBEDDING_API_KEY", "")
        self.azure_embedding_endpoint: str = env.get(
            "AZURE_OPENAI_EMBEDDING_ENDPOINT", ""
        ).rstrip("/")
        self.azure_embedding_deployment: str = env.get(
            "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", ""
        )
        self.azure_embedding_api_version: str = env.get(
            "AZURE_OPENAI_EMBEDDING_API_VERSION", "2024-02-01"
        )
        self.embedding_dim: int = int(env.get("EMBEDDING_DIM", "1536"))

    @property
    def classification_provider(self) -> str:
        """Which provider is configured: "azure", "openrouter", or "" for none."""
        if self.azure_api_key and self.azure_endpoint and self.azure_deployment:
            return "azure"
        if self.openrouter_api_key:
            return "openrouter"
        return ""

    @property
    def classification_enabled(self) -> bool:
        """Classification needs a provider credential. Without one it is off.

        Reported honestly as a temporary failure at call time rather than
        faked, so an unconfigured deployment looks unconfigured instead of
        looking like a model that always fails.
        """
        return bool(self.classification_provider)

    @property
    def embedding_enabled(self) -> bool:
        """Embedding needs its own credential, endpoint and deployment.

        Checked independently of classification: the two are different Azure
        deployments and either can be configured without the other. Reported
        honestly as a temporary failure at call time rather than faked, so an
        unconfigured deployment looks unconfigured instead of looking like a
        provider that always fails.
        """
        return bool(
            self.azure_embedding_api_key
            and self.azure_embedding_endpoint
            and self.azure_embedding_deployment
        )

    @property
    def embedding_model_id(self) -> str:
        """Recorded on every embedded row.

        The DEPLOYMENT name, for the same reason classification records one:
        the underlying model id is not observable from the Azure API, so the
        deployment is the honest answer rather than a guess. Vectors from
        different models are not comparable, which is what makes this worth
        storing per row.
        """
        return f"azure/{self.azure_embedding_deployment}"

    @property
    def classification_model_id(self) -> str:
        """What to record as `model` on the execution.

        For Azure this is the DEPLOYMENT name, which is what actually
        determines the model served — the underlying model id is not
        observable from the API, so recording the deployment is the honest
        answer rather than a guess.
        """
        if self.classification_provider == "azure":
            return f"azure/{self.azure_deployment}"
        return self.classification_model

        # A secret committed to the repository is not a secret. Refuse to boot
        # in production on the placeholder or on something brute-forceable.
        if env.get("NODE_ENV") == "production":
            if (
                self.hmac_secret == "dev_ai_service_hmac_secret_change_me"
                or len(self.hmac_secret) < 32
            ):
                raise ConfigError(
                    "AI_SERVICE_HMAC_SECRET is a dev placeholder or shorter than 32 "
                    "characters; refusing to start in production."
                )


config = Config()

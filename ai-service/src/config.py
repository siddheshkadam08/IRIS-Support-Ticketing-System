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
        self.model_version: str = env.get("AI_STUB_MODEL_VERSION", "1")

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

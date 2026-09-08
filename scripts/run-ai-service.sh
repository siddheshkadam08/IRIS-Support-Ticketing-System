#!/usr/bin/env bash
# Start ai-service locally with a DELIBERATELY FILTERED environment.
#
# ⚠️ DO NOT `source .env` HERE. ADR-007 says this service holds no Postgres
# credential — not a wrong one, none — and src/config.py refuses to boot if any
# *DATABASE_URL* is present. Sourcing the whole file therefore kills the
# process, correctly, which is how that rule was found to be working rather
# than aspirational.
#
# Only the variables this service legitimately owns are exported. Deliberately
# absent, and enforced at boot: CORE_DATABASE_URL, INTERNAL_API_KEY,
# AI_WORKER_HMAC_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWED='^(LOG_LEVEL|AI_SERVICE_PORT|AI_SERVICE_HMAC_SECRET|AI_CORE_HMAC_SECRET|AI_STUB_MODEL_VERSION|OPENROUTER_API_KEY|OPENROUTER_BASE_URL|CLASSIFICATION_MODEL|CLASSIFICATION_BUDGET_SECONDS|RERANKING_BUDGET_SECONDS|RAG_BUDGET_SECONDS|AZURE_OPENAI_API_KEY|AZURE_OPENAI_ENDPOINT|AZURE_OPENAI_DEPLOYMENT|AZURE_OPENAI_API_VERSION|AZURE_OPENAI_EMBEDDING_API_KEY|AZURE_OPENAI_EMBEDDING_ENDPOINT|AZURE_OPENAI_EMBEDDING_DEPLOYMENT|AZURE_OPENAI_EMBEDDING_API_VERSION|EMBEDDING_DIM)='

set -a
# shellcheck disable=SC2046
eval "$(grep -E "$ALLOWED" .env | sed 's/^/export /')"
set +a

# `iris_hmac` lives in shared/hmac-utils/py so signer and verifier stay ONE
# implementation across the TypeScript and Python sides. The container image
# copies it in; running on the host, PYTHONPATH is how it is found.
export PYTHONPATH="$(pwd)/shared/hmac-utils/py${PYTHONPATH:+:$PYTHONPATH}"

exec python -m uvicorn src.api.app:app --app-dir ai-service --host 0.0.0.0 --port "${AI_SERVICE_PORT:-5000}"

"""Shared pytest fixtures.

Two things happen at MODULE IMPORT time here, deliberately:

  1. `ai-service/` goes on sys.path so `src.api.app` imports exactly as it does
     under uvicorn, without needing an installed package for a service that is
     always run from its own directory.

  2. The environment is set. `src/config.py` builds its Config at import time
     (the same pattern core-service uses), so setting these inside a fixture
     would be too late — the module would already have captured the defaults
     and every authenticated request would 401. conftest.py is imported before
     any test module, which makes this the right place.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AI_SERVICE_ROOT.parent
sys.path.insert(0, str(AI_SERVICE_ROOT))
# The shared HMAC package. The container gets it by COPY; locally it is the
# same source, so signer and verifier can never diverge between the two.
sys.path.insert(0, str(REPO_ROOT / "shared" / "hmac-utils" / "py"))

TEST_SECRET = "test_ai_service_hmac_secret_0123456789"

os.environ["AI_SERVICE_HMAC_SECRET"] = TEST_SECRET

# Phase 11: core-service is a SECOND caller with its OWN secret. Deliberately a
# different value here, so a test that accidentally signs with the wrong one
# fails instead of passing by coincidence.
CORE_TEST_SECRET = "test_ai_core_hmac_secret_9876543210"
os.environ["AI_CORE_HMAC_SECRET"] = CORE_TEST_SECRET
os.environ.setdefault("LOG_LEVEL", "warning")

# The service must boot with NO database credential. If the developer's shell
# happens to export one, clear it here so the suite tests the service rather
# than the machine.
for _name in ("DATABASE_URL", "CORE_DATABASE_URL", "ADMIN_DATABASE_URL", "MIGRATOR_DATABASE_URL"):
    os.environ.pop(_name, None)

# Key separation is enforced at boot; a stray value here would fail the import.
for _name in ("INTERNAL_API_KEY", "AI_WORKER_HMAC_SECRET"):
    os.environ.pop(_name, None)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from src.api.app import app

    return TestClient(app)


@pytest.fixture(scope="session")
def contracts_dir() -> Path:
    return REPO_ROOT / "shared" / "contracts" / "ai"

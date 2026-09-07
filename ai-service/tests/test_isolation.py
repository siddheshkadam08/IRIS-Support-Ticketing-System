"""Invariant 1, as an executable test rather than a paragraph in a README.

ADR-007 rejects "polyglot with shared DB access" as actively dangerous: it
opens a second path to the data that bypasses RLS, and one forgotten
product_id predicate in a Python similarity query would leak another product's
ticket text into a customer-facing answer — silently, with no error anywhere.

The rule is easy to state and easy to break, because adding `psycopg` "just for
similarity search" will always look like a reasonable optimisation in a diff.
So it is checked here.
"""

from __future__ import annotations

import ast
import importlib.util
import os
from pathlib import Path

import pytest

from src.config import FORBIDDEN_ENV, ConfigError, assert_no_database_credentials

AI_SERVICE_SRC = Path(__file__).resolve().parents[1] / "src"

DB_MODULES = (
    "psycopg",
    "psycopg2",
    "asyncpg",
    "sqlalchemy",
    "pg8000",
    "aiopg",
    "peewee",
    "databases",
)


# The developer machine runs one shared global interpreter that other projects
# have installed psycopg2 into, so "is it importable right now" says nothing
# about THIS service's environment. The container is the environment that
# matters, and its Containerfile sets AI_SERVICE_ISOLATED_ENV=1.
#
# The other three checks below run everywhere and are the ones that actually
# catch a regression in this repository: a source import, an unpinned or
# forbidden requirement, or a boot guard that stopped guarding.
ISOLATED = os.environ.get("AI_SERVICE_ISOLATED_ENV") == "1"


@pytest.mark.skipif(
    not ISOLATED,
    reason="shared global interpreter; run inside the ai-service container "
    "(AI_SERVICE_ISOLATED_ENV=1) to assert the installed dependency set",
)
def test_no_database_driver_is_installed():
    """In the service's own environment, not even importable."""
    for module in DB_MODULES:
        assert importlib.util.find_spec(module) is None, (
            f"{module} is installed in ai-service. This service must hold no "
            "database credential — see docs/adr/007-polyglot-topology-one-db-credential.md"
        )


def test_no_source_file_imports_a_database_driver():
    """Catches a vendored or accidentally-added import even if uninstalled."""
    offenders: list[str] = []
    for path in AI_SERVICE_SRC.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf8"), filename=str(path))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                root = name.split(".")[0]
                if root in DB_MODULES:
                    offenders.append(f"{path.name}: {name}")
    assert not offenders, f"database imports found in ai-service: {offenders}"


def test_requirements_pin_every_dependency_and_list_no_db_driver():
    req = (AI_SERVICE_SRC.parent / "requirements.txt").read_text(encoding="utf8")
    lines = [
        line.strip()
        for line in req.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert lines, "requirements.txt must not be empty"
    for line in lines:
        assert "==" in line, f"unpinned dependency: {line}"
        assert line.split("==")[0].lower() not in DB_MODULES, f"db driver in requirements: {line}"


def test_boot_refuses_a_database_credential():
    """The failure must be at boot, not a silent second connection."""
    for name in FORBIDDEN_ENV:
        with pytest.raises(ConfigError):
            assert_no_database_credentials({name: "postgres://user:pw@host/db"})


def test_boot_is_fine_with_no_database_credential():
    assert_no_database_credentials({"LOG_LEVEL": "info", "AI_SERVICE_KEY": "x" * 12})


def test_the_absence_is_what_is_checked_not_a_wrong_value():
    """An empty string is absence; any value at all is a failure."""
    assert_no_database_credentials({"DATABASE_URL": ""})
    with pytest.raises(ConfigError):
        assert_no_database_credentials({"DATABASE_URL": "definitely-not-a-real-dsn"})

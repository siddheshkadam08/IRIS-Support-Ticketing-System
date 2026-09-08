"""Outbound integrations for the AI service.

Only LLM providers live here. This package must never gain a database client —
ADR-007 gives this service no database credential, enforced at boot by
src/config.py and asserted by tests/test_isolation.py.
"""

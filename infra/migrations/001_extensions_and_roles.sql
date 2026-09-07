-- 001 — extensions and roles
-- Run as a superuser. Forward-only and idempotent.

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: embedding columns exist now, populated when ai-service lands
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- trigram similarity for fuzzy KB search
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────
-- The application role is deliberately NOT the table owner.
--
-- In PostgreSQL a table owner is exempt from RLS unless FORCE is set. If the
-- app connected as the owner, every policy in 005_rls.sql would be decorative
-- and the platform's central isolation claim would be false — with no error
-- message anywhere. We do BOTH: a non-owner app role AND FORCE on every table.
-- See docs/adr/004-isolation-row-level-security.md
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iris_app') THEN
    CREATE ROLE iris_app LOGIN PASSWORD 'iris_app_dev_pw';
  END IF;
END
$$;

-- Never grant these. Either would silently defeat RLS.
ALTER ROLE iris_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE iris TO iris_app;
GRANT USAGE ON SCHEMA public TO iris_app;

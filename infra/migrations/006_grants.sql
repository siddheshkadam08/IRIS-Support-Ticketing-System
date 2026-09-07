-- 006 — grants for the non-owner application role
--
-- iris_app gets DML only. It owns nothing, so RLS applies to it
-- unconditionally (and every table is FORCE'd besides).

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO iris_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iris_app;

-- ─────────────────────────────────────────────────────────────────────────
-- The audit trail is append-only, enforced by the database.
-- Revoking UPDATE and DELETE means a fully compromised application still
-- cannot rewrite history. This is the difference between "we log things" and
-- a compliance-grade audit trail.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE UPDATE, DELETE ON audit_event FROM iris_app;

-- Products and raisers must not be able to mutate reference data.
REVOKE INSERT, UPDATE, DELETE ON product         FROM iris_app;
REVOKE INSERT, UPDATE, DELETE ON support_user    FROM iris_app;
REVOKE INSERT, UPDATE, DELETE ON announcement    FROM iris_app;
-- ticket_seq allocation needs UPDATE on product; granted narrowly instead.
GRANT UPDATE (ticket_seq) ON product TO iris_app;
-- KB view/helpful counters are the only columns the runtime bumps.
GRANT UPDATE (views, helpful_yes, helpful_no) ON kb_article TO iris_app;
REVOKE INSERT, DELETE ON kb_article FROM iris_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO iris_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO iris_app;

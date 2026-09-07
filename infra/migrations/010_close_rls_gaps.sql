-- 010 — close two RLS gaps found by auditing the live schema
--
-- Writing docs/schema.md meant checking every table's RLS status against the
-- database rather than against memory. Two tables carried tenant- or
-- user-scoped data with no policy at all:
--
--   idempotency_key    has product_id — a stored RESPONSE BODY keyed by
--                      product. Unscoped, a bug could return one tenant's
--                      cached response to another.
--   support_user_skill user-scoped. Not sensitive, but it let any role
--                      enumerate staff capabilities across every tenant.
--
-- Neither was reachable through current code paths. Both are fixed anyway:
-- invariant #2 says no unscoped read, and "unreachable today" is how a gap
-- survives long enough to become reachable tomorrow.

-- ── idempotency_key ──────────────────────────────────────────────────────
ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_isolation ON idempotency_key;
CREATE POLICY idempotency_isolation ON idempotency_key
  USING (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
  WITH CHECK (product_id = ANY (app_scope()) OR app_role() = 'super_admin');

CREATE INDEX IF NOT EXISTS idempotency_product_idx ON idempotency_key (product_id, key);

-- ── support_user_skill ───────────────────────────────────────────────────
ALTER TABLE support_user_skill ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_user_skill FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skill_visibility ON support_user_skill;
CREATE POLICY skill_visibility ON support_user_skill
  USING (
    -- Staff may see skills (the assignee picker needs them); customers and
    -- integrating products may not enumerate our people at all.
    app_role() IN ('super_admin', 'product_admin', 'manager', 'agent')
  )
  WITH CHECK (app_role() IN ('super_admin', 'product_admin'));

-- request_nonce and schema_migration are deliberately left without RLS:
-- neither holds tenant data. A nonce is an opaque random string with no
-- product association, and schema_migration is a list of filenames.

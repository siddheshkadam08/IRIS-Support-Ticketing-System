-- 013 — AI execution history
--
-- Two jobs, one small table.
--
--  1. DURABLE IDEMPOTENCY. BullMQ delivery is at-least-once and a re-dispatched
--     outbox row gets a brand-new job id while keeping its event id. The unique
--     constraint below is therefore on (event_id, feature) — never on job_id,
--     and never in Redis. Redis holds queued work; Postgres holds the truth
--     about what has already been applied. A guard that lives only in Redis
--     evaporates on restart, which is precisely when duplicates happen.
--
--  2. EXECUTION HISTORY, separate from ticket state (ADR-004 in
--     implementation.md). The ticket keeps the CURRENT AI state in its existing
--     columns; this table keeps the record of every execution that produced it,
--     with the provider/model/version needed to answer "why did it decide that
--     in March?" after a model swap.
--
-- The key is (event_id, feature) rather than event_id alone because one event
-- will later fan out to several features — ticket.created → classification AND
-- sentiment AND summary — each succeeding or failing independently. Including
-- `feature` now means Phase 9 needs no migration.

CREATE TABLE IF NOT EXISTS ai_execution (
  id             text PRIMARY KEY,                       -- aix_<ULID>
  product_id     text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  ticket_id      text NOT NULL REFERENCES ticket(id)  ON DELETE CASCADE,
  feature        text NOT NULL,
  event_id       text NOT NULL,                          -- event_outbox.event_id — the durable fact
  job_id         text,                                   -- BullMQ dispatch id — changes on re-dispatch
  correlation_id text,                                   -- == the originating request_id
  status         text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  attempt        integer NOT NULL DEFAULT 1,
  provider       text,
  model          text,
  model_version  text,
  prompt_version text,
  confidence     numeric,
  latency_ms     integer,
  result         jsonb,                                  -- the VALIDATED result only
  fallback_used  boolean NOT NULL DEFAULT false,
  error_code     text,
  error_message  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,

  -- The Phase 1 idempotency guarantee, enforced by the database.
  UNIQUE (event_id, feature)
);

COMMENT ON TABLE ai_execution IS
  'One row per (event_id, feature) AI execution. UNIQUE(event_id, feature) is the durable idempotency key; retries update the row in place. Stores validated results only — never raw model output and never ticket text.';

-- Leads with product_id, like every other product-scoped index here: RLS adds a
-- predicate on it to every single query.
CREATE INDEX IF NOT EXISTS ai_execution_product_ticket_idx
  ON ai_execution (product_id, ticket_id, created_at DESC);

-- ── Row-Level Security ───────────────────────────────────────────────────
-- BOTH lines, every time. ENABLE alone leaves the owner exempt and the policy
-- becomes decorative with no error message anywhere.
ALTER TABLE ai_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_execution FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_execution_isolation ON ai_execution;
CREATE POLICY ai_execution_isolation ON ai_execution
  USING      (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
  WITH CHECK (product_id = ANY (app_scope()) OR app_role() = 'super_admin');

-- ── Grants ───────────────────────────────────────────────────────────────
-- Explicit, following 007 and 008, rather than relying on the ALTER DEFAULT
-- PRIVILEGES in 006 still being in scope for a security-relevant table.
GRANT SELECT, INSERT, UPDATE ON ai_execution TO iris_app;

-- Execution history is the governance record (Phase 17). The application can
-- write it and correct a running row, but must not be able to erase history —
-- the same reasoning that makes audit_event append-only in 006_grants.sql.
REVOKE DELETE ON ai_execution FROM iris_app;

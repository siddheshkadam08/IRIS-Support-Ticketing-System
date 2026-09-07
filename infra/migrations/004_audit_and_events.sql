-- 004 — audit trail, transactional outbox, idempotency

-- Append-only. UPDATE and DELETE are revoked from iris_app in 006_grants.sql,
-- so the application CANNOT rewrite history even if fully compromised.
-- Compliance-grade by construction, not by policy. (HLD §16.1)
CREATE TABLE IF NOT EXISTS audit_event (
  id          bigserial PRIMARY KEY,
  product_id  text,
  actor_type  text NOT NULL,   -- raiser | support_user | product | system | automation
  actor_ref   text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  request_id  text,
  source_ip   text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_product_time_idx ON audit_event (product_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entity_idx       ON audit_event (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx        ON audit_event (actor_ref, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Transactional outbox.
--
-- Events are inserted in the SAME transaction as the state change they
-- describe. Never enqueue after COMMIT: if the process or Redis dies in
-- between, the job is lost forever — and a lost access.revoke means access
-- outlives the ticket, silently. That is a two-phase-commit failure, not a
-- crypto failure, and it is how this feature actually breaks. (HLD §11.1)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_outbox (
  id           bigserial PRIMARY KEY,
  event_id     text NOT NULL UNIQUE,
  product_id   text,
  aggregate    text NOT NULL,
  aggregate_id text,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON event_outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_key (
  product_id          text NOT NULL,
  key                 text NOT NULL,
  request_fingerprint text NOT NULL,
  status_code         integer NOT NULL,
  response_body       jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency_key (created_at);

-- Replay defence for HMAC nonces when Redis is unavailable.
CREATE TABLE IF NOT EXISTS request_nonce (
  nonce      text PRIMARY KEY,
  seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nonce_seen_idx ON request_nonce (seen_at);

CREATE TABLE IF NOT EXISTS schema_migration (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

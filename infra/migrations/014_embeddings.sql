-- 014 — Embedding infrastructure
--
-- Phase 10. Turns two decorative `vector(384)` columns into a working,
-- self-maintaining embedding corpus. No new table, no new RLS policy, no new
-- event type, no trigger.
--
-- ── WHY THE DIMENSION CHANGES ───────────────────────────────────────────
--
-- 002 and 003 declared vector(384) speculatively, before a provider existed.
-- The provider now exists: Azure OpenAI `text-embedding-3-small`, whose native
-- output is 1536 — verified live against the configured deployment (HTTP 200,
-- 1536 floats). EMBEDDING_DIM=1536 is the configured contract.
--
-- The model DOES also honour a `dimensions: 384` request (Matryoshka
-- truncation, verified live, HTTP 200 -> 384), so keeping 384 was technically
-- possible. It was rejected: truncation discards signal for no benefit here.
-- Both columns are 100% NULL (0 of 4395 tickets, 0 of 48 articles) and the
-- corpus is 120 rows, so the storage saving is a rounding error set against a
-- permanent recall cost.
--
-- Widening a column that has never held a value is not a data migration; the
-- guard below refuses to run if that ever stops being true.
--
-- ── WHY IN-ROW, AND NOT AN `embedding` TABLE ────────────────────────────
--
-- SECURITY, not convenience. `ticket` and `kb_article` already carry FORCE
-- ROW LEVEL SECURITY with tested policies — and kb_isolation additionally
-- hides drafts from non-staff. A vector stored in the row inherits both,
-- unavoidably, with no second policy to keep in sync. A side table would need
-- its own policy: a new place to get tenant isolation wrong, guarding data
-- from which the source text is substantially recoverable.

BEGIN;

-- ── Guard: this migration is only safe on empty vector columns ───────────
DO $guard$
DECLARE populated bigint;
BEGIN
  SELECT (SELECT count(*) FROM ticket     WHERE embedding IS NOT NULL)
       + (SELECT count(*) FROM kb_article WHERE embedding IS NOT NULL)
    INTO populated;
  IF populated > 0 THEN
    RAISE EXCEPTION
      'REFUSING TO RUN: % embedding value(s) already exist. Widening 384->1536 discards them. Re-embed deliberately rather than losing vectors silently.',
      populated;
  END IF;
END
$guard$;

-- ── The vectors ─────────────────────────────────────────────────────────
-- USING NULL is explicit rather than relying on an implicit
-- vector(384) -> vector(1536) cast, which pgvector does not provide. Safe only
-- because of the guard above.
ALTER TABLE ticket     ALTER COLUMN embedding TYPE vector(1536) USING NULL;
ALTER TABLE kb_article ALTER COLUMN embedding TYPE vector(1536) USING NULL;

COMMENT ON COLUMN ticket.embedding IS
  'Azure OpenAI text-embedding-3-small, 1536 dims, unit-norm as returned by the provider. NULL until embedded. Written only by core-service, after validation.';
COMMENT ON COLUMN kb_article.embedding IS
  'Azure OpenAI text-embedding-3-small, 1536 dims. NULL until embedded. Inherits kb_isolation, so a draft article vector is invisible to non-staff exactly as its text is.';

-- ── Provenance ──────────────────────────────────────────────────────────
ALTER TABLE ticket
  ADD COLUMN IF NOT EXISTS embedding_fingerprint text,
  ADD COLUMN IF NOT EXISTS embedding_model       text,
  ADD COLUMN IF NOT EXISTS embedded_at           timestamptz;

ALTER TABLE kb_article
  ADD COLUMN IF NOT EXISTS embedding_fingerprint text,
  ADD COLUMN IF NOT EXISTS embedding_model       text,
  ADD COLUMN IF NOT EXISTS embedded_at           timestamptz;

-- ── The content fingerprint — the whole idempotency mechanism ───────────
--
-- `embedding_content_sha` is GENERATED: Postgres derives it from the row's own
-- text and keeps it correct through every UPDATE, with no trigger and no
-- application code able to forget it.
--
-- `embedding_fingerprint` records the sha that was ACTUALLY embedded.
-- Therefore:
--
--     pending  <=>  embedding IS NULL
--                   OR embedding_fingerprint IS DISTINCT FROM embedding_content_sha
--
-- That one predicate is backfill AND incremental embedding AND edit
-- detection. Nothing dispatches embedding work; the query simply stops
-- returning a row once it is current. It is also why no event type was added:
-- `ticket.resolved` and `kb_article.published` would each need an outbox write
-- inside lifecycle code, and neither would notice a later edit.
--
-- The expression is IMMUTABLE — digest/encode/regexp_replace are all
-- volatility 'i', checked against this database rather than assumed — which is
-- what makes GENERATED ... STORED legal here.
--
-- Whitespace is normalised before hashing, so a reformat (a re-indent, a CRLF
-- change, a trailing newline) is not a paid re-embedding. Verified: two
-- spellings of one sentence hash identically.
--
-- ⚠️ THIS EXPRESSION IS THE CANONICAL TEXT FORMAT. It is defined here, once,
-- in the schema. TypeScript deliberately does NOT recompute it — it reads the
-- current value and writes it back. Two implementations of one hash drift, and
-- the failure mode is silent: permanent re-embedding of the whole corpus, on a
-- loop, billed per cycle.
--
-- The MODEL is deliberately NOT in the hash: this fingerprints CONTENT. A
-- model change is detected by comparing `embedding_model` against
-- configuration, which keeps a provider swap out of the schema.

ALTER TABLE ticket
  ADD COLUMN IF NOT EXISTS embedding_content_sha text
  GENERATED ALWAYS AS (
    encode(digest(
      regexp_replace(
        trim(coalesce(subject, '') || E'\n\n' || coalesce(description, '')),
        '\s+', ' ', 'g'),
      'sha256'), 'hex')
  ) STORED;

ALTER TABLE kb_article
  ADD COLUMN IF NOT EXISTS embedding_content_sha text
  GENERATED ALWAYS AS (
    encode(digest(
      regexp_replace(
        trim(coalesce(title, '') || E'\n\n' || coalesce(body, '')),
        '\s+', ' ', 'g'),
      'sha256'), 'hex')
  ) STORED;

-- ── Finding pending work cheaply ────────────────────────────────────────
--
-- PARTIAL indexes whose predicate is the corpus eligibility rule, so the index
-- holds only rows that are candidates at all — 72 of 4395 tickets. A plain
-- index on `status` would be mostly rows the corpus excludes.
--
-- `product_id` leads, as everywhere else here: RLS adds a predicate on it to
-- every query.
CREATE INDEX IF NOT EXISTS ticket_embedding_pending_idx
  ON ticket (product_id, updated_at)
  WHERE status IN ('resolved', 'closed');

CREATE INDEX IF NOT EXISTS kb_article_embedding_pending_idx
  ON kb_article (product_id, updated_at)
  WHERE status = 'published';

-- ── NO APPROXIMATE-NEAREST-NEIGHBOUR INDEX, DELIBERATELY ────────────────
--
-- The corpus is 120 rows (72 resolved/closed tickets, 48 published articles),
-- and one tenant's share is 12-48. An exact scan over 48 vectors costs a
-- fraction of a millisecond; HNSW would add build time, memory, and — the part
-- that matters — APPROXIMATION, trading recall away on a workload with no
-- speed problem to solve.
--
-- It is also actively harmful at this size UNDER RLS. An ANN index walks a
-- graph collecting `ef_search` candidates and the tenant predicate filters
-- them AFTERWARDS; when a tenant owns a small slice of the corpus, that
-- candidate set can be consumed by other tenants' rows and return FEWER than k
-- results, or none. Exact search cannot under-return.
--
-- WHEN TO REVISIT — measure, do not guess. Add HNSW once a single tenant's
-- eligible corpus passes roughly 10k vectors, or exact-search p95 exceeds
-- ~50ms:
--
--   CREATE INDEX ON ticket USING hnsw (embedding vector_cosine_ops)
--     WITH (m = 16, ef_construction = 64);
--
-- Note `vector_cosine_ops`: the opclass must match the operator the query uses
-- (`<=>`). An index built with a different one is silently ignored, which
-- presents as "the index did not help" rather than as a mistake.

COMMIT;

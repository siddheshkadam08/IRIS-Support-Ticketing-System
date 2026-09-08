-- 016 — Fix the canonical-text normalisation order
--
-- ⚠️ A REAL DEFECT IN 014, found by testing the property it claims rather than
-- by reading it.
--
-- 014 wrote:
--
--     regexp_replace(trim(...), '\s+', ' ', 'g')      -- trim, THEN collapse
--
-- and asserted that a reformat is not a paid re-embedding. It is not: Postgres
-- `trim(x)` is `btrim(x, ' ')` and strips SPACES ONLY. So text ending in
-- "\n\n  " has its trailing spaces removed, keeps the newlines, and the
-- collapse then turns those newlines into a TRAILING SPACE that the original
-- did not have. Different string, different sha, and the row is re-embedded
-- for a change that carries no meaning.
--
-- Observed directly: appending "\n\n  " to one resolved ticket changed
-- `embedding_content_sha`, which under 014's own pending predicate makes the
-- row pending and bills a provider call. The 014 probe missed it because both
-- probe strings happened to have no leading or trailing whitespace.
--
-- The fix is the order:
--
--     trim(regexp_replace(..., '\s+', ' ', 'g'))      -- collapse, THEN trim
--
-- Collapsing first turns every run of whitespace — spaces, tabs, newlines,
-- CRLF — into a single space, INCLUDING at the ends; trimming then removes
-- those. The result is genuinely invariant under reformatting, which is what
-- 014 claimed and this delivers.
--
-- ── COST ────────────────────────────────────────────────────────────────
--
-- SET EXPRESSION rewrites the table and recomputes the column. Every row whose
-- text has leading or trailing whitespace gets a new sha and therefore becomes
-- pending exactly once; the rest keep their sha and their vector. That is the
-- mechanism working — a canonical-form change SHOULD invalidate the vectors it
-- no longer describes.
--
-- Requires PostgreSQL 17 for ALTER COLUMN ... SET EXPRESSION (this database is
-- 17.10). On an older server the equivalent is DROP COLUMN + ADD COLUMN, which
-- has the same effect on a generated column since nothing is stored that is
-- not derived.

BEGIN;

ALTER TABLE ticket
  ALTER COLUMN embedding_content_sha
  SET EXPRESSION AS (
    encode(digest(
      trim(regexp_replace(
        coalesce(subject, '') || E'\n\n' || coalesce(description, ''),
        '\s+', ' ', 'g')),
      'sha256'), 'hex')
  );

ALTER TABLE kb_article
  ALTER COLUMN embedding_content_sha
  SET EXPRESSION AS (
    encode(digest(
      trim(regexp_replace(
        coalesce(title, '') || E'\n\n' || coalesce(body, ''),
        '\s+', ' ', 'g')),
      'sha256'), 'hex')
  );

COMMIT;

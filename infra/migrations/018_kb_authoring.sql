-- 018 — Knowledge base authoring and lifecycle
--
-- Phase 18. Makes `kb_article` writable by the application for the first time,
-- adds the third lifecycle state, and narrows an UPDATE grant that was wider
-- than the comment above it claimed.
--
-- NO NEW COLUMNS. NO NEW TABLE. NO NEW POLICY. NO NEW INDEX.
--
-- ── WHY THIS MIGRATION HAS TO EXIST AT ALL ──────────────────────────────
--
-- 006 revoked INSERT on `kb_article` from `iris_app`, and that was correct at
-- the time: the only writer was the seed, which opens its own connection on
-- ADMIN_DATABASE_URL and says so in its header. There was no authoring path,
-- so INSERT was privilege nobody needed.
--
-- There is one now. Verified against the live database before writing this:
--
--   has_table_privilege('iris_app','kb_article','INSERT')  -> false
--   has_table_privilege('iris_app','kb_article','UPDATE')  -> true
--   has_table_privilege('iris_app','kb_article','DELETE')  -> false
--
-- So creating an article fails at the database, and this grant is the whole
-- reason a migration was unavoidable. Precedent: 007 re-granted INSERT on
-- `product` for exactly this reason when tenant creation was built.
--
-- ── WHY DELETE STAYS REVOKED ────────────────────────────────────────────
--
-- An article can be cited by a grounded answer that has already been shown to
-- a customer, and by an agent copilot draft. Deleting the row orphans those
-- citations with nothing to point at and no record of what was removed.
-- `archived` is the delete: it withdraws the article from every consumer while
-- keeping the text the citation referred to. DELETE is not granted here and
-- must not be granted later without answering what happens to the citations.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Creation
-- ─────────────────────────────────────────────────────────────────────────
GRANT INSERT ON kb_article TO iris_app;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The UPDATE grant, narrowed to the columns that actually have a writer
-- ─────────────────────────────────────────────────────────────────────────
--
-- ⚠️ 006 DID NOT DO WHAT ITS COMMENT SAYS.
--
-- Line 6 of 006 granted UPDATE on ALL TABLES. Line 24 then added a column
-- grant on (views, helpful_yes, helpful_no) with the comment "the only columns
-- the runtime bumps", and line 25 revoked INSERT and DELETE. It never revoked
-- the table-wide UPDATE, so the column grant added nothing and `iris_app` has
-- held UPDATE on every column since — including `product_id`.
--
-- That was latent while no code path issued an UPDATE against those columns.
-- It stops being latent the moment an authoring PATCH exists: a bug or an
-- injected column list could move an article between tenants. RLS WITH CHECK
-- blocks a move OUT of the caller scope, but a product_admin holding two
-- tenants is not blocked from moving a row between their own two.
--
-- The fix is least privilege at the database, so the guarantee does not depend
-- on the route remembering to omit a column from its SET clause.
--
-- REVOKE at table level first. Postgres treats table-level and column-level
-- grants as separate, so the column grant from 006 line 24 survives this and
-- is re-stated below anyway — the list is written out in full so that reading
-- this file tells you the complete privilege, rather than this file plus 006.
REVOKE UPDATE ON kb_article FROM iris_app;

-- Belt and braces: no-ops today, and they stay correct if some future path
-- ever grants one of these by accident.
REVOKE UPDATE (id, product_id, created_at, is_public) ON kb_article FROM iris_app;

-- ⚠️ THIS LIST IS EXHAUSTIVE AND WAS DERIVED FROM THE CODE, NOT FROM MEMORY.
-- Every `UPDATE kb_article` statement in the repository, and the columns it
-- sets:
--
--   knowledge-base/kb.repo.ts     getArticle       views
--   knowledge-base/kb.repo.ts     voteHelpful      helpful_yes, helpful_no
--   embeddings/embedding.repo     applyEmbedding   embedding, embedding_fingerprint,
--                                                  embedding_model, embedded_at
--   embeddings/embedding.repo     recordPermanent  embedding_error, embedding_fingerprint
--   knowledge-base/kb.admin.repo  updateText       title, body, category, updated_at
--   knowledge-base/kb.admin.repo  updateStatus     status, updated_at
--
-- Anything not on this list has no writer. If a future phase adds one, it adds
-- a grant here in the same migration — a failing UPDATE is a loud, immediate
-- error, which is the point.
GRANT UPDATE (
  title, body, category, status, updated_at,
  views, helpful_yes, helpful_no,
  embedding, embedding_fingerprint, embedding_model, embedded_at,
  embedding_error
) ON kb_article TO iris_app;

-- ⚠️ NOT GRANTED, DELIBERATELY:
--
--   id, product_id, created_at   identity and tenancy. The tenant of a row is
--                                not an editable field; changing it is a
--                                cross-tenant move dressed as an update.
--   is_public                    the audience axis. A published article with
--                                is_public = false is excluded from KB_CORPUS
--                                and from the embedding corpus, so it would
--                                participate in nothing while looking live.
--                                Staff-only articles are a deferred design
--                                question, not a checkbox.
--   search_tsv                   GENERATED ALWAYS. Not writable regardless;
--   embedding_content_sha        listed so nobody tries.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The third lifecycle state
-- ─────────────────────────────────────────────────────────────────────────
--
-- `archived` behaves exactly like `draft` for every consumer: kb_isolation
-- shows it to staff only, KB_CORPUS excludes it from all three retrieval
-- strategies, and the embedding corpus predicate (status = 'published') stops
-- offering it. So NO POLICY, NO CORPUS PREDICATE AND NO INDEX NEEDS TOUCHING —
-- every one of them already tests for 'published' positively rather than for
-- 'draft' negatively, which is why a third state costs nothing here.
--
-- ⚠️ CONFIRM THAT BEFORE ADDING A FOURTH. A predicate written as
-- `status <> 'draft'` anywhere would have silently admitted archived articles
-- into the corpus. None exists today; this was checked, not assumed:
--
--   kb_isolation                      status = 'published' AND is_public = true
--   KB_CORPUS (hybrid.repo.ts)        k.status = 'published' AND k.is_public
--   selectPending (embedding.repo)    k.status = 'published' AND k.is_public
--   searchSimilarArticles             k.status = 'published'
--   kb_article_embedding_pending_idx  WHERE status = 'published'
--
-- WHY ARCHIVED IS A STATE AND NOT "MOVE IT BACK TO DRAFT". The two mean
-- different things and the difference is not recoverable after the fact. A
-- draft is on its way in; an archive is on its way out. Retiring articles by
-- returning them to draft means that in six months nobody can tell abandoned
-- work from a decommissioned answer, and there is no column that would say.
ALTER TABLE kb_article DROP CONSTRAINT IF EXISTS kb_article_status_check;
ALTER TABLE kb_article
  ADD CONSTRAINT kb_article_status_check
  CHECK (status IN ('draft', 'published', 'archived'));

COMMENT ON COLUMN kb_article.status IS
  'draft: staff-only, being written. published: live, in KB_CORPUS and in the embedding corpus when is_public. archived: staff-only, deliberately retired. Legal transitions live in shared/types/kb.ts; archived cannot go directly to published.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. What is deliberately NOT here
-- ─────────────────────────────────────────────────────────────────────────
--
-- published_at, published_by, archived_at, archived_by.
--
-- Every one of those four facts is already recorded, for every transition, by
-- `audit_event`: the actor, the timestamp, the before state, the after state,
-- the request id and the source ip — on a table with UPDATE and DELETE revoked
-- from `iris_app`, so the application cannot rewrite it. Adding columns would
-- create a second source of truth for the same fact, and the two can drift
-- while both look authoritative.
--
-- The honest cost: ordering the article list by publication date is not
-- cheaply answerable from audit, so the admin list orders by `updated_at DESC`
-- instead. That is what an editor wants anyway. If a screen ever genuinely
-- needs publication ordering, `published_at` can be added then AND backfilled
-- from the audit trail, which is exactly why deferring it loses nothing.

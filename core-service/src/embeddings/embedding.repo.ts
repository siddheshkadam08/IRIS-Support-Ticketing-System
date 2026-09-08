import {
  EMBEDDING_MAX_CHARS,
  type EmbeddingSubjectType,
  type EmbeddingWorkItem,
  toVectorLiteral,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * Embedding persistence and vector retrieval — Phase 10.
 *
 * TWO TABLES, ONE SHAPE. `ticket` and `kb_article` differ only in which
 * columns hold the text and which rows are eligible. Rather than a generic
 * helper that builds SQL from a config object, each statement is written out
 * per subject type and selected by a literal branch on a union-typed value —
 * so the table name is never data. Dynamic SQL assembled from a table name is
 * exactly how an injection or a missing tenant predicate gets in, and the
 * duplication it avoids here is four lines.
 *
 * ⚠️ THE CORPUS DEFINITION LIVES IN THESE PREDICATES.
 *
 *   tickets      status IN ('resolved','closed')          — 72 rows
 *   kb_articles  status = 'published' AND is_public = true  — 48 rows
 *
 * Both are drawn from what the database actually contains; nothing was
 * generated to reach a target size. An OPEN ticket is deliberately excluded:
 * it has no outcome yet, so surfacing it as a "similar resolved issue" would
 * be offering a question as an answer. A DRAFT article is excluded because
 * kb_isolation already hides it from the people retrieval serves.
 *
 * ⚠️ `is_public = true` IS LOAD-BEARING, not decoration. Writes run under
 * role 'none' — the same system-actor role every other AI write uses — and
 * kb_isolation makes a non-public article invisible to that role. Embedding a
 * row the writer cannot see would fail forever, silently, once per cycle,
 * billing a provider call each time. All 48 published articles are currently
 * public, so this excludes nothing that exists; if staff-only articles are
 * ever added, embedding them is a deliberate extension that has to answer
 * "which retrieval surfaces may see them?" rather than something that should
 * happen by accident.
 */

// ─────────────────────────────────────────────────────────────────────────
// Pending work
// ─────────────────────────────────────────────────────────────────────────

/**
 * `embedding_content_sha` is the GENERATED column from migration 014.
 *
 * Postgres recomputes it on every UPDATE, so "has this text changed since we
 * embedded it?" is answered by the database rather than by a trigger, an event
 * or a timestamp comparison. `embedded_at < updated_at` was the obvious
 * alternative and is wrong: `ticket.updated_at` moves on status changes and
 * assignment, which would re-embed identical text and bill for it.
 *
 * The model check is separate and comes from configuration, not the schema:
 * vectors from two models are not comparable, so a model swap must invalidate
 * the corpus — but which model is current is an operational choice that has no
 * business being frozen into a generated column.
 */
const pendingPredicate = (a: string) => `(
    (
       ${a}.embedding IS NULL
    OR ${a}.embedding_fingerprint IS DISTINCT FROM ${a}.embedding_content_sha
    OR ${a}.embedding_model IS DISTINCT FROM $1
    )
    /**
     * ...unless this exact content already failed permanently (015).
     *
     * Matching on the FINGERPRINT and not merely on "an error is set" is what
     * makes this self-clearing: edit the text and embedding_content_sha
     * changes, the equality breaks, and the row is pending again. No operator
     * action, no separate retry queue, no expiry to tune.
     */
    AND NOT (
       ${a}.embedding_error IS NOT NULL
      AND ${a}.embedding_fingerprint = ${a}.embedding_content_sha
    )
)`;

/**
 * Truncation happens HERE, in SQL, and nowhere else.
 *
 * ⚠️ THE ORDER IS collapse-THEN-trim, matching migration 016 exactly. Postgres
 * `trim()` strips SPACES ONLY, so trimming first leaves newlines that the
 * collapse then turns into a trailing space — which is how 014 shipped, and is
 * how a mere reformat became a paid re-embedding. These two constants and the
 * generated column must always spell the same normalisation: if they diverge,
 * the text that gets embedded is not the text that was fingerprinted, and
 * nothing anywhere would report it.
 *
 * The fingerprint is computed over the FULL text while the vector is built
 * from the truncated text, which is deliberate: two tickets sharing an
 * 8000-character prefix but differing later are genuinely one embedding, and
 * fingerprinting the prefix would make an edit past character 8000 invisible.
 * Fingerprinting the whole thing means such an edit re-embeds, which is
 * correct even though the resulting vector may be identical.
 */
const TICKET_TEXT = `left(trim(regexp_replace(coalesce(t.subject,'') || E'\\n\\n' || coalesce(t.description,''), '\\s+', ' ', 'g')), ${EMBEDDING_MAX_CHARS})`;
const KB_TEXT = `left(trim(regexp_replace(coalesce(k.title,'') || E'\\n\\n' || coalesce(k.body,''), '\\s+', ' ', 'g')), ${EMBEDDING_MAX_CHARS})`;

/**
 * Items still needing an embedding, oldest-updated first.
 *
 * ⚠️ RUNS UNDER withSystemScope, because it is a platform maintenance sweep
 * across every tenant — the same justification, and the same narrow use, as
 * the reaper's resolve step. Two properties keep that safe:
 *
 *   1. The returned item carries NO product_id, tenant id, reference or raiser
 *      identity. The worker is a courier; it cannot attribute the text it
 *      carries to a tenant, so it cannot mix two of them up.
 *   2. Every WRITE is re-scoped to the row's own product (see applyEmbedding),
 *      so nothing that follows runs with platform-wide visibility.
 *
 * `ORDER BY updated_at` rather than by id: the oldest un-embedded item is the
 * one a retrieval query is most likely to want, and it makes an interrupted
 * backfill resume where it stopped instead of restarting.
 */
export async function selectPending(
  tx: Tx,
  args: { model: string; limit: number },
): Promise<EmbeddingWorkItem[]> {
  const { rows } = await tx.query<{
    subject_type: EmbeddingSubjectType;
    subject_id: string;
    text: string;
    fingerprint: string;
  }>(
    `(SELECT 'ticket'::text          AS subject_type,
             t.id                    AS subject_id,
             ${TICKET_TEXT}          AS text,
             t.embedding_content_sha AS fingerprint,
             t.updated_at            AS updated_at
        FROM ticket t
       WHERE t.status IN ('resolved','closed')
         AND ${pendingPredicate('t')})
     UNION ALL
     (SELECT 'kb_article'::text,
             k.id,
             ${KB_TEXT},
             k.embedding_content_sha,
             k.updated_at
        FROM kb_article k
       WHERE k.status = 'published' AND k.is_public = true
         AND ${pendingPredicate('k')})
     ORDER BY updated_at ASC
     LIMIT $2`,
    [args.model, args.limit],
  );

  // `text` can still be empty if a row holds nothing but whitespace. Dropping
  // it here rather than sending it means the provider is never asked to embed
  // nothing — and the row simply stays pending, visibly, instead of acquiring
  // a meaningless vector that would make it look done.
  return rows
    .filter((r) => r.text.trim().length > 0)
    .map((r) => ({
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      text: r.text,
      fingerprint: r.fingerprint,
    }));
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────

/**
 * Write one validated vector, guarded by the fingerprint it was computed from.
 *
 * ⚠️ `AND embedding_content_sha = $2` IS THE WHOLE RACE FIX.
 *
 * An item is read, sent to Azure, and comes back roughly a second later. If
 * the ticket was edited in that window, its `embedding_content_sha` has
 * already changed, this UPDATE matches zero rows, and the item stays pending
 * for the next cycle. Without the guard the row would be stamped with the new
 * fingerprint while holding a vector of the OLD text — and because the
 * fingerprint would then match, nothing would ever revisit it. A stale vector
 * that looks current is strictly worse than a missing one.
 *
 * Returns false when the guard bites. That is a normal outcome, not an error.
 */
export async function applyEmbedding(
  tx: Tx,
  args: {
    subjectType: EmbeddingSubjectType;
    subjectId: string;
    productId: string;
    fingerprint: string;
    vector: number[];
    model: string;
  },
): Promise<boolean> {
  // Bound parameter with an explicit cast — never string interpolation into
  // the statement. pgvector parses the '[1,2,...]' text form.
  const literal = toVectorLiteral(args.vector);

  /**
   * `AND product_id = $5` sits alongside RLS rather than instead of it.
   *
   * RLS is the enforcement point and is not being second-guessed. The explicit
   * predicate makes the tenant constraint visible in the statement itself, so
   * a reader can see the isolation without also holding 005_rls.sql in their
   * head — and so a future refactor that changed the scope would produce a
   * failing write rather than a silent cross-tenant one.
   */
  const sql =
    args.subjectType === 'ticket'
      ? `UPDATE ticket
            SET embedding             = $3::vector,
                embedding_fingerprint = $2,
                embedding_model       = $4,
                embedded_at           = now()
          WHERE id = $1
            AND product_id = $5
            AND embedding_content_sha = $2`
      : `UPDATE kb_article
            SET embedding             = $3::vector,
                embedding_fingerprint = $2,
                embedding_model       = $4,
                embedded_at           = now()
          WHERE id = $1
            AND product_id = $5
            AND embedding_content_sha = $2`;

  const { rowCount } = await tx.query(sql, [
    args.subjectId,
    args.fingerprint,
    literal,
    args.model,
    args.productId,
  ]);
  return (rowCount ?? 0) > 0;
}

/**
 * Which product owns a subject. Used to narrow from system scope to that
 * product's scope before writing, mirroring the reaper.
 *
 * Returns null for an id that does not exist — including one invented by a
 * caller. The worker only ever echoes ids Core handed it, but a repo function
 * that trusts its input is one refactor away from being called by something
 * that does not.
 */
export async function resolveOwner(
  tx: Tx,
  subjectType: EmbeddingSubjectType,
  subjectId: string,
): Promise<string | null> {
  const sql =
    subjectType === 'ticket'
      ? `SELECT product_id FROM ticket WHERE id = $1`
      : `SELECT product_id FROM kb_article WHERE id = $1`;
  const { rows } = await tx.query<{ product_id: string }>(sql, [subjectId]);
  return rows[0]?.product_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Retrieval
// ─────────────────────────────────────────────────────────────────────────

export interface VectorHit {
  id: string;
  title: string;
  body: string;
  /** Cosine SIMILARITY in [0,1]: 1 - (a <=> b). Higher is closer. */
  similarity: number;
}

/**
 * COSINE distance (`<=>`), chosen and not defaulted.
 *
 * `text-embedding-3-small` returns unit-norm vectors, so cosine and inner
 * product rank identically — but cosine yields a bounded [0,2] distance, which
 * maps to a [0,1] similarity a human can reason about and a threshold can be
 * set against. L2 on unit vectors is a monotone function of cosine and would
 * rank the same while producing a number nobody can interpret.
 *
 * ⚠️ THE TENANT PREDICATE IS INSIDE THE QUERY, before ORDER BY and LIMIT.
 *
 * `product_id = $2` sits alongside the RLS policy rather than in place of it,
 * and this is the one place where belt-and-braces genuinely earns its cost.
 * `ORDER BY embedding <=> $1 LIMIT k` is evaluated AFTER filtering, so a
 * predicate applied by the caller — filtering the k rows that came back —
 * would silently return fewer than k, or none, while looking like a working
 * search. Isolation must constrain what is ranked, not what is displayed.
 *
 * `embedding IS NOT NULL` is required rather than cosmetic: a NULL vector
 * makes `<=>` return NULL, and NULL sorts LAST under ASC, so un-embedded rows
 * would silently pad the tail of every result set.
 */
export async function searchSimilarTickets(
  tx: Tx,
  args: { vector: number[]; productId: string; limit: number; excludeId?: string | null },
): Promise<VectorHit[]> {
  const { rows } = await tx.query<VectorHit>(
    `SELECT t.id,
            coalesce(t.subject, t.reference) AS title,
            t.description                    AS body,
            1 - (t.embedding <=> $1::vector) AS similarity
       FROM ticket t
      WHERE t.product_id = $2
        AND t.status IN ('resolved','closed')
        AND t.embedding IS NOT NULL
        AND ($4::text IS NULL OR t.id <> $4)
      ORDER BY t.embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(args.vector), args.productId, args.limit, args.excludeId ?? null],
  );
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

export async function searchSimilarArticles(
  tx: Tx,
  args: { vector: number[]; productId: string; limit: number },
): Promise<VectorHit[]> {
  const { rows } = await tx.query<VectorHit>(
    `SELECT k.id,
            k.title,
            k.body,
            1 - (k.embedding <=> $1::vector) AS similarity
       FROM kb_article k
      WHERE k.product_id = $2
        AND k.status = 'published'
        AND k.embedding IS NOT NULL
      ORDER BY k.embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(args.vector), args.productId, args.limit],
  );
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

/** Corpus coverage, for the operational view and for the backfill report. */
export async function embeddingStats(
  tx: Tx,
  model: string,
): Promise<
  Array<{
    subject_type: string;
    eligible: number;
    embedded: number;
    pending: number;
    failed: number;
  }>
> {
  const { rows } = await tx.query(
    `SELECT 'ticket' AS subject_type,
            count(*)                                                          AS eligible,
            count(*) FILTER (WHERE embedding IS NOT NULL)                     AS embedded,
            count(*) FILTER (WHERE embedding IS NULL
                                OR embedding_fingerprint IS DISTINCT FROM embedding_content_sha
                                OR embedding_model IS DISTINCT FROM $1)       AS pending,
            count(*) FILTER (WHERE embedding_error IS NOT NULL)                AS failed
       FROM ticket WHERE status IN ('resolved','closed')
      UNION ALL
     SELECT 'kb_article',
            count(*),
            count(*) FILTER (WHERE embedding IS NOT NULL),
            count(*) FILTER (WHERE embedding IS NULL
                                OR embedding_fingerprint IS DISTINCT FROM embedding_content_sha
                                OR embedding_model IS DISTINCT FROM $1),
            count(*) FILTER (WHERE embedding_error IS NOT NULL)
       FROM kb_article WHERE status = 'published' AND is_public = true`,
    [model],
  );
  return rows.map((r) => ({
    subject_type: String(r.subject_type),
    eligible: Number(r.eligible),
    embedded: Number(r.embedded),
    pending: Number(r.pending),
    failed: Number(r.failed),
  }));
}

/**
 * Quarantine one item after a PERMANENT provider failure (migration 015).
 *
 * Stamps the code together with the fingerprint of the text that caused it, so
 * `pendingPredicate` stops offering the row until its text changes. This is
 * not a retry mechanism and must never become one — it is the absence of a
 * retry, made durable across restarts.
 *
 * `embedding` is left untouched: a row that previously had a good vector and
 * now fails on edited text keeps the old vector rather than losing retrieval
 * entirely. That is the better failure — slightly stale beats absent — and it
 * is visible, because `embedding_error` is set and the operational view counts
 * it.
 */
export async function recordPermanentFailure(
  tx: Tx,
  args: {
    subjectType: EmbeddingSubjectType;
    subjectId: string;
    productId: string;
    fingerprint: string;
    code: string;
  },
): Promise<boolean> {
  const sql =
    args.subjectType === 'ticket'
      ? `UPDATE ticket
            SET embedding_error       = $3,
                embedding_fingerprint = $2
          WHERE id = $1
            AND product_id = $4
            AND embedding_content_sha = $2`
      : `UPDATE kb_article
            SET embedding_error       = $3,
                embedding_fingerprint = $2
          WHERE id = $1
            AND product_id = $4
            AND embedding_content_sha = $2`;

  const { rowCount } = await tx.query(sql, [
    args.subjectId,
    args.fingerprint,
    // The stable CODE only. Never provider prose, which can quote the input
    // and would put ticket text into a column read by operational queries.
    args.code.slice(0, 80),
    args.productId,
  ]);
  return (rowCount ?? 0) > 0;
}

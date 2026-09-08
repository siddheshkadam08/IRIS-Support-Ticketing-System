import {
  CANDIDATES_PER_STRATEGY,
  TRIGRAM_SIMILARITY_FLOOR,
  VECTOR_SIMILARITY_FLOOR,
  toVectorLiteral,
  type RetrievalSource,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * Candidate generation for hybrid retrieval — Phase 11.
 *
 * One function per (strategy x source), each returning an ORDERED, BOUNDED
 * candidate list. Fusion happens in hybrid.service.ts; nothing here knows about
 * scoring, weights or other strategies.
 *
 * ⚠️ EVERY QUERY CARRIES `product_id = $n` EXPLICITLY, alongside RLS.
 *
 * RLS is the enforcement point and is not being second-guessed. The explicit
 * predicate does two further things that matter here specifically:
 *
 *   1. It makes the tenant constraint visible in the statement, so a reader can
 *      see the isolation without holding 005_rls.sql in their head.
 *   2. It sits INSIDE the ranked query, before ORDER BY and LIMIT. Filtering
 *      the k rows that came back would silently return fewer than k — or none —
 *      while looking like a working search. This corpus makes that failure mode
 *      concrete: the same 12 articles exist in all four products with identical
 *      text and therefore identical vectors, so an unscoped ranking would place
 *      four indistinguishable rows at the top and a post-filter would keep one
 *      by luck.
 *
 * ⚠️ THE QUERY TEXT IS ALWAYS A BOUND PARAMETER. It is never interpolated,
 * never concatenated, and never used to build SQL. `websearch_to_tsquery` is
 * chosen over `to_tsquery` partly for this: it parses user input as a phrase
 * language and cannot raise a syntax error on stray quotes, colons, ampersands
 * or parentheses, so a malformed query returns no rows instead of a 500 that
 * leaks a parser message.
 */

export interface Candidate {
  source_type: RetrievalSource;
  source_id: string;
  title: string;
  snippet: string;
  /**
   * THE SCORE THIS STRATEGY GAVE THE ROW — ts_rank, trigram similarity or
   * cosine similarity, depending on which function produced it.
   *
   * It is ONLY ever compared within one strategy, never against another
   * strategy's score. The three scales are not commensurable, which is the
   * entire reason fusion is rank-based. This exists so the two SOURCE lists a
   * strategy produces (tickets and articles) can be interleaved into one
   * correctly ordered ranking before ranks are assigned.
   *
   * WITHOUT IT THERE IS A SILENT BIAS. Concatenating tickets then articles
   * gives every ticket a better rank than every article whatever their scores,
   * so RRF fuses a ranking the strategy never produced. Observed live before
   * the fix: a KB article at cosine similarity 1.0 - a perfect match - was
   * assigned vector rank 3, because two tickets had been concatenated ahead of
   * it.
   */
  score: number;
  /** Cosine similarity in [0,1]. Populated by the vector strategy only. */
  similarity?: number;
}

/**
 * The corpus, in one place.
 *
 * ⚠️ TICKETS MUST HAVE A RESOLUTION. `searchResolvedTickets` has always
 * required a public assignee comment and then filtered on it in JavaScript
 * AFTER the query — which silently returned fewer rows than the caller asked
 * for. Phase 10 embedded all 74 resolved/closed tickets, so a vector search
 * would surface the 26 that have no resolution comment: a ticket describing a
 * problem with no recorded answer, offered to a user as the answer.
 *
 * The rule moves INTO the predicate, so all three strategies see one corpus and
 * `LIMIT` means what it says. This narrows the searchable ticket set from 74 to
 * 48 and is the correct narrowing — it is the existing business rule, applied
 * consistently for the first time.
 *
 * Open tickets are excluded for the same reason: an unresolved problem is not
 * an answer to anyone's question.
 */
const TICKET_CORPUS = `
      t.product_id = $1
  AND t.status IN ('resolved','closed')
  AND EXISTS (
        SELECT 1 FROM comment c
         WHERE c.ticket_id = t.id
           AND c.is_internal = false
           AND c.author_type = 'assignee')`;

/**
 * Published AND public, matching the Phase 10 embedding corpus exactly.
 *
 * If these two ever disagree, rows are embedded that can never be retrieved or
 * retrieved that were never embedded — and neither shows up as an error.
 */
const KB_CORPUS = `
      k.product_id = $1
  AND k.status = 'published'
  AND k.is_public = true`;

/** The resolution comment, which is what makes a ticket useful as an answer. */
const TICKET_RESOLUTION = `
  (SELECT c.body FROM comment c
    WHERE c.ticket_id = t.id AND c.is_internal = false AND c.author_type = 'assignee'
    ORDER BY c.created_at DESC LIMIT 1)`;

function excerpt(body: string | null, max = 180): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ─────────────────────────────────────────────────────────────────────────
// Full-text search
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reuses the EXISTING generated `search_tsv` columns and their GIN indexes
 * (`ticket_search_idx`, `kb_search_idx`) unchanged. No new tsvector, no new
 * index, no re-indexing.
 *
 * `kb_article.search_tsv` already weights title 'A' over body 'B', so a title
 * match already outranks a body mention — that weighting is inherited, not
 * reinvented.
 */
export async function ftsTickets(
  tx: Tx,
  args: { productId: string; query: string; limit?: number },
): Promise<Candidate[]> {
  const { rows } = await tx.query<{
    id: string;
    title: string;
    resolution: string | null;
    score: string;
  }>(
    `SELECT t.id,
            coalesce(t.subject, t.reference) AS title,
            ${TICKET_RESOLUTION}             AS resolution,
            ts_rank(t.search_tsv, websearch_to_tsquery('english', $2)) AS score
       FROM ticket t
      WHERE ${TICKET_CORPUS}
        AND t.search_tsv @@ websearch_to_tsquery('english', $2)
      ORDER BY score DESC, t.id
      LIMIT $3`,
    [args.productId, args.query, args.limit ?? CANDIDATES_PER_STRATEGY],
  );
  return rows.map((r) => ({
    source_type: 'resolved_ticket' as const,
    source_id: r.id,
    title: r.title,
    snippet: excerpt(r.resolution),
    score: Number(r.score),
  }));
}

export async function ftsArticles(
  tx: Tx,
  args: { productId: string; query: string; limit?: number },
): Promise<Candidate[]> {
  const { rows } = await tx.query<{ id: string; title: string; body: string; score: string }>(
    `SELECT k.id, k.title, k.body,
            ts_rank(k.search_tsv, websearch_to_tsquery('english', $2)) AS score
       FROM kb_article k
      WHERE ${KB_CORPUS}
        AND k.search_tsv @@ websearch_to_tsquery('english', $2)
      ORDER BY score DESC, k.id
      LIMIT $3`,
    [args.productId, args.query, args.limit ?? CANDIDATES_PER_STRATEGY],
  );
  return rows.map((r) => ({
    source_type: 'kb_article' as const,
    source_id: r.id,
    title: r.title,
    snippet: excerpt(r.body),
    score: Number(r.score),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Trigram
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ TRIGRAM RUNS ON THE TITLE/SUBJECT ONLY, and that is a deliberate limit.
 *
 * `similarity(a, b)` compares whole strings, so its value falls as the second
 * string grows. Against a 2000-character article body, a three-word query
 * scores near zero however well it matches — trigram over a body measures
 * length far more than relevance. Applied to a short title it does the one job
 * it is here for: surviving a misspelling that FTS's stemmer cannot.
 *
 * `kb_title_trgm_idx` (GIN, gin_trgm_ops) already exists for articles. There is
 * no equivalent on `ticket.subject`, and measurement showed none is needed —
 * see the query-plan findings in the phase report.
 *
 * The floor is TRIGRAM_SIMILARITY_FLOOR, which Phase 11 raised to 0.20 after
 * end-to-end testing found 0.15 matching "passport" to "password". The
 * measurement behind the value is recorded with the constant.
 */
export async function trigramTickets(
  tx: Tx,
  args: { productId: string; query: string; limit?: number },
): Promise<Candidate[]> {
  const { rows } = await tx.query<{
    id: string;
    title: string;
    resolution: string | null;
    score: string;
  }>(
    `SELECT t.id,
            coalesce(t.subject, t.reference)                  AS title,
            ${TICKET_RESOLUTION}                              AS resolution,
            similarity(coalesce(t.subject, t.reference), $2)  AS score
       FROM ticket t
      WHERE ${TICKET_CORPUS}
        AND similarity(coalesce(t.subject, t.reference), $2) > $4
      ORDER BY score DESC, t.id
      LIMIT $3`,
    [args.productId, args.query, args.limit ?? CANDIDATES_PER_STRATEGY, TRIGRAM_SIMILARITY_FLOOR],
  );
  return rows.map((r) => ({
    source_type: 'resolved_ticket' as const,
    source_id: r.id,
    title: r.title,
    snippet: excerpt(r.resolution),
    score: Number(r.score),
  }));
}

export async function trigramArticles(
  tx: Tx,
  args: { productId: string; query: string; limit?: number },
): Promise<Candidate[]> {
  const { rows } = await tx.query<{ id: string; title: string; body: string; score: string }>(
    `SELECT k.id, k.title, k.body,
            similarity(k.title, $2) AS score
       FROM kb_article k
      WHERE ${KB_CORPUS}
        AND similarity(k.title, $2) > $4
      ORDER BY score DESC, k.id
      LIMIT $3`,
    [args.productId, args.query, args.limit ?? CANDIDATES_PER_STRATEGY, TRIGRAM_SIMILARITY_FLOOR],
  );
  return rows.map((r) => ({
    source_type: 'kb_article' as const,
    source_id: r.id,
    title: r.title,
    snippet: excerpt(r.body),
    score: Number(r.score),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Vector
// ─────────────────────────────────────────────────────────────────────────

/**
 * Phase 10's retrieval, with a similarity FLOOR added.
 *
 * The floor is what makes vector search safe to add to a deflection path. See
 * VECTOR_SIMILARITY_FLOOR for the measurement behind the value — without it,
 * `ORDER BY ... LIMIT k` returns k rows for any query at all, and an
 * unanswerable question would stop offering the ticket form.
 *
 * `embedding IS NOT NULL` is required rather than cosmetic: `<=>` against NULL
 * is NULL, and NULL sorts LAST under ASC, so un-embedded rows would silently
 * pad the tail of every result set.
 */
export async function vectorTickets(
  tx: Tx,
  args: { productId: string; vector: number[]; limit?: number; floor?: number },
): Promise<Candidate[]> {
  const { rows } = await tx.query<{
    id: string;
    title: string;
    resolution: string | null;
    similarity: string;
  }>(
    `SELECT t.id,
            coalesce(t.subject, t.reference)  AS title,
            ${TICKET_RESOLUTION}              AS resolution,
            1 - (t.embedding <=> $2::vector)  AS similarity
       FROM ticket t
      WHERE ${TICKET_CORPUS}
        AND t.embedding IS NOT NULL
        AND 1 - (t.embedding <=> $2::vector) >= $4
      ORDER BY t.embedding <=> $2::vector, t.id
      LIMIT $3`,
    [
      args.productId,
      toVectorLiteral(args.vector),
      args.limit ?? CANDIDATES_PER_STRATEGY,
      args.floor ?? VECTOR_SIMILARITY_FLOOR,
    ],
  );
  return rows.map((r) => ({
    source_type: 'resolved_ticket' as const,
    source_id: r.id,
    title: r.title,
    snippet: excerpt(r.resolution),
    score: Number(r.similarity),
    similarity: Number(r.similarity),
  }));
}

export async function vectorArticles(
  tx: Tx,
  args: { productId: string; vector: number[]; limit?: number; floor?: number },
): Promise<Candidate[]> {
  const { rows } = await tx.query<{
    id: string;
    title: string;
    body: string;
    similarity: string;
  }>(
    `SELECT k.id, k.title, k.body,
            1 - (k.embedding <=> $2::vector) AS similarity
       FROM kb_article k
      WHERE ${KB_CORPUS}
        AND k.embedding IS NOT NULL
        AND 1 - (k.embedding <=> $2::vector) >= $4
      ORDER BY k.embedding <=> $2::vector, k.id
      LIMIT $3`,
    [
      args.productId,
      toVectorLiteral(args.vector),
      args.limit ?? CANDIDATES_PER_STRATEGY,
      args.floor ?? VECTOR_SIMILARITY_FLOOR,
    ],
  );
  return rows.map((r) => ({
    source_type: 'kb_article' as const,
    source_id: r.id,
    title: r.title,
    snippet: excerpt(r.body),
    score: Number(r.similarity),
    similarity: Number(r.similarity),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Exact identifier
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ THE GAP THIS CLOSES IS REAL, AND WAS MEASURED.
 *
 * `ticket.search_tsv` is generated from `subject || ' ' || description`. It does
 * NOT include `reference`. So `websearch_to_tsquery('english', 'CARB-5147')`
 * becomes `'carb' <-> '-5147'` and matches NOTHING — verified live against the
 * running database, on a reference that exists. Searching for a ticket by its
 * own identifier has never worked in IRIS.
 *
 * The fix is a LOOKUP, not a ranking adjustment. `UNIQUE (product_id,
 * reference)` already indexes this exactly, the match is either right or absent,
 * and no similarity score can be more certain than an equality on a unique key.
 * A pinned lookup is therefore honest where a boosted weight would be a magic
 * number chosen to win.
 *
 * Case-insensitive because users type `carb-5147`; still a bound parameter, and
 * still constrained by product scope and by the same corpus rule as every other
 * path — an exact reference to a ticket with no resolution is not surfaced as
 * an answer merely because it was named precisely.
 */
export async function exactTicketByReference(
  tx: Tx,
  args: { productId: string; reference: string },
): Promise<Candidate | null> {
  const { rows } = await tx.query<{ id: string; title: string; resolution: string | null }>(
    `SELECT t.id,
            coalesce(t.subject, t.reference) AS title,
            ${TICKET_RESOLUTION}             AS resolution
       FROM ticket t
      WHERE ${TICKET_CORPUS}
        AND upper(t.reference) = upper($2)
      LIMIT 1`,
    [args.productId, args.reference],
  );
  if (!rows[0]) return null;
  return {
    source_type: 'resolved_ticket',
    source_id: rows[0].id,
    title: rows[0].title,
    snippet: excerpt(rows[0].resolution),
    // Not a ranked score. An equality on a unique key never enters fusion.
    score: 1,
  };
}

/** Corpus sizes, for the operational view and for candidate-limit justification. */
export async function corpusSize(
  tx: Tx,
  productId: string,
): Promise<{ tickets: number; articles: number; ticketsEmbedded: number; articlesEmbedded: number }> {
  const { rows } = await tx.query<{
    tickets: string;
    articles: string;
    tickets_embedded: string;
    articles_embedded: string;
  }>(
    `SELECT
       (SELECT count(*) FROM ticket t WHERE ${TICKET_CORPUS})                                AS tickets,
       (SELECT count(*) FROM ticket t WHERE ${TICKET_CORPUS} AND t.embedding IS NOT NULL)    AS tickets_embedded,
       (SELECT count(*) FROM kb_article k WHERE ${KB_CORPUS})                                AS articles,
       (SELECT count(*) FROM kb_article k WHERE ${KB_CORPUS} AND k.embedding IS NOT NULL)    AS articles_embedded`,
    [productId],
  );
  return {
    tickets: Number(rows[0]?.tickets ?? 0),
    articles: Number(rows[0]?.articles ?? 0),
    ticketsEmbedded: Number(rows[0]?.tickets_embedded ?? 0),
    articlesEmbedded: Number(rows[0]?.articles_embedded ?? 0),
  };
}

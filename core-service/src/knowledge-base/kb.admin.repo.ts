import {
  kbIndexState,
  type KbArticleAdminDTO,
  type KbArticleStatus,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * KB authoring persistence — Phase 18.
 *
 * SEPARATE FILE FROM kb.repo.ts, DELIBERATELY. That file serves the widget and
 * the integrating product: it returns excerpts, hides `status`, and increments
 * `views` as a side effect of a read. Every one of those is correct there and
 * wrong here. Putting the admin queries alongside them would mean one file
 * whose functions serve two audiences with opposite requirements, and the way
 * that fails is a customer response that grew a `status` field because it was
 * convenient for the editor.
 *
 * ⚠️ `views` IS NEVER TOUCHED IN THIS FILE.
 *
 * `kb.repo.ts:getArticle` bumps it, because a customer opening an article IS a
 * view and that counter orders the widget's article list. An editor opening
 * the same article to fix a typo is not a view. Reusing that function for the
 * admin read would inflate the popularity ordering every time someone
 * proofread something, and nothing would report it — the number would simply
 * be wrong in a plausible-looking way.
 *
 * ⚠️ EVERY STATEMENT CARRIES THE TENANT PREDICATE EXPLICITLY.
 *
 * RLS (`kb_isolation`) is the enforcement point and is not being second-
 * guessed. The explicit predicate does two further things. It makes the
 * constraint visible in the statement, so a reader does not have to hold
 * 005_rls.sql in their head. And on the list query it sits INSIDE the ranked,
 * limited query rather than filtering what came back — a post-filter would
 * silently return short pages that look like an empty knowledge base. This
 * corpus makes that concrete: the same twelve articles exist in all four
 * products with identical text, so an unscoped page would be four near-
 * identical rows and a post-filter would keep whichever three it happened to
 * fetch.
 */

/** The `embedding` column itself is never selected: it is 1536 floats nobody renders. */
const COLUMNS = `k.id, k.product_id, k.title, k.category, k.status, k.is_public,
                 k.views, k.helpful_yes, k.helpful_no, k.created_at, k.updated_at,
                 k.embedded_at, k.embedding_error, k.embedding_fingerprint,
                 k.embedding_content_sha, k.embedding_model,
                 (k.embedding IS NOT NULL) AS has_embedding`;

export interface KbAdminRow {
  id: string;
  product_id: string;
  title: string;
  category: string | null;
  status: KbArticleStatus;
  is_public: boolean;
  views: number;
  helpful_yes: number;
  helpful_no: number;
  created_at: Date;
  updated_at: Date;
  embedded_at: Date | null;
  embedding_error: string | null;
  embedding_fingerprint: string | null;
  embedding_content_sha: string | null;
  embedding_model: string | null;
  has_embedding: boolean;
  body?: string;
}

/**
 * Row to wire shape. `currentModel` is passed in rather than imported so the
 * mapper stays a pure function of its arguments — the index-state derivation is
 * the interesting part and it is unit-tested in shared/types/kb.test.ts against
 * the same inputs this builds.
 */
export function toAdminDTO(r: KbAdminRow, currentModel: string, includeBody = false): KbArticleAdminDTO {
  return {
    id: r.id,
    product_id: r.product_id,
    title: r.title,
    category: r.category,
    status: r.status,
    is_public: r.is_public,
    views: Number(r.views),
    helpful_yes: Number(r.helpful_yes),
    helpful_no: Number(r.helpful_no),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    index_state: kbIndexState({
      status: r.status,
      is_public: r.is_public,
      has_embedding: r.has_embedding,
      embedding_error: r.embedding_error,
      embedding_fingerprint: r.embedding_fingerprint,
      embedding_content_sha: r.embedding_content_sha,
      embedding_model: r.embedding_model,
      current_model: currentModel,
    }),
    embedded_at: r.embedded_at ? r.embedded_at.toISOString() : null,
    embedding_error: r.embedding_error,
    ...(includeBody ? { body: r.body ?? '' } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────

export interface KbListArgs {
  /**
   * Product ids this caller may see.
   *
   * NULL means "do not narrow", and is reachable ONLY for a super_admin whose
   * session carries no scope. That is a real, supported state: `effectiveScopes`
   * expands a super admin to every product id at login, so a normal super admin
   * session has concrete ids here and IS narrowed — but the header can legitimately
   * be empty, and `product_id = ANY('{}')` would then return nothing at all,
   * which reads as "the platform has no articles" rather than as a scope
   * problem. RLS still applies in that case and `kb_isolation` correctly
   * permits a super admin, so nothing is unguarded; there is simply no narrowing
   * left to express.
   */
  productIds: string[] | null;
  /** A single-tenant filter chosen by the operator. Already tenant-asserted. */
  productId?: string | null;
  status?: KbArticleStatus | null;
  q?: string | null;
  limit: number;
  offset: number;
}

/**
 * Escape LIKE wildcards in operator input.
 *
 * Without this, typing `%` matches every article and typing `_` matches any
 * character — not an injection (the value is bound), but a search box that
 * silently means something other than what was typed. Backslash is escaped
 * first, or it would escape the escapes added after it.
 *
 * Exported for the unit test: the ordering is the only thing that can be wrong
 * here and it is invisible in the result.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * One page of articles, plus the total the filters matched.
 *
 * `count(*) OVER ()` rather than a second COUNT query: it is evaluated over the
 * filtered set BEFORE LIMIT/OFFSET, in the same statement and therefore the
 * same snapshot, so the total can never disagree with the page. Two queries
 * could, and the disagreement would show up as a pager offering a page that is
 * empty when you reach it.
 *
 * ⚠️ THE SEARCH USES BOTH STRATEGIES THE SCHEMA ALREADY INDEXES, and no
 * others. `search_tsv` is the GENERATED tsvector (title weighted A, body B) and
 * `title ILIKE` rides `kb_title_trgm_idx`. This is a management filter, not
 * retrieval: it is not ranked, it is not fused, and it deliberately does not
 * touch the vector column. Ranking an editor's article list by cosine
 * similarity would reorder their workspace by something they did not ask about.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`, matching hybrid.repo.ts: it
 * parses input as a phrase language and cannot raise a syntax error on stray
 * quotes or parentheses, so a malformed query returns no rows instead of a 500
 * carrying a parser message.
 */
export async function listArticlesForAdmin(
  tx: Tx,
  args: KbListArgs,
): Promise<{ rows: KbAdminRow[]; total: number }> {
  const q = args.q?.trim() ? args.q.trim() : null;

  const { rows } = await tx.query<KbAdminRow & { total_count: string }>(
    `SELECT ${COLUMNS}, count(*) OVER () AS total_count
       FROM kb_article k
      WHERE ($1::text[] IS NULL OR k.product_id = ANY($1))
        AND ($2::text IS NULL OR k.product_id = $2)
        AND ($3::text IS NULL OR k.status = $3)
        AND ($4::text IS NULL
             OR k.search_tsv @@ websearch_to_tsquery('english', $4)
             OR k.title ILIKE '%' || $5 || '%')
      ORDER BY k.updated_at DESC, k.id DESC
      LIMIT $6 OFFSET $7`,
    [
      args.productIds,
      args.productId ?? null,
      args.status ?? null,
      q,
      q === null ? '' : escapeLike(q),
      args.limit,
      args.offset,
    ],
  );

  return { rows, total: rows.length ? Number(rows[0]!.total_count) : 0 };
}

/**
 * One article, with its body, and WITHOUT incrementing `views`.
 *
 * Also the guard read: the route uses the `product_id` and `status` this
 * returns rather than anything the client sent. Returning the whole row rather
 * than a DTO is deliberate — the route needs the raw lifecycle fields to make
 * its decisions, and a DTO would either lose them or leak them.
 */
export async function findArticleForAdmin(tx: Tx, id: string): Promise<KbAdminRow | null> {
  const { rows } = await tx.query<KbAdminRow>(
    `SELECT ${COLUMNS}, k.body FROM kb_article k WHERE k.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `status` IS A SQL LITERAL, NOT A PARAMETER.
 *
 * Creation always produces a draft, and writing 'draft' into the statement
 * makes that structurally true rather than merely validated. There is no
 * argument a caller could pass — through the route, through a future caller of
 * this repo, through a mistake in a zod schema — that lands an article
 * anywhere else. Publication is a separate transition with its own role check
 * and its own audit row, and it should be impossible to skip it by accident.
 *
 * `is_public` is likewise literal: staff-only articles are deferred, and until
 * the question "which retrieval surfaces may see them?" is answered, an article
 * that is published-but-not-public would sit in no corpus at all while looking
 * live. See the NOT GRANTED note in migration 018.
 */
export async function createArticle(
  tx: Tx,
  args: { id: string; productId: string; title: string; body: string; category: string | null },
): Promise<void> {
  await tx.query(
    `INSERT INTO kb_article (id, product_id, title, body, category, status, is_public)
     VALUES ($1, $2, $3, $4, $5, 'draft', true)`,
    [args.id, args.productId, args.title, args.body, args.category],
  );
}

/**
 * Replace the three editable fields.
 *
 * The caller passes FINAL values, having merged a partial PATCH against the row
 * it already loaded for the tenant guard. That keeps this statement a plain SET
 * of known columns instead of a conditionally-assembled one, which is the shape
 * that quietly grows a column it should not have.
 *
 * ⚠️ THE SET CLAUSE NAMES FOUR COLUMNS AND CANNOT NAME MORE. Migration 018
 * revoked table-wide UPDATE from `iris_app`, so `product_id`, `id`,
 * `created_at` and `is_public` are not merely absent here — an UPDATE naming
 * them fails at the database. The isolation guarantee does not depend on this
 * file staying correct.
 *
 * `updated_at` is set explicitly because there is no trigger. It does NOT
 * affect embedding eligibility, which keys off the generated
 * `embedding_content_sha`; it orders the admin list and the pending sweep.
 *
 * Returns false when nothing matched, which for a caller that has already
 * loaded the row means the tenant predicate rejected it.
 */
export async function updateArticleText(
  tx: Tx,
  args: { id: string; productId: string; title: string; body: string; category: string | null },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE kb_article
        SET title = $3, body = $4, category = $5, updated_at = now()
      WHERE id = $1 AND product_id = $2`,
    [args.id, args.productId, args.title, args.body, args.category],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Move one article to a new lifecycle state.
 *
 * ⚠️ THIS FUNCTION DOES NOT DECIDE WHETHER THE MOVE IS LEGAL. The transition
 * matrix lives in shared/types/kb.ts and the check runs in kb.service.ts,
 * because the admin panel has to make the same judgement to decide which
 * buttons to render. A second copy of the rule here is a second copy that can
 * disagree with the one the UI uses.
 *
 * ⚠️ NO EMBEDDING WORK HAPPENS HERE, AND NONE SHOULD BE ADDED.
 *
 * Publishing does not enqueue anything; the row simply becomes eligible for
 * `selectPending` and the existing five-minute sweep picks it up. Unpublishing
 * does not clear the vector; the corpus predicates stop returning the row at
 * COMMIT, so it leaves retrieval immediately, and keeping the vector means a
 * later republish of unchanged text costs nothing rather than a fresh, billed
 * embedding. See migration 014 for why there is no event type for this.
 */
export async function updateArticleStatus(
  tx: Tx,
  args: { id: string; productId: string; status: KbArticleStatus },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE kb_article
        SET status = $3, updated_at = now()
      WHERE id = $1 AND product_id = $2`,
    [args.id, args.productId, args.status],
  );
  return (rowCount ?? 0) > 0;
}

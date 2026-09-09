import {
  SIMILAR_RESOLUTION_CHARS,
  toVectorLiteral,
  type SimilarTicket,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * Similar Tickets retrieval — Phase 14.
 *
 * ⚠️ EVERY ELIGIBILITY AND AUTHORIZATION RULE IS A PREDICATE, INSIDE THE
 * RANKED QUERY, BEFORE `ORDER BY` AND `LIMIT`.
 *
 * Not one of them is applied in TypeScript afterwards, and the difference is
 * not stylistic. `ORDER BY embedding <=> q LIMIT 5` is evaluated AFTER
 * filtering; a rule applied to the five rows that came back would silently
 * return fewer than five — or none — while looking like a working search. Worse
 * for the security rules: post-filtering means the unauthorized row was
 * fetched, ranked and held in memory before being dropped.
 *
 * The rules, all in `HISTORICAL_CORPUS`:
 *
 *   product_id = $2      the platform's primary security boundary, alongside
 *                        RLS rather than instead of it
 *   status IN (...)      resolved or closed only — an open ticket is not
 *                        history, it is another unfinished problem
 *   id <> $3             the current ticket can never be its own precedent,
 *                        even at similarity 1.0
 *   embedding NOT NULL   `<=>` against NULL is NULL and NULL sorts LAST under
 *                        ASC, so un-embedded rows would pad every result set
 *   product_tenant_id    optional, and only when the caller is tenant-bound
 */

/**
 * ⚠️ CUSTOMER-TENANT SCOPE IS OPTIONAL, AND THAT MATCHES IRIS, NOT LAZINESS.
 *
 * The platform's primary boundary is the PRODUCT (design doc §10: "No code path
 * reads a ticket without a `product_id` predicate"). `product_tenant_id` is
 * recorded "for filtering, isolation, and analytics" — and the existing
 * `GET /admin/api/tickets` already lists a product's tickets ACROSS its
 * customer tenants, with `product_tenant_id` as an optional filter. Support
 * staff serve the whole product; that is their job.
 *
 * So passing `productTenantId` narrows to one customer tenant when the caller
 * is genuinely tenant-bound, and omitting it gives staff the same visibility
 * every other admin ticket query already gives them. Either way the predicate
 * is in SQL, and either way RLS is underneath it.
 */
const HISTORICAL_CORPUS = `
      t.product_id = $2
  AND t.status IN ('resolved','closed')
  AND t.id <> $3
  AND t.embedding IS NOT NULL
  AND ($5::text IS NULL OR t.product_tenant_id = $5)`;

/**
 * The last PUBLIC support reply on a ticket.
 *
 * `is_internal = false` is load-bearing: the schema calls internal comments
 * "never leaves the platform", and a private note written while handling one
 * customer's ticket is not context to surface on another's. `author_type =
 * 'assignee'` picks the support side rather than the customer restating the
 * problem — the same rule Phase 11 established for the deflection corpus.
 */
const LATEST_PUBLIC_REPLY = `
  (SELECT left(c.body, ${SIMILAR_RESOLUTION_CHARS}) FROM comment c
    WHERE c.ticket_id = t.id
      AND c.is_internal = false
      AND c.author_type = 'assignee'
    ORDER BY c.created_at DESC LIMIT 1)`;

interface Row {
  reference: string;
  title: string;
  status: 'resolved' | 'closed';
  similarity: string;
  resolution: string | null;
  resolved_at: Date | null;
  assignee_id: string | null;
}

/**
 * Historical tickets most similar to a query vector.
 *
 * ⚠️ NO SIMILARITY FLOOR — see SIMILAR_TICKETS_FLOOR. The corpus contains only
 * identical and unrelated pairs, so any threshold would encode the seed data
 * rather than the domain. The score is returned instead, and the reader judges.
 *
 * Ordering: cosine distance, then `reference` as a total tiebreak. Ties are
 * guaranteed here rather than hypothetical — duplicate seeded tickets produce
 * byte-identical text and therefore identical embeddings.
 *
 * ⚠️ PHASE 16 ADDED `assignee_id` TO THE PROJECTION — nothing else.
 *
 * Suggested Assignees needs to know who handled each similar ticket. Computing
 * that with a second query would mean two copies of HISTORICAL_CORPUS, which is
 * exactly the duplication Phases 11-15 avoided. The corpus predicate, ordering,
 * limit, similarity semantics, internal-comment filtering and failure behaviour
 * are untouched, so every Phase 14 property holds unchanged, and the column was
 * already inside this scan.
 *
 * It is a deliberate widening of the admin /similar response.
 * `similar.integration.test.ts` permits this field by name and still rejects
 * ticket ids, product ids, tenant ids and raiser references.
 *
 * ⚠️ Do not put backticks in the SQL template literal below — one in a comment
 * silently terminates the string and the query becomes JavaScript.
 */
export async function findSimilarTickets(
  tx: Tx,
  args: {
    vector: number[];
    productId: string;
    excludeTicketId: string;
    limit: number;
    productTenantId?: string | null;
  },
): Promise<SimilarTicket[]> {
  const { rows } = await tx.query<Row>(
    `SELECT t.reference,
            coalesce(nullif(t.subject, ''), t.reference) AS title,
            t.status,
            1 - (t.embedding <=> $1::vector)             AS similarity,
            ${LATEST_PUBLIC_REPLY}                       AS resolution,
            coalesce(t.resolved_at, t.closed_at)         AS resolved_at,
            -- Phase 16: who handled it. See the note above this function.
            t.assignee_id                                AS assignee_id
       FROM ticket t
      WHERE ${HISTORICAL_CORPUS}
      ORDER BY t.embedding <=> $1::vector, t.reference
      LIMIT $4`,
    [
      toVectorLiteral(args.vector),
      args.productId,
      args.excludeTicketId,
      args.limit,
      args.productTenantId ?? null,
    ],
  );

  return rows.map((r) => ({
    reference: r.reference,
    title: r.title,
    status: r.status,
    similarity: Math.round(Number(r.similarity) * 10_000) / 10_000,
    resolution: r.resolution,
    resolved_at: r.resolved_at ? r.resolved_at.toISOString() : null,
    assignee_id: r.assignee_id,
  }));
}

/**
 * The text a ticket is compared BY.
 *
 * ⚠️ DELIBERATELY THE SAME `subject + description` PHASE 10 EMBEDS AND
 * FINGERPRINTS. Reusing it means the query representation and the corpus
 * representation are the same thing, so a current ticket is compared to history
 * on exactly the terms history was indexed on. A second representation would be
 * a second thing to keep in step, and Phase 10's canonical form is already the
 * single definition (migration 016).
 *
 * Whitespace is collapsed to match that canonical form. NOT included, and not
 * to be added without a written decision: raiser identity, product or tenant
 * ids, internal comments, metadata, attachments.
 */
export async function currentTicketQueryText(
  tx: Tx,
  ticketId: string,
): Promise<{ text: string; productId: string; productTenantId: string } | null> {
  const { rows } = await tx.query<{
    text: string;
    product_id: string;
    product_tenant_id: string;
  }>(
    `SELECT trim(regexp_replace(
              coalesce(t.subject,'') || E'\\n\\n' || coalesce(t.description,''),
              '\\s+', ' ', 'g'))          AS text,
            t.product_id,
            t.product_tenant_id
       FROM ticket t
      WHERE t.id = $1`,
    [ticketId],
  );
  if (!rows[0]) return null;
  return {
    text: rows[0].text,
    productId: rows[0].product_id,
    productTenantId: rows[0].product_tenant_id,
  };
}

/** How many historical tickets are eligible at all. For diagnostics. */
export async function historicalCorpusSize(
  tx: Tx,
  args: { productId: string; excludeTicketId: string; productTenantId?: string | null },
): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM ticket t
      WHERE t.product_id = $1
        AND t.status IN ('resolved','closed')
        AND t.id <> $2
        AND t.embedding IS NOT NULL
        AND ($3::text IS NULL OR t.product_tenant_id = $3)`,
    [args.productId, args.excludeTicketId, args.productTenantId ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

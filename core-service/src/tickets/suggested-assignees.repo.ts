import { SUGGESTIBLE_ROLES, type SuggestibleRole } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * Candidate and evidence queries for Suggested Assignees — Phase 16.
 *
 * Every rule that decides WHO may be suggested and WHICH history counts is a
 * predicate inside a query here. Nothing is filtered in TypeScript afterwards —
 * the same discipline Phases 11 and 14 established, for the same reason: a
 * post-filter is one forgotten `.filter()` away from a leak, and it cannot be
 * proven by reading the SQL.
 */

export interface CandidateRow {
  support_user_id: string;
  display_name: string;
  role: SuggestibleRole;
  active_ticket_count: number;
}

/**
 * The people who may be suggested for a ticket in this product.
 *
 * ⚠️ THE INNER JOIN IS THE SECURITY CONTROL, NOT RLS.
 *
 * `support_user_visibility` is `USING (app_role() IN ('super_admin',
 * 'product_admin','manager','agent'))` — it has NO product predicate. Any
 * support role can read every support_user row in the platform. A query that
 * selected from support_user and trusted RLS would return the entire staff
 * directory across every product.
 *
 * `support_user_scope` is therefore joined explicitly, before ranking, and the
 * join is INNER. That also excludes `super_admin` structurally rather than by a
 * role list alone: migration 007 records that a super_admin holds NO scope rows
 * ("A super_admin has NO rows, which means all tenants"), so an inner join
 * removes them with no special case. The role filter below states the same rule
 * a second time, readably.
 *
 * ⚠️ `productId` MUST come from the authorized ticket row, never from the
 * request. A caller who could name a product could ask who staffs someone
 * else's.
 */
export async function findEligibleCandidates(
  tx: Tx,
  args: { productId: string },
): Promise<CandidateRow[]> {
  const { rows } = await tx.query<{
    support_user_id: string;
    display_name: string;
    role: SuggestibleRole;
    active_ticket_count: string;
  }>(
    `SELECT u.id                AS support_user_id,
            u.display_name      AS display_name,
            u.role              AS role,
            (SELECT count(*) FROM ticket t
              WHERE t.assignee_id = u.id
                AND t.status IN ('assigned','in_progress','waiting_on_raiser'))
                                AS active_ticket_count
       FROM support_user u
       JOIN support_user_scope s ON s.support_user_id = u.id
      WHERE u.is_active = true
        AND s.product_id = $1
        AND u.role = ANY($2::text[])
      GROUP BY u.id, u.display_name, u.role
      ORDER BY u.id`,
    [args.productId, SUGGESTIBLE_ROLES as readonly string[]],
  );

  return rows.map((r) => ({
    support_user_id: r.support_user_id,
    display_name: r.display_name,
    role: r.role,
    active_ticket_count: Number(r.active_ticket_count),
  }));
}

/**
 * How many resolved/closed tickets in THIS product and THIS category each
 * candidate handled.
 *
 * The corpus rules mirror Phase 14's `HISTORICAL_CORPUS` — product-scoped,
 * resolved or closed, never the current ticket — minus the embedding
 * requirement, because a ticket with no embedding still evidences that someone
 * has worked this category.
 *
 * ⚠️ `ticket.category` ONLY. Never `ai_classification`, and never its
 * confidence: that signal is uncalibrated by design and is why auto-routing is
 * disabled (auto_route_p1 = 1.01). The persisted category is a column a human
 * can see and override, with `classification_source` recording who set it.
 *
 * Returns an empty map when the ticket has no category — the caller treats
 * every candidate as zero and says so in a caveat.
 */
export async function countCategoryExperience(
  tx: Tx,
  args: {
    productId: string;
    category: string | null;
    excludeTicketId: string;
    candidateIds: string[];
  },
): Promise<Map<string, number>> {
  if (args.category === null || args.candidateIds.length === 0) return new Map();

  const { rows } = await tx.query<{ assignee_id: string; n: string }>(
    `SELECT t.assignee_id, count(*) AS n
       FROM ticket t
      WHERE t.product_id = $1
        AND t.status IN ('resolved','closed')
        AND t.id <> $2
        AND t.category = $3
        AND t.assignee_id = ANY($4::text[])
      GROUP BY t.assignee_id`,
    [args.productId, args.excludeTicketId, args.category, args.candidateIds],
  );

  return new Map(rows.map((r) => [r.assignee_id, Number(r.n)]));
}

/**
 * How many historical tickets are eligible to provide evidence in this product.
 *
 * Diagnostics and the sparse-evidence caveat only — it never affects ordering.
 * Deliberately the same shape as Phase 14's corpus count so the two features
 * report the same number for the same product.
 */
export async function countHistoricalCorpus(
  tx: Tx,
  args: { productId: string; excludeTicketId: string },
): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM ticket t
      WHERE t.product_id = $1
        AND t.status IN ('resolved','closed')
        AND t.id <> $2`,
    [args.productId, args.excludeTicketId],
  );
  return Number(rows[0]?.n ?? 0);
}

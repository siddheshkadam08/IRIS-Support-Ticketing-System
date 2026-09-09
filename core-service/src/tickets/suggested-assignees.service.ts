import {
  ASSIGNEE_RECOMMENDATION_VERSION,
  CATEGORY_EXPERIENCE_CAP,
  MIN_CORPUS_FOR_SPARSE_CAVEAT,
  categoryExperienceLabel,
  compareCandidates,
  evidenceStrength,
  suggestionSummary,
  type AssigneeSuggestion,
  type RankableCandidate,
  type SuggestedAssigneesOutcome,
  type SuggestedAssigneesResponse,
  type SuggestionEvidence,
} from '@iris/shared/types';
import { logger } from '../logger.js';
import type { Tx } from '../db/with-scope.js';
import { findSimilar } from './similar.service.js';
import {
  countCategoryExperience,
  countHistoricalCorpus,
  findEligibleCandidates,
  type CandidateRow,
} from './suggested-assignees.repo.js';

/**
 * Suggested Assignees — Phase 16.
 *
 *     ticket -> eligible candidates -> three counts -> total order -> evidence
 *
 * ⚠️ READ-ONLY. This function writes nothing: no ticket update, no comment, no
 * audit event, no outbox event, no queue job. Assignment stays where it was —
 * `POST /admin/api/tickets/:id/assign`, which re-validates everything
 * independently. A suggestion grants no authorization.
 *
 * ⚠️ NO MODEL. No prompt, no LLM, no Python call, no reranking, no embedding of
 * its own. The Phase 10 embeddings are reached only through the Phase 14
 * retrieval this reuses, and if that retrieval is unavailable the feature
 * degrades to two factors rather than failing.
 *
 * ⚠️ NO SCORE AND NO WEIGHTS. See `compareCandidates`.
 */

export interface SuggestedAssigneesArgs {
  ticketId: string;
  requestId: string;
  /** Narrow to one customer tenant. Same contract as Phase 14. */
  productTenantId?: string | null;
  /** Test seam, threaded to Phase 14 retrieval. Production passes nothing. */
  embed?: Parameters<typeof findSimilar>[1]['embed'];
}

interface TicketRow {
  product_id: string;
  category: string | null;
}

/**
 * Suggest assignees for a ticket.
 *
 * Returns null when the ticket is not visible under the caller's scope, so an
 * unauthorized id cannot be used to probe for existence — the route turns that
 * into a 404 rather than a 403.
 *
 * NEVER THROWS for a retrieval problem. Similar-ticket evidence is optional;
 * losing it costs one factor, not the response.
 */
export async function suggestAssignees(
  tx: Tx,
  args: SuggestedAssigneesArgs,
): Promise<SuggestedAssigneesResponse | null> {
  const started = Date.now();

  /**
   * ⚠️ THE PRODUCT COMES FROM THE TICKET ROW, under the caller's scope and
   * RLS. Never from a request parameter — a caller who could name a product
   * could ask who staffs someone else's.
   */
  const { rows } = await tx.query<TicketRow>(
    `SELECT product_id, category FROM ticket WHERE id = $1`,
    [args.ticketId],
  );
  const ticket = rows[0];
  if (!ticket) return null;

  const candidates = await findEligibleCandidates(tx, { productId: ticket.product_id });

  const caveats: string[] = [];
  const respond = (
    suggestions: AssigneeSuggestion[],
    outcome: SuggestedAssigneesOutcome,
    extra: { similarHits: number; similarOutcome: string; corpus: number; embedMs: number | null },
  ): SuggestedAssigneesResponse => ({
    suggestions,
    caveats,
    diagnostics: {
      eligible_candidates: candidates.length,
      suggestions_returned: suggestions.length,
      similar_hits: extra.similarHits,
      similar_outcome: extra.similarOutcome,
      historical_corpus: extra.corpus,
      embed_ms: extra.embedMs,
      total_ms: Date.now() - started,
      algorithm_version: ASSIGNEE_RECOMMENDATION_VERSION,
      outcome,
    },
  });

  if (candidates.length === 0) {
    caveats.push('No staff are scoped to this product.');
    return respond([], 'no_candidates', {
      similarHits: 0,
      similarOutcome: 'not_attempted',
      corpus: 0,
      embedMs: null,
    });
  }

  const eligibleIds = new Set(candidates.map((c) => c.support_user_id));

  const [similar, categoryCounts, corpus] = await Promise.all([
    // Phase 14, reused unchanged. Its own predicate supplies product scope,
    // resolved/closed, self-exclusion and the embedding requirement.
    findSimilar(tx, {
      ticketId: args.ticketId,
      requestId: args.requestId,
      productTenantId: args.productTenantId ?? null,
      embed: args.embed,
    }),
    countCategoryExperience(tx, {
      productId: ticket.product_id,
      category: ticket.category,
      excludeTicketId: args.ticketId,
      candidateIds: [...eligibleIds],
    }),
    countHistoricalCorpus(tx, {
      productId: ticket.product_id,
      excludeTicketId: args.ticketId,
    }),
  ]);

  const hits = similar?.items ?? [];
  const similarOutcome = similar?.diagnostics.outcome ?? 'no_corpus';
  const retrievalDegraded = similarOutcome !== 'ok' && similarOutcome !== 'no_corpus';

  /**
   * Attribute the similar tickets to candidates.
   *
   * ⚠️ A hit whose handler is NOT eligible is dropped from ATTRIBUTION ONLY.
   * The Phase 14 response is untouched — the Similar Tickets panel still shows
   * that ticket. Someone who has left, or who is scoped elsewhere, simply
   * cannot be suggested for it.
   */
  const attributed = new Map<string, { count: number; best: number; evidence: SuggestionEvidence[] }>();
  let attributedHits = 0;
  for (const hit of hits) {
    const who = hit.assignee_id;
    if (!who || !eligibleIds.has(who)) continue;
    attributedHits += 1;

    const entry = attributed.get(who) ?? { count: 0, best: 0, evidence: [] };
    entry.count += 1;
    entry.best = Math.max(entry.best, hit.similarity);
    entry.evidence.push({
      reference: hit.reference,
      title: hit.title,
      similarity: hit.similarity,
      resolved_at: hit.resolved_at,
      // ⚠️ `resolution` is deliberately NOT carried. The Similar Tickets panel
      // already shows it; repeating another customer's resolution text inside a
      // staffing view widens exposure for no ranking value.
    });
    attributed.set(who, entry);
  }

  // ── caveats: say what is thin, rather than letting small numbers imply ──
  if (corpus < MIN_CORPUS_FOR_SPARSE_CAVEAT) {
    caveats.push(
      `Historical evidence in this product is limited (${corpus} resolved ticket${corpus === 1 ? '' : 's'}).`,
    );
  }
  if (attributedHits === 0) {
    caveats.push('No similar resolved tickets were found for this product.');
  }
  if (ticket.category === null) {
    caveats.push('This ticket has no category, so category experience could not be considered.');
  }
  if (retrievalDegraded) {
    caveats.push('Similar-ticket evidence was unavailable; suggestions use category history and workload only.');
  }

  const ranked = candidates
    .map<{ row: CandidateRow; rank: RankableCandidate }>((row) => {
      const found = attributed.get(row.support_user_id);
      return {
        row,
        rank: {
          support_user_id: row.support_user_id,
          similar_hits: found?.count ?? 0,
          best_similarity: found ? found.best : null,
          category_count: categoryCounts.get(row.support_user_id) ?? 0,
          active_ticket_count: row.active_ticket_count,
        },
      };
    })
    .sort((a, b) => compareCandidates(a.rank, b.rank));

  const suggestions = ranked.map<AssigneeSuggestion>(({ row, rank }, i) => {
    const evidence = attributed.get(row.support_user_id)?.evidence ?? [];
    return {
      rank: i + 1,
      support_user_id: row.support_user_id,
      display_name: row.display_name,
      role: row.role,
      evidence_strength: evidenceStrength(rank.similar_hits, rank.category_count),
      summary: suggestionSummary({
        similarHits: rank.similar_hits,
        categoryCount: rank.category_count,
        category: ticket.category,
      }),
      factors: {
        similar_tickets: {
          count: rank.similar_hits,
          best_similarity: rank.best_similarity,
          label:
            rank.similar_hits === 0
              ? 'no similar resolved tickets'
              : `${rank.similar_hits} of the ${hits.length} most similar tickets`,
        },
        category_experience: {
          count: rank.category_count,
          label: categoryExperienceLabel(rank.category_count),
          category: ticket.category,
        },
        active_tickets: {
          count: rank.active_ticket_count,
          scope: 'all products',
          label: `${rank.active_ticket_count} active ticket${rank.active_ticket_count === 1 ? '' : 's'} (all products)`,
        },
      },
      evidence,
    };
  });

  const outcome: SuggestedAssigneesOutcome = retrievalDegraded
    ? 'similar_unavailable'
    : suggestions.every((s) => s.evidence_strength === 'none')
      ? 'no_evidence'
      : 'ok';

  /**
   * ⚠️ Bounded, non-sensitive. Never the subject, description, comment bodies,
   * evidence titles, resolution text, display names or product_tenant_id.
   * Internal ids appear only where existing Core logging already uses them.
   */
  logger.info(
    {
      request_id: args.requestId,
      product_id: ticket.product_id,
      ticket_id: args.ticketId,
      eligible_candidates: candidates.length,
      suggestions_returned: suggestions.length,
      similar_hits: attributedHits,
      similar_outcome: similarOutcome,
      historical_corpus: corpus,
      embed_ms: similar?.diagnostics.embed_ms ?? null,
      total_ms: Date.now() - started,
      algorithm_version: ASSIGNEE_RECOMMENDATION_VERSION,
      outcome,
    },
    'suggested assignees',
  );

  return respond(suggestions, outcome, {
    similarHits: attributedHits,
    similarOutcome,
    corpus,
    embedMs: similar?.diagnostics.embed_ms ?? null,
  });
}

/** Re-exported so tests can assert the ordering cap without a second constant. */
export { CATEGORY_EXPERIENCE_CAP };

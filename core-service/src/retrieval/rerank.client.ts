import {
  RERANK_EXCERPT_CHARS,
  RERANK_MAX_CANDIDATES,
  RERANK_MIN_CANDIDATES,
  applyRanking,
  isUsableRanking,
  type RerankCandidate,
  type RerankOutcome,
  type RetrievalHit,
} from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { callAiService } from './ai-call.js';

/**
 * Reranking — Phase 12.
 *
 * Takes the ordering Phase 11 produced and asks the model which of those
 * candidates best answers the question. It reorders; it never retrieves, and it
 * cannot add or remove a row.
 *
 * ⚠️ THE MODEL IS GIVEN ORDINALS, NOT IDENTIFIERS.
 *
 * Core numbers its own list 1..N and sends `{ordinal, kind, title, excerpt}`.
 * No source_id, no product_id, no reference, no tenant identifier crosses the
 * boundary. The model returns integers, and `applyRanking` maps them back
 * through Core's own array.
 *
 * That makes "the model cannot introduce an unauthorized document" a property
 * of the output alphabet rather than of a validation rule someone must keep
 * correct. An id-based contract would need the validation to be right forever;
 * this needs 1..N to remain 1..N.
 *
 * ⚠️ THE EXACT-IDENTIFIER MATCH IS NEVER SENT HERE. Phase 11 pins it by
 * business rule, and the cleanest way to guarantee the model cannot demote it
 * is that the model never sees it. See hybrid.service.ts.
 */

export interface RerankResult {
  hits: RetrievalHit[];
  outcome: RerankOutcome;
  latencyMs: number | null;
  /** How many candidates were actually sent to the provider. */
  candidateCount: number;
}

export type RerankFn = (
  query: string,
  hits: RetrievalHit[],
  requestId: string,
) => Promise<RerankResult>;

/**
 * Reorder `hits`. NEVER THROWS, and never returns fewer or more rows than it
 * was given.
 *
 * Every failure path returns the input order unchanged with an `outcome` saying
 * why — so reranking can never make search worse than Phase 11, only slower.
 */
export async function rerank(
  query: string,
  hits: RetrievalHit[],
  requestId: string,
  fetchImpl?: typeof fetch,
): Promise<RerankResult> {
  const keep = (outcome: RerankOutcome, latencyMs: number | null = null): RerankResult => ({
    hits,
    outcome,
    latencyMs,
    candidateCount: 0,
  });

  if (!config.RERANKING_ENABLED) return keep('skipped_disabled');

  /**
   * Fewer than two candidates cannot be reordered, so the provider call would
   * cost ~1.7s to return the only possible answer. Checked here rather than
   * relying on the AI service to reject it.
   */
  if (hits.length < RERANK_MIN_CANDIDATES) return keep('skipped_too_few');

  const window = hits.slice(0, RERANK_MAX_CANDIDATES);
  const tail = hits.slice(RERANK_MAX_CANDIDATES);

  const candidates: RerankCandidate[] = window.map((h, i) => ({
    ordinal: i + 1,
    // The KIND of evidence, not a tenant identifier.
    kind: h.source_type === 'kb_article' ? 'article' : 'ticket',
    title: h.title,
    // Bounded: the excerpt is already a Phase 11 snippet, and this caps what
    // a single oversized row can contribute to the prompt.
    excerpt: h.snippet.slice(0, RERANK_EXCERPT_CHARS),
  }));

  const outcome = await callAiService<{ ranking?: unknown }>(
    {
      feature: 'reranking',
      requestId,
      // The query travels as `description` — the field for "the text to
      // process" — matching how the embedding feature carries its text. No
      // second spelling of the query, and no new required field.
      input: { subject: null, description: query, candidates },
      timeoutMs: config.RERANK_TIMEOUT_MS,
    },
    fetchImpl,
  );

  if (!outcome.ok) {
    const reason: RerankOutcome =
      outcome.reason === 'timeout'
        ? 'provider_timeout'
        : outcome.reason === 'not_configured'
          ? 'not_configured'
          : outcome.reason === 'invalid'
            ? 'malformed'
            : 'provider_unavailable';
    logger.warn(
      {
        request_id: requestId,
        reason,
        status: outcome.status,
        ms: outcome.latencyMs,
        candidate_count: candidates.length,
      },
      'reranking unavailable - keeping hybrid ordering',
    );
    return { hits, outcome: reason, latencyMs: outcome.latencyMs, candidateCount: candidates.length };
  }

  const ranking = outcome.value?.ranking;
  if (!isUsableRanking(ranking)) {
    // A 200 whose body is not an array of numbers. Nothing to apply.
    logger.warn(
      { request_id: requestId, candidate_count: candidates.length },
      'reranking returned an unusable ranking - keeping hybrid ordering',
    );
    return { hits, outcome: 'malformed', latencyMs: outcome.latencyMs, candidateCount: candidates.length };
  }

  /**
   * ⚠️ THE VALIDATION BOUNDARY, and it is total.
   *
   * `applyRanking` returns a permutation of 0..window.length-1 whatever the
   * model said. Out-of-range ordinals are dropped — that is where a fabricated
   * identifier arrives, as a number indexing nothing. Duplicates keep their
   * first occurrence. Candidates the model omitted keep their Phase 11 relative
   * order and follow the ranked ones, which matters because omission is normal:
   * asked to rank 10, the real deployment returned 4.
   */
  const order = applyRanking(ranking, window.length);
  const reordered = order.map((i) => window[i]!);

  return {
    // The tail beyond the rerank window keeps its Phase 11 position. Every row
    // that went in comes out, exactly once.
    hits: [...reordered, ...tail],
    outcome: 'reranked',
    latencyMs: outcome.latencyMs,
    candidateCount: candidates.length,
  };
}

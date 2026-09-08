import {
  SIMILAR_TICKETS_LIMIT,
  SIMILAR_TICKETS_MAX_LIMIT,
  type SimilarTicketsOutcome,
  type SimilarTicketsResponse,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';
import { logger } from '../logger.js';
import { embedQuery, type QueryEmbeddingOutcome } from '../retrieval/query-embedding.js';
import {
  currentTicketQueryText,
  findSimilarTickets,
  historicalCorpusSize,
} from './similar.repo.js';

/**
 * Similar Tickets — Phase 14.
 *
 *     current ticket -> its own subject+description -> query embedding
 *                    -> vector search over resolved/closed history
 *                    -> top N with resolution context
 *
 * ⚠️ READ-ONLY, AND IT DECIDES NOTHING. No write of any kind, no state
 * transition, no audit event — because nothing happened that is auditable.
 * Manufacturing one just to make the feature look governed would put noise in
 * an append-only compliance log.
 *
 * ⚠️ WHY VECTOR ONLY, AND NOT PHASE 11 HYBRID.
 *
 * Measured on the real corpus before choosing. The query here is a whole
 * ticket, not a search box:
 *
 *   - FTS scored 0.0000 for every candidate on a representative ticket, because
 *     no two historical subjects share content words.
 *   - Trigram compares whole strings, so a multi-sentence query against a short
 *     subject scores near zero — Phase 11 already established this and capped
 *     trigram to titles for exactly that reason.
 *   - Vector similarity is the signal that works: an exact precedent scores
 *     1.0000 against a 0.6864 runner-up, a clean 0.31 gap.
 *
 * Adding lexical strategies would contribute noise and latency to a ranking
 * they cannot inform. `retrieve -> rank -> return`, with no LLM in the path.
 *
 * ⚠️ AND NO RERANKING. Phase 12 measured no ranking improvement at ~1.75s cost,
 * and Phase 13 confirmed it. Reranking sees title + excerpt, which for these
 * tickets is the formulaic text that makes them hard to tell apart in the first
 * place — so it would pay the full latency to reorder on the least informative
 * view of the data. Left disabled; the decision is recorded in the phase notes
 * with its measurement rather than asserted here.
 */

export interface SimilarTicketsArgs {
  ticketId: string;
  limit?: number;
  /** Threads request -> core -> ai-service -> logs. Never the ticket text. */
  requestId: string;
  /**
   * Narrow to one customer tenant. Omitted for support staff, who serve the
   * whole product — matching `GET /admin/api/tickets`. See similar.repo.ts.
   */
  productTenantId?: string | null;
  /** Test seam. Production passes nothing and the real client is used. */
  embed?: (query: string, requestId: string) => Promise<QueryEmbeddingOutcome>;
}

/**
 * Find historical tickets similar to this one.
 *
 * NEVER THROWS for a provider problem, and never mutates anything. Every
 * failure returns an empty list with an outcome saying why — a support user
 * opening a ticket must not see an error because an optional panel could not
 * reach Azure.
 */
export async function findSimilar(
  tx: Tx,
  args: SimilarTicketsArgs,
): Promise<SimilarTicketsResponse | null> {
  const started = Date.now();
  const limit = Math.min(Math.max(args.limit ?? SIMILAR_TICKETS_LIMIT, 1), SIMILAR_TICKETS_MAX_LIMIT);

  /**
   * The current ticket is read UNDER THE CALLER'S SCOPE. If RLS does not permit
   * it, this returns null and the route 404s — so an unauthorized ticket id
   * cannot even be used to probe whether it exists.
   */
  const current = await currentTicketQueryText(tx, args.ticketId);
  if (!current) return null;

  const empty = (outcome: SimilarTicketsOutcome, embedMs: number | null, corpus: number) => ({
    items: [],
    diagnostics: {
      corpus,
      returned: 0,
      embed_ms: embedMs,
      retrieval_ms: Date.now() - started,
      rerank_ms: null,
      outcome,
    },
  });

  const corpus = await historicalCorpusSize(tx, {
    // ⚠️ The product comes from the TICKET ROW, never from the caller's
    // request. A caller cannot ask for similarity within someone else's
    // product, because they cannot name the product at all.
    productId: current.productId,
    excludeTicketId: args.ticketId,
    productTenantId: args.productTenantId ?? null,
  });

  if (corpus === 0) return empty('no_corpus', null, 0);

  // A ticket with no usable text cannot be compared to anything, and must not
  // cost a provider call to discover that.
  if (current.text.trim().length < 2) return empty('no_query_text', null, corpus);

  /**
   * The current ticket is usually OPEN, so it has no stored embedding — Phase
   * 10 only embeds resolved and closed tickets. Its text is embedded at query
   * time through the SAME signed client Phase 11 uses. No second embedding
   * path, no second provider, no new credential.
   */
  const embedder = args.embed ?? embedQuery;
  const embedded = await embedder(current.text, args.requestId);

  if (!embedded.ok) {
    /**
     * Timeout, 429, 5xx, unreachable, no credential and a malformed vector all
     * mean the same thing here: the panel has nothing to show. The ticket is
     * untouched and the rest of the page is unaffected.
     */
    logger.warn(
      { request_id: args.requestId, reason: embedded.reason, ms: embedded.latencyMs },
      'similar tickets: query embedding unavailable',
    );
    return empty('embedding_unavailable', embedded.latencyMs, corpus);
  }

  const items = await findSimilarTickets(tx, {
    vector: embedded.vector,
    productId: current.productId,
    excludeTicketId: args.ticketId,
    limit,
    productTenantId: args.productTenantId ?? null,
  });

  return {
    items,
    diagnostics: {
      corpus,
      returned: items.length,
      embed_ms: embedded.latencyMs,
      retrieval_ms: Date.now() - started,
      rerank_ms: null,
      outcome: 'ok',
    },
  };
}

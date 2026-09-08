import {
  CANDIDATES_PER_STRATEGY,
  MAX_RESULTS,
  candidateKey,
  compareHits,
  fuseRankings,
  isSearchableQuery,
  looksLikeReference,
  normalizeQuery,
  parseCandidateKey,
  type RerankOutcome,
  type RetrievalHit,
  type StrategyName,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';
import { logger } from '../logger.js';
import { embedQuery, type QueryEmbeddingOutcome } from './query-embedding.js';
import { rerank, type RerankFn } from './rerank.client.js';
import {
  exactTicketByReference,
  ftsArticles,
  ftsTickets,
  trigramArticles,
  trigramTickets,
  vectorArticles,
  vectorTickets,
  type Candidate,
} from './hybrid.repo.js';

/**
 * Hybrid retrieval — Phase 11.
 *
 *     query -> normalise -> [exact] + FTS + trigram + vector
 *           -> merge/dedupe -> weighted RRF -> deterministic sort -> top-K
 *
 * ⚠️ IT RANKS. IT DOES NOT DECIDE. Nothing here writes, and nothing here can
 * reach priority, severity, status, assignment, routing or authorization. It
 * orders rows the caller was already permitted to see, and the permission is
 * enforced in SQL rather than by this file.
 *
 * ⚠️ EXACTLY ONE QUERY EMBEDDING PER SEARCH. Tickets and articles are two
 * corpora but one semantic question, so one vector serves both. Embedding twice
 * would double the cost and the latency of the slowest step to obtain the same
 * numbers.
 */

export interface HybridSearchArgs {
  productId: string;
  query: string;
  limit?: number;
  requestId: string;
  /** Test seam. Production passes nothing and the real client is used. */
  embed?: (query: string, requestId: string) => Promise<QueryEmbeddingOutcome>;
  /** Test seam for Phase 12 reranking. Production passes nothing. */
  rerankFn?: RerankFn;
}

export interface HybridSearchResult {
  hits: RetrievalHit[];
  /**
   * Bounded, non-sensitive diagnostics. Never the query text, never a vector,
   * never row content.
   */
  diagnostics: {
    normalized_length: number;
    fts: number;
    trigram: number;
    vector: number;
    exact: boolean;
    merged: number;
    returned: number;
    /** Strategies that failed or were unavailable, so degradation is visible. */
    degraded: StrategyName[];
    embed_latency_ms: number | null;
    /** Phase 12. `skipped_disabled` when reranking is off for the product. */
    rerank: RerankOutcome;
    rerank_ms: number | null;
    rerank_candidates: number;
    total_ms: number;
  };
}

export async function hybridSearch(
  tx: Tx,
  args: HybridSearchArgs,
): Promise<HybridSearchResult> {
  const started = Date.now();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), MAX_RESULTS);
  const query = normalizeQuery(args.query);
  const degraded: StrategyName[] = [];

  const empty = (embedMs: number | null): HybridSearchResult => ({
    hits: [],
    diagnostics: {
      normalized_length: query.length,
      fts: 0,
      trigram: 0,
      vector: 0,
      exact: false,
      merged: 0,
      returned: 0,
      degraded,
      embed_latency_ms: embedMs,
      rerank: 'skipped_too_few',
      rerank_ms: null,
      rerank_candidates: 0,
      total_ms: Date.now() - started,
    },
  });

  // An empty or one-character query retrieves NOTHING rather than everything.
  // No provider call, no scan: a blank search box must not cost an embedding.
  if (!isSearchableQuery(query)) return empty(null);

  /**
   * The query embedding runs CONCURRENTLY with the lexical strategies, not
   * before them. It is by far the slowest step (~350ms p50 against ~2ms for
   * FTS), so serialising would make every search wait for it even when it is
   * about to fail. Started here, awaited after the lexical work is already
   * done.
   */
  const embedder = args.embed ?? embedQuery;
  const embedding = embedder(query, args.requestId);

  /**
   * Exact identifier, first and separately.
   *
   * `ticket.search_tsv` is generated from subject+description and does NOT
   * include `reference`, so FTS cannot match a ticket by its own identifier —
   * measured, not assumed. This is a lookup on `UNIQUE (product_id, reference)`,
   * gated by a shape test so ordinary prose never triggers it.
   */
  const exact = looksLikeReference(query)
    ? await exactTicketByReference(tx, { productId: args.productId, reference: query })
    : null;

  /**
   * Per-strategy failure handling — and an honest account of its limits.
   *
   * `settle` turns a rejected strategy into an empty candidate list plus a
   * `degraded` entry, so the search answers with whatever did work and the
   * degradation is visible in diagnostics rather than inferred from a thin
   * result set.
   *
   * ⚠️ THAT ISOLATION IS REAL FOR THE VECTOR STRATEGY AND NOT FOR THE LEXICAL
   * ONES, because all three share ONE transaction.
   *
   * Verified directly: two concurrent queries on one pooled client, the first
   * raising `division by zero`, and the second came back
   * "current transaction is aborted, commands ignored until end of transaction
   * block". Postgres aborts the whole transaction on any error in it, so a SQL
   * failure in FTS genuinely cannot leave trigram running — and pretending
   * otherwise in a comment would be worse than the limitation.
   *
   * Giving each strategy its own connection would buy that isolation and cost
   * far more than it is worth: `withScope` sets the RLS GUCs per transaction,
   * so three connections means three scoped transactions per search and three
   * places for the scope to be set wrong.
   *
   * What this means in practice is narrow, because a SQL error here is not an
   * expected runtime condition. The queries are static and parameterised, and
   * malformed user input cannot produce one — `websearch_to_tsquery` parses
   * anything without raising, which 13 hostile-input tests assert. So the
   * failure modes that actually occur are:
   *
   *   provider down/slow  -> vector degrades, lexical answers      (isolated)
   *   database down       -> the whole request fails, safely       (not partial)
   *   malformed query     -> no error at all, just no matches
   *
   * `settle` therefore earns its place on the vector path, where failure is
   * genuinely independent, and is belt-and-braces on the other two.
   */
  const settle = async (
    name: StrategyName,
    work: Promise<Candidate[]>[],
  ): Promise<Candidate[]> => {
    const results = await Promise.allSettled(work);
    const ok: Candidate[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok.push(...r.value);
        continue;
      }

      /**
       * ⚠️ A LEXICAL FAILURE RETHROWS. It is NOT swallowed into an empty list.
       *
       * This was a real defect, caught by testing it rather than reasoning
       * about it. The original version logged the error and returned no
       * candidates, so a broken transaction produced a perfectly ordinary
       * EMPTY RESULT SET — and `ask()` then reported `suggested_action:
       * create_ticket` and recorded `answered: false` on the conversation, as
       * though the corpus genuinely had no answer. An infrastructure failure
       * was being presented to the user as a business outcome, and nothing
       * anywhere said the search had not run.
       *
       * Failing loudly is the honest option: the route's error handler returns
       * a safe envelope, and the widget shows an error instead of quietly
       * sending someone to the ticket form on a lie.
       *
       * There is nothing to lose by rethrowing, either. All three strategies
       * share ONE transaction, and Postgres aborts a transaction on any error
       * inside it — verified: the concurrent sibling of a failing query returns
       * "current transaction is aborted". So a surviving lexical strategy is
       * not available to fall back to even in principle.
       */
      logger.error(
        { strategy: name, request_id: args.requestId, err: message(r.reason) },
        'retrieval strategy failed',
      );
      throw r.reason;
    }

    /**
     * MERGE THE TWO SOURCE LISTS BY SCORE, then let position become rank.
     *
     * Each strategy queries tickets and articles separately, so it produces two
     * independently ordered lists. Simply concatenating them gave EVERY ticket
     * a better rank than EVERY article regardless of score, and RRF then fused
     * a ranking the strategy never actually produced.
     *
     * That was not theoretical. Observed live before this fix, for the query
     * "password reset": the KB article "How to reset your password" had cosine
     * similarity 1.0 - the query vector WAS its embedding - and was assigned
     * vector rank 3, because two lower-scoring tickets had been concatenated
     * ahead of it. The bias ran one way, toward tickets, on every strategy at
     * once.
     *
     * Scores are only ever compared WITHIN one strategy here, never across
     * them; comparing ts_rank to cosine similarity is exactly what rank fusion
     * exists to avoid.
     *
     * The `candidateKey` tiebreak makes the order total: identical text in two
     * products produces identical scores, so ties are guaranteed rather than
     * hypothetical.
     */
    ok.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ka = candidateKey(a.source_type, a.source_id);
      const kb = candidateKey(b.source_type, b.source_id);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return ok;
  };

  const [fts, trigram] = await Promise.all([
    settle('fts', [
      ftsTickets(tx, { productId: args.productId, query }),
      ftsArticles(tx, { productId: args.productId, query }),
    ]),
    settle('trigram', [
      trigramTickets(tx, { productId: args.productId, query }),
      trigramArticles(tx, { productId: args.productId, query }),
    ]),
  ]);

  // ── vector, if the provider answered ──────────────────────────────────
  const embedded = await embedding;
  let vector: Candidate[] = [];
  if (embedded.ok) {
    /**
     * The vector strategy is the ONE that may fail without failing the search,
     * so its errors are caught HERE rather than inside `settle`.
     *
     * Its failure is genuinely independent: the provider call happens outside
     * the transaction, and a bad vector is rejected before any SQL runs. If the
     * SQL itself fails, the transaction is aborted and the lexical results
     * already gathered are worthless anyway — so this catch degrades a
     * recoverable failure and cannot disguise an unrecoverable one, because
     * `settle` has already thrown by then.
     */
    try {
      vector = await settle('vector', [
        vectorTickets(tx, { productId: args.productId, vector: embedded.vector }),
        vectorArticles(tx, { productId: args.productId, vector: embedded.vector }),
      ]);
    } catch (err) {
      degraded.push('vector');
      logger.warn(
        { request_id: args.requestId, err: message(err) },
        'vector retrieval failed - answering with lexical results',
      );
    }
  } else {
    /**
     * ⚠️ THE FALLBACK. Timeout, 429, 5xx, unreachable, no credential and a
     * malformed vector all land here, and all mean the same thing on a
     * synchronous path: rank with the two lexical strategies and answer now.
     *
     * Search does NOT fail. A user searching during an Azure outage gets
     * lexical results, which is what IRIS returned before Phase 11 anyway.
     */
    degraded.push('vector');
    logger.warn(
      { request_id: args.requestId, reason: embedded.reason, ms: embedded.latencyMs },
      'query embedding unavailable — falling back to lexical retrieval',
    );
  }

  // ── merge and deduplicate ─────────────────────────────────────────────
  /**
   * Identity is `source_type + source_id`, never text. The corpus holds the
   * same 12 article titles in four products with byte-identical bodies;
   * deduplicating on text would collapse four tenants' rows into one. Scope
   * already prevents them meeting in a single result set, but an identity rule
   * that would be wrong if it did is not one to rely on.
   */
  const byKey = new Map<string, Candidate>();
  const ranked: Partial<Record<StrategyName, string[]>> = {};

  for (const [name, list] of [
    ['fts', fts],
    ['trigram', trigram],
    ['vector', vector],
  ] as const) {
    const keys: string[] = [];
    for (const c of list) {
      const key = candidateKey(c.source_type, c.source_id);
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, c);
      // Keep the similarity wherever it came from — only the vector strategy
      // produces one, and it is the most useful thing in the signals.
      else if (c.similarity !== undefined && existing.similarity === undefined) {
        existing.similarity = c.similarity;
      }
      keys.push(key);
    }
    ranked[name] = keys;
  }

  const fused = fuseRankings(ranked);

  let hits: RetrievalHit[] = [];
  for (const [key, { score, ranks }] of fused) {
    const candidate = byKey.get(key);
    if (!candidate) continue;
    const { sourceType, sourceId } = parseCandidateKey(key);
    hits.push({
      source_type: sourceType,
      source_id: sourceId,
      title: candidate.title,
      snippet: candidate.snippet,
      hybrid_score: round4(score),
      signals: {
        ...(ranks.fts !== undefined ? { fts: ranks.fts } : {}),
        ...(ranks.trigram !== undefined ? { trigram: ranks.trigram } : {}),
        ...(ranks.vector !== undefined ? { vector: ranks.vector } : {}),
        ...(candidate.similarity !== undefined
          ? { similarity: round4(candidate.similarity) }
          : {}),
      },
    });
  }

  hits.sort(compareHits);

  /**
   * ── PHASE 12: RERANKING ────────────────────────────────────────────────
   *
   * Runs on the Phase 11 ordering, BEFORE the exact-identifier pin below.
   *
   * ⚠️ THAT ORDER IS THE WHOLE GUARANTEE FOR THE EXACT MATCH. The pinned row
   * is not in `hits` yet, so the model never sees it and therefore cannot
   * demote it — which is a stronger statement than "we re-pin it afterwards",
   * because it does not depend on the re-pinning being correct. Exact identity
   * is a Core business rule and stays entirely outside the model's reach.
   *
   * ⚠️ IT CANNOT MAKE SEARCH WORSE THAN PHASE 11. `rerank` never throws, never
   * changes the SET of rows, and returns the input order unchanged on every
   * failure path. The only cost of a broken provider is latency, and that is
   * bounded by RERANK_TIMEOUT_MS.
   */
  const reranker = args.rerankFn ?? rerank;
  const reranked = await reranker(query, hits, args.requestId);
  hits = reranked.hits;

  /**
   * ⚠️ THE EXACT MATCH IS PINNED, NOT SCORED.
   *
   * An equality on a unique key is a certainty, and no similarity can be more
   * certain than that — so it takes position 1 outright rather than receiving a
   * weight tuned until it happened to win. That is the difference between a
   * derived behaviour and a magic number.
   *
   * It is spliced in AFTER sorting, and any ranked copy of the same row is
   * removed first so the pin cannot duplicate it.
   */
  let final = hits;
  if (exact) {
    const exactKey = candidateKey(exact.source_type, exact.source_id);
    const rankedCopy = hits.find(
      (h) => candidateKey(h.source_type, h.source_id) === exactKey,
    );
    final = [
      {
        source_type: exact.source_type,
        source_id: exact.source_id,
        title: exact.title,
        snippet: exact.snippet,
        hybrid_score: 1,
        signals: { ...(rankedCopy?.signals ?? {}), exact: true },
      },
      ...hits.filter((h) => candidateKey(h.source_type, h.source_id) !== exactKey),
    ];
  }

  const returned = final.slice(0, limit);

  return {
    hits: returned,
    diagnostics: {
      normalized_length: query.length,
      fts: fts.length,
      trigram: trigram.length,
      vector: vector.length,
      exact: exact !== null,
      merged: byKey.size + (exact && !byKey.has(candidateKey(exact.source_type, exact.source_id)) ? 1 : 0),
      returned: returned.length,
      degraded,
      embed_latency_ms: embedded.latencyMs,
      rerank: reranked.outcome,
      rerank_ms: reranked.latencyMs,
      rerank_candidates: reranked.candidateCount,
      total_ms: Date.now() - started,
    },
  };
}

/**
 * Four decimal places, which is enough to order results and few enough that the
 * value is stable across platforms. Float noise in the 15th digit would make
 * otherwise-identical rankings compare unequal in tests.
 */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { CANDIDATES_PER_STRATEGY };

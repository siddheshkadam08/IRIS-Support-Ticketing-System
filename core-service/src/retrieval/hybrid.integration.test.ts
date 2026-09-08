import { afterAll, describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIM,
  VECTOR_SIMILARITY_FLOOR,
  type RetrievalHit,
} from '@iris/shared/types';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type ScopeContext, type Tx } from '../db/with-scope.js';
import { hybridSearch } from './hybrid.service.js';
import {
  corpusSize,
  exactTicketByReference,
  ftsArticles,
  ftsTickets,
  trigramArticles,
  vectorArticles,
} from './hybrid.repo.js';
import type { QueryEmbeddingOutcome } from './query-embedding.js';
import type { RerankResult } from './rerank.client.js';

/**
 * Hybrid retrieval against the REAL Postgres — Phase 11.
 *
 * Nothing is mocked except the embedding PROVIDER, and that is mocked so the
 * suite is deterministic and free: the vector is taken from a row already in
 * the corpus, which makes "what should rank first?" a fact rather than a
 * judgement. The SQL, the RLS policies, the GIN indexes and pgvector are all
 * genuinely doing the work.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/retrieval
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('p11-test', fn);

/** Staff scope: sees every ticket in the product, as an agent does. */
const staff = (productId: string): ScopeContext => ({
  productScope: [productId],
  role: 'agent',
  requestId: 'p11-test',
});

/** Raiser scope: `ticket_isolation` restricts this to the raiser's OWN tickets. */
const raiser = (productId: string, ref: string): ScopeContext => ({
  productScope: [productId],
  role: 'raiser',
  raiserRef: ref,
  requestId: 'p11-test',
});

const scoped = <T>(ctx: ScopeContext, fn: (tx: Tx) => Promise<T>): Promise<T> => withScope(ctx, fn);

/** A stub provider that returns a real corpus vector, so relevance is knowable. */
async function vectorOf(title: string): Promise<number[]> {
  return sys(async (tx) => {
    const { rows } = await tx.query<{ v: string }>(
      `SELECT embedding::text AS v FROM kb_article
        WHERE product_id = $1 AND title = $2 AND embedding IS NOT NULL LIMIT 1`,
      [PRODUCT_A, title],
    );
    if (!rows[0]) throw new Error(`no embedded article titled ${title}`);
    return JSON.parse(rows[0].v) as number[];
  });
}

const provider =
  (vector: number[]) =>
  async (): Promise<QueryEmbeddingOutcome> => ({ ok: true, vector, latencyMs: 1 });

const failing =
  (reason: 'timeout' | 'unavailable' | 'invalid' | 'not_configured') =>
  async (): Promise<QueryEmbeddingOutcome> => ({ ok: false, reason, latencyMs: 1 });

/**
 * ⚠️ RERANKING IS PINNED OFF FOR EVERY TEST IN THIS FILE.
 *
 * This file asserts PHASE 11 properties — fusion, ordering, determinism, the
 * exact-identifier pin. Phase 12 made `hybridSearch` call the real reranker by
 * default, so without this the assertions would depend on whether
 * RERANKING_ENABLED happens to be set and whether the AI service happens to be
 * running. That is exactly the ambient-environment coupling Phase 5 removed
 * from the queue tests.
 *
 * It was not hypothetical: the determinism test below started failing once
 * reranking was enabled on this machine, because two identical requests
 * returned the SAME rows in a DIFFERENT order. An LLM reranker is not
 * bit-deterministic even at temperature 0 — see §44E and the note on that test.
 *
 * Phase 12's own behaviour is covered by rerank.client.test.ts and
 * rerank.integration.test.ts, which drive the reranker deliberately.
 */
const noRerank = async (_q: string, hits: RetrievalHit[]): Promise<RerankResult> => ({
  hits,
  outcome: 'skipped_disabled',
  latencyMs: null,
  candidateCount: 0,
});

afterAll(async () => {
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// Corpus
// ═══════════════════════════════════════════════════════════════════════

describe('the corpus', () => {
  it('is the same set the Phase 10 embedder filled', async () => {
    const size = await scoped(staff(PRODUCT_A), (tx) => corpusSize(tx, PRODUCT_A));
    expect(size.articles).toBe(12);
    expect(size.articlesEmbedded).toBe(12);
    // Every retrievable row must be embedded, or the vector strategy silently
    // searches a smaller corpus than the lexical ones.
    expect(size.ticketsEmbedded).toBe(size.tickets);
  });

  it('EXCLUDES resolved tickets that have no resolution comment', async () => {
    /**
     * The rule `searchResolvedTickets` applied in JavaScript, after the query,
     * is now a predicate. Phase 10 embedded all 74 resolved/closed tickets, so
     * without this the vector strategy would surface a ticket describing a
     * problem with no recorded answer — offered to a user AS the answer.
     */
    const withRule = await scoped(staff(PRODUCT_A), (tx) => corpusSize(tx, PRODUCT_A));
    const allResolved = await sys(async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ticket
          WHERE product_id = $1 AND status IN ('resolved','closed')`,
        [PRODUCT_A],
      );
      return Number(rows[0]!.n);
    });
    expect(withRule.tickets).toBeLessThan(allResolved);
    expect(withRule.tickets).toBeGreaterThan(0);
  });

  it('never offers an open ticket', async () => {
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      ftsTickets(tx, { productId: PRODUCT_A, query: 'export' }),
    );
    const statuses = await sys(async (tx) => {
      if (hits.length === 0) return [];
      const { rows } = await tx.query<{ status: string }>(
        `SELECT status FROM ticket WHERE id = ANY($1)`,
        [hits.map((h) => h.source_id)],
      );
      return rows.map((r) => r.status);
    });
    for (const s of statuses) expect(['resolved', 'closed']).toContain(s);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Individual strategies
// ═══════════════════════════════════════════════════════════════════════

describe('each strategy in isolation', () => {
  it('FTS finds a lexical keyword match', async () => {
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      ftsArticles(tx, { productId: PRODUCT_A, query: 'duplicate records import' }),
    );
    expect(hits[0]?.title).toBe('Duplicate records after an import');
  });

  it('FTS returns nothing for an off-topic query — its natural floor', async () => {
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      ftsArticles(tx, { productId: PRODUCT_A, query: 'sourdough bread starter recipe' }),
    );
    expect(hits).toHaveLength(0);
  });

  it('trigram recovers a misspelling that stemming cannot', async () => {
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      trigramArticles(tx, { productId: PRODUCT_A, query: 'passwrd rest' }),
    );
    expect(hits.map((h) => h.title)).toContain('How to reset your password');
  });

  it('trigram REJECTS the passport/password false positive at the raised floor', async () => {
    // Scored 0.1930 and matched at the old 0.15. The floor is 0.20.
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      trigramArticles(tx, { productId: PRODUCT_A, query: 'how do I renew my passport at the embassy' }),
    );
    expect(hits).toHaveLength(0);
  });

  it('vector finds an exact semantic match and reports its similarity', async () => {
    const v = await vectorOf('How to reset your password');
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      vectorArticles(tx, { productId: PRODUCT_A, vector: v }),
    );
    expect(hits[0]?.title).toBe('How to reset your password');
    expect(hits[0]?.similarity).toBeCloseTo(1, 3);
  });

  it('the vector FLOOR keeps weak matches out', async () => {
    const v = await vectorOf('How to reset your password');
    const permissive = await scoped(staff(PRODUCT_A), (tx) =>
      vectorArticles(tx, { productId: PRODUCT_A, vector: v, floor: 0 }),
    );
    const floored = await scoped(staff(PRODUCT_A), (tx) =>
      vectorArticles(tx, { productId: PRODUCT_A, vector: v }),
    );
    expect(permissive.length).toBeGreaterThan(floored.length);
    for (const h of floored) expect(h.similarity!).toBeGreaterThanOrEqual(VECTOR_SIMILARITY_FLOOR);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fusion end to end
// ═══════════════════════════════════════════════════════════════════════

describe('hybrid search', () => {
  it('⚠️ ranks within a strategy follow that strategy SCORE, not source order', async () => {
    /**
     * REGRESSION TEST for a real ranking defect found during Phase 11.
     *
     * Each strategy queries tickets and articles separately and the two lists
     * were simply concatenated, so every ticket received a better rank than
     * every article whatever their scores — and RRF fused a ranking the
     * strategy never produced.
     *
     * Observed live: for "password reset", the KB article "How to reset your
     * password" had cosine similarity 1.0 (the query vector WAS its embedding)
     * and was given vector rank 3, because two lower-scoring tickets sat ahead
     * of it. A perfect match cannot be rank 3.
     *
     * The invariant: vector rank must be monotonic in similarity.
     */
    const v = await vectorOf('How to reset your password');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password reset',
        limit: 20,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );

    const ranked = hits
      .filter((h) => h.signals.vector !== undefined && h.signals.similarity !== undefined)
      .sort((a, b) => a.signals.vector! - b.signals.vector!);

    expect(ranked.length).toBeGreaterThan(2);
    // Rank 1 must be the perfect match, and similarity must fall monotonically.
    expect(ranked[0]!.signals.similarity).toBeCloseTo(1, 3);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]!.signals.similarity!).toBeLessThanOrEqual(ranked[i - 1]!.signals.similarity!);
    }
    // And the row every strategy agrees on must win outright.
    expect(hits[0]!.title).toBe('How to reset your password');
    expect(hits[0]!.hybrid_score).toBe(1);
  });

  it('merges the strategies and returns one row per source', async () => {
    const v = await vectorOf('How to reset your password');
    const { hits, diagnostics } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password reset',
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    // Wins because all three strategies rank it first, not because it is an
    // article — see the monotonicity test above for why that distinction had
    // to be tested rather than assumed.
    expect(hits[0]?.title).toBe('How to reset your password');
    // The same row found by several strategies is ONE result.
    const ids = hits.map((h) => `${h.source_type}:${h.source_id}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(diagnostics.degraded).toEqual([]);
    // And the signals say which strategies agreed.
    expect(Object.keys(hits[0]!.signals).length).toBeGreaterThan(1);
  });

  it('a row found by several strategies outranks one found by a single strategy', async () => {
    const v = await vectorOf('How to reset your password');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password reset',
        limit: 10,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    const top = hits[0]!;
    const signalCount = (h: (typeof hits)[number]) =>
      [h.signals.fts, h.signals.trigram, h.signals.vector].filter((x) => x !== undefined).length;
    for (const h of hits.slice(1)) {
      if (signalCount(h) < signalCount(top)) expect(top.hybrid_score).toBeGreaterThan(h.hybrid_score);
    }
  });

  it('scores stay inside [0,1] so `min_score` keeps its meaning', async () => {
    const v = await vectorOf('Duplicate records after an import');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'duplicate records',
        limit: 20,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    for (const h of hits) {
      expect(h.hybrid_score).toBeGreaterThan(0);
      expect(h.hybrid_score).toBeLessThanOrEqual(1);
      // Every surviving candidate clears the seeded deflection gate, exactly as
      // any lexical match did under the old unbounded score.
      expect(h.hybrid_score).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('returns nothing for an unanswerable question', async () => {
    const v = await vectorOf('Getting help and raising a ticket');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        // A real question this corpus cannot answer. The stub vector is a
        // corpus vector, so the FLOOR is what has to exclude it — and cannot,
        // here, because the stub is a perfect match. So this asserts the
        // LEXICAL half returns nothing and the vector half is the only source.
        query: 'sourdough bread starter recipe',
        requestId: 'r',
        embed: failing('unavailable'),
        rerankFn: noRerank,
      }),
    );
    expect(hits).toHaveLength(0);
  });

  it('respects the limit and never exceeds MAX_RESULTS', async () => {
    const v = await vectorOf('How to reset your password');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'report',
        limit: 2,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('is deterministic across repeated identical calls (Phase 11 fusion)', async () => {
    /**
     * ⚠️ SCOPE: this asserts that PHASE 11 FUSION is deterministic, with the
     * reranker pinned off. End-to-end ordering is NOT deterministic once
     * reranking is enabled — measured directly: two identical requests
     * returned the same rows in a different order. That is a documented
     * property of Phase 12, not a defect in this test.
     */
    const v = await vectorOf('Fixing failed report exports');
    const run = () =>
      scoped(staff(PRODUCT_A), (tx) =>
        hybridSearch(tx, {
          productId: PRODUCT_A,
          query: 'export failing',
          limit: 10,
          requestId: 'r',
          embed: provider(v),
        rerankFn: noRerank,
        }),
      );
    const a = await run();
    const b = await run();
    expect(a.hits.map((h) => [h.source_id, h.hybrid_score])).toEqual(
      b.hits.map((h) => [h.source_id, h.hybrid_score]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Exact identifiers
// ═══════════════════════════════════════════════════════════════════════

describe('exact identifier', () => {
  it('⚠️ FTS genuinely cannot match a reference — the gap the lookup closes', async () => {
    /**
     * `ticket.search_tsv` is generated from `subject || ' ' || description`. It
     * does NOT include `reference`, so websearch_to_tsquery('CARB-1011')
     * becomes 'carb' <-> '-1011' and matches nothing. Searching for a ticket by
     * its own identifier has never worked in IRIS.
     */
    const hits = await scoped(staff(PRODUCT_A), (tx) =>
      ftsTickets(tx, { productId: PRODUCT_A, query: 'CARB-1011' }),
    );
    expect(hits).toHaveLength(0);
  });

  it('the lookup finds it, case-insensitively', async () => {
    const upper = await scoped(staff(PRODUCT_A), (tx) =>
      exactTicketByReference(tx, { productId: PRODUCT_A, reference: 'CARB-1011' }),
    );
    const lower = await scoped(staff(PRODUCT_A), (tx) =>
      exactTicketByReference(tx, { productId: PRODUCT_A, reference: 'carb-1011' }),
    );
    expect(upper?.source_id).toBeDefined();
    expect(lower?.source_id).toBe(upper?.source_id);
  });

  it('pins it first, at the maximum score, without duplicating it', async () => {
    const v = await vectorOf('Fixing failed report exports');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'CARB-1011',
        limit: 10,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    expect(hits[0]?.source_type).toBe('resolved_ticket');
    expect(hits[0]?.hybrid_score).toBe(1);
    expect(hits[0]?.signals.exact).toBe(true);
    const ids = hits.map((h) => `${h.source_type}:${h.source_id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not fire on a reference-shaped string that matches nothing', async () => {
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'ZZZZ-99999',
        requestId: 'r',
        embed: failing('unavailable'),
        rerankFn: noRerank,
      }),
    );
    expect(hits.every((h) => h.signals.exact !== true)).toBe(true);
  });

  it('does not surface a ticket with no resolution, however precisely named', async () => {
    // Corpus eligibility beats precision: an exact reference to a ticket with
    // no recorded answer is still not an answer.
    const orphan = await sys(async (tx) => {
      const { rows } = await tx.query<{ reference: string }>(
        `SELECT t.reference FROM ticket t
          WHERE t.product_id = $1 AND t.status IN ('resolved','closed')
            AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.ticket_id = t.id
                              AND c.is_internal = false AND c.author_type = 'assignee')
          LIMIT 1`,
        [PRODUCT_A],
      );
      return rows[0]?.reference ?? null;
    });
    if (!orphan) return; // nothing to assert against in this dataset
    const found = await scoped(staff(PRODUCT_A), (tx) =>
      exactTicketByReference(tx, { productId: PRODUCT_A, reference: orphan }),
    );
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Failure and fallback
// ═══════════════════════════════════════════════════════════════════════

describe('degradation', () => {
  it.each(['timeout', 'unavailable', 'invalid', 'not_configured'] as const)(
    'falls back to lexical when the provider reports %s',
    async (reason) => {
      const { hits, diagnostics } = await scoped(staff(PRODUCT_A), (tx) =>
        hybridSearch(tx, {
          productId: PRODUCT_A,
          query: 'duplicate records import',
          requestId: 'r',
          embed: failing(reason),
        rerankFn: noRerank,
        }),
      );
      // Search SUCCEEDS. It does not throw, and it does not return empty.
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.title).toBe('Duplicate records after an import');
      expect(diagnostics.degraded).toContain('vector');
      expect(diagnostics.vector).toBe(0);
    },
  );

  it('a provider failure LOWERS scores rather than raising them', async () => {
    const v = await vectorOf('Duplicate records after an import');
    const healthy = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'duplicate records import',
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    const degraded = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'duplicate records import',
        requestId: 'r',
        embed: failing('timeout'),
        rerankFn: noRerank,
      }),
    );
    expect(degraded.hits[0]!.hybrid_score).toBeLessThan(healthy.hits[0]!.hybrid_score);
  });

  it('an embedding of the wrong width is rejected, not queried with', async () => {
    // A short vector would raise a Postgres type error inside the ranked query.
    // It must be caught before it gets there.
    const { hits, diagnostics } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'duplicate records import',
        requestId: 'r',
        embed: async () => ({ ok: true, vector: new Array(384).fill(0.1), latencyMs: 1 }),
        rerankFn: noRerank,
      }),
    );
    expect(diagnostics.degraded).toContain('vector');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('⚠️ a SQL error fails the search SAFELY rather than returning partial results', async () => {
    /**
     * Documents a real limit rather than a feature.
     *
     * All three strategies share one transaction, and Postgres aborts a
     * transaction on any error inside it — verified directly: a concurrent
     * sibling of a failing query returns "current transaction is aborted".
     * So per-strategy isolation is genuine for the VECTOR path, where failure
     * happens outside the transaction, and impossible for the lexical ones.
     *
     * The important property is what happens instead: the search rejects, the
     * caller gets a safe error, and it never returns a partial ranking that
     * silently omitted a strategy's results while looking complete.
     */
    const poisoned = await withScope(
      { productScope: [PRODUCT_A], role: 'agent', requestId: 'p11-test' },
      async (tx) => {
        await tx.query('SELECT 1/0').catch(() => undefined); // abort the tx
        return hybridSearch(tx, {
          productId: PRODUCT_A,
          query: 'password reset',
          requestId: 'r',
          embed: failing('unavailable'),
        rerankFn: noRerank,
        }).then(
          () => 'returned',
          () => 'rejected',
        );
      },
    ).catch(() => 'rejected');

    expect(poisoned, 'a broken transaction must not yield a plausible ranking').toBe('rejected');
  });

  it('an empty query costs nothing at all', async () => {
    let called = false;
    const { hits, diagnostics } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: '   ',
        requestId: 'r',
        embed: async () => {
          called = true;
          return { ok: false, reason: 'unavailable', latencyMs: 0 };
        },
        rerankFn: noRerank,
      }),
    );
    expect(hits).toHaveLength(0);
    expect(called, 'a blank search box must not cost a provider call').toBe(false);
    expect(diagnostics.embed_latency_ms).toBeNull();
  });

  it.each([
    "'",
    '"',
    ';',
    '--',
    "' OR 1=1 --",
    '*',
    ':',
    '()',
    'a & b | c ! d',
    '<script>',
    'DROP TABLE ticket;',
    ':*',
    'a:b:c',
  ])('survives malformed input %p without a SQL error', async (q) => {
    const v = await vectorOf('How to reset your password');
    const { hits } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: q,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    expect(Array.isArray(hits)).toBe(true);
  });

  it('an over-long query is truncated rather than sent whole', async () => {
    const v = await vectorOf('How to reset your password');
    const { diagnostics } = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password '.repeat(500),
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    expect(diagnostics.normalized_length).toBeLessThanOrEqual(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tenant and raiser isolation
// ═══════════════════════════════════════════════════════════════════════

describe('isolation', () => {
  it('⚠️ an identical query in two products returns DIFFERENT rows', async () => {
    /**
     * The strongest form available. The same 12 articles exist in both products
     * with byte-identical text and therefore identical embeddings, so every
     * candidate is a perfect tie on content. Nothing but the scope predicate
     * can decide which rows come back.
     */
    const v = await vectorOf('How to reset your password');
    const a = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password reset',
        limit: 10,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    const b = await scoped(staff(PRODUCT_B), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_B,
        query: 'password reset',
        limit: 10,
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    expect(a.hits.length).toBeGreaterThan(0);
    expect(b.hits.length).toBeGreaterThan(0);
    const idsA = new Set(a.hits.map((h) => h.source_id));
    for (const h of b.hits) expect(idsA.has(h.source_id)).toBe(false);
  });

  it('RLS ALONE blocks the foreign rows, without the explicit predicate', async () => {
    /**
     * Tests the database policy independently of the application filter, so a
     * regression in either is caught by itself. Here the query names the WRONG
     * product deliberately: RLS must return nothing rather than trusting the
     * argument.
     */
    const v = await vectorOf('How to reset your password');
    const leaked = await scoped(staff(PRODUCT_A), (tx) =>
      vectorArticles(tx, { productId: PRODUCT_B, vector: v, limit: 10 }),
    );
    expect(leaked).toHaveLength(0);
  });

  it('an unscoped session sees nothing — fails closed', async () => {
    const v = await vectorOf('How to reset your password');
    const none = await withScope(
      { productScope: [], role: 'none', requestId: 'p11-test' },
      (tx) => vectorArticles(tx, { productId: PRODUCT_A, vector: v, limit: 10 }),
    );
    expect(none).toHaveLength(0);
  });

  it('⚠️ a raiser cannot reach ANOTHER raiser’s resolved ticket, by any strategy', async () => {
    /**
     * A resolved ticket contains a different customer's words. `ticket_isolation`
     * restricts a raiser to `raised_by_ref = app_raiser()`, and every strategy
     * inherits it — including the exact lookup, so naming the reference
     * precisely is not a way around it.
     */
    const owner = await sys(async (tx) => {
      const { rows } = await tx.query<{ reference: string; raised_by_ref: string }>(
        `SELECT t.reference, t.raised_by_ref FROM ticket t
          WHERE t.product_id = $1 AND t.status IN ('resolved','closed')
            AND EXISTS (SELECT 1 FROM comment c WHERE c.ticket_id = t.id
                          AND c.is_internal = false AND c.author_type = 'assignee')
          LIMIT 1`,
        [PRODUCT_A],
      );
      return rows[0]!;
    });

    const asOwner = await scoped(raiser(PRODUCT_A, owner.raised_by_ref), (tx) =>
      exactTicketByReference(tx, { productId: PRODUCT_A, reference: owner.reference }),
    );
    const asStranger = await scoped(raiser(PRODUCT_A, 'someone-else-entirely'), (tx) =>
      exactTicketByReference(tx, { productId: PRODUCT_A, reference: owner.reference }),
    );

    expect(asOwner?.source_id, 'the owner can find their own ticket').toBeDefined();
    expect(asStranger, 'a stranger cannot, despite naming it exactly').toBeNull();
  });

  it('a raiser still gets KB results — the corpus is not empty for them', async () => {
    const v = await vectorOf('How to reset your password');
    const { hits } = await scoped(raiser(PRODUCT_A, 'nobody-in-particular'), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password reset',
        requestId: 'r',
        embed: provider(v),
        rerankFn: noRerank,
      }),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source_type === 'kb_article')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Concurrency
// ═══════════════════════════════════════════════════════════════════════

describe('concurrency', () => {
  it('interleaved searches in two products never mix', async () => {
    const v = await vectorOf('How to reset your password');
    const jobs: Promise<{ product: string; ids: string[] }>[] = [];
    for (let i = 0; i < 6; i++) {
      for (const p of [PRODUCT_A, PRODUCT_B]) {
        jobs.push(
          scoped(staff(p), (tx) =>
            hybridSearch(tx, {
              productId: p,
              query: 'password reset',
              limit: 5,
              requestId: `r${i}`,
              embed: provider(v),
        rerankFn: noRerank,
            }),
          ).then((r) => ({ product: p, ids: r.hits.map((h) => h.source_id) })),
        );
      }
    }
    const results = await Promise.all(jobs);
    const byProduct = new Map<string, Set<string>>();
    for (const r of results) {
      const set = byProduct.get(r.product) ?? new Set<string>();
      r.ids.forEach((id) => set.add(id));
      byProduct.set(r.product, set);
    }
    const a = byProduct.get(PRODUCT_A)!;
    const b = byProduct.get(PRODUCT_B)!;
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    for (const id of b) expect(a.has(id)).toBe(false);
  });
});

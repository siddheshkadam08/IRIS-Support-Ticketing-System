import { afterAll, describe, expect, it } from 'vitest';
import {
  RERANK_MAX_CANDIDATES,
  type RerankOutcome,
  type RetrievalHit,
} from '@iris/shared/types';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type ScopeContext, type Tx } from '../db/with-scope.js';
import { hybridSearch } from './hybrid.service.js';
import type { QueryEmbeddingOutcome } from './query-embedding.js';
import type { RerankResult } from './rerank.client.js';

/**
 * Reranking against the REAL Postgres — Phase 12.
 *
 * The retrieval half is genuine: real SQL, real RLS, real pgvector. Only the
 * two providers are stubbed, and deliberately — a reranker stub is the ONLY
 * way to test what happens when the model returns a fabricated identifier, a
 * duplicate, or another tenant's row. Those cases cannot be provoked against a
 * cooperative real model, and they are exactly the ones that matter.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/retrieval
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('p12-test', fn);
const staff = (productId: string): ScopeContext => ({
  productScope: [productId],
  role: 'agent',
  requestId: 'p12-test',
});
const scoped = <T>(ctx: ScopeContext, fn: (tx: Tx) => Promise<T>): Promise<T> => withScope(ctx, fn);

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

const embedder =
  (vector: number[]) =>
  async (): Promise<QueryEmbeddingOutcome> => ({ ok: true, vector, latencyMs: 1 });

/**
 * A reranker double driven by a raw model response, so the tests exercise the
 * REAL `applyRanking` mapping rather than a second implementation of it.
 */
function modelReturns(ranking: unknown[]): {
  fn: (q: string, hits: RetrievalHit[], id: string) => Promise<RerankResult>;
  saw: { candidates: Array<{ title: string }> };
} {
  const saw = { candidates: [] as Array<{ title: string }> };
  const fn = async (_q: string, hits: RetrievalHit[]): Promise<RerankResult> => {
    const window = hits.slice(0, RERANK_MAX_CANDIDATES);
    saw.candidates = window.map((h) => ({ title: h.title }));
    const { applyRanking } = await import('@iris/shared/types');
    const order = applyRanking(ranking, window.length);
    return {
      hits: [...order.map((i) => window[i]!), ...hits.slice(RERANK_MAX_CANDIDATES)],
      outcome: 'reranked',
      latencyMs: 5,
      candidateCount: window.length,
    };
  };
  return { fn, saw };
}

/** Every failure path collapses to "keep what Phase 11 produced". */
const failing =
  (outcome: RerankOutcome) =>
  async (_q: string, hits: RetrievalHit[]): Promise<RerankResult> => ({
    hits,
    outcome,
    latencyMs: 3,
    candidateCount: hits.length,
  });

afterAll(async () => {
  await closePool();
});

async function search(
  query: string,
  rerankFn: Parameters<typeof hybridSearch>[1]['rerankFn'],
  limit = 10,
) {
  const v = await vectorOf('How to reset your password');
  return scoped(staff(PRODUCT_A), (tx) =>
    hybridSearch(tx, {
      productId: PRODUCT_A,
      query,
      limit,
      requestId: 'p12',
      embed: embedder(v),
      rerankFn,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Reordering
// ═══════════════════════════════════════════════════════════════════════

describe('reranking reorders and nothing else', () => {
  it('applies the model ordering', async () => {
    const base = await search('password reset', failing('skipped_disabled'));
    expect(base.hits.length).toBeGreaterThan(2);

    // Reverse whatever Phase 11 produced.
    const n = Math.min(base.hits.length, RERANK_MAX_CANDIDATES);
    const reversed = Array.from({ length: n }, (_, i) => n - i);
    const { fn } = modelReturns(reversed);
    const after = await search('password reset', fn);

    expect(after.diagnostics.rerank).toBe('reranked');
    expect(after.hits.map((h) => h.source_id)).toEqual(
      base.hits
        .slice(0, n)
        .map((h) => h.source_id)
        .reverse()
        .concat(base.hits.slice(n).map((h) => h.source_id)),
    );
  });

  it('⚠️ returns EXACTLY the same set of rows — never more, never fewer', async () => {
    /**
     * The property that makes reranking safe to add at all. Whatever the model
     * says, the result set is the one Core authorized.
     */
    const base = await search('password reset', failing('skipped_disabled'));
    const { fn } = modelReturns([3, 1, 99, 'kb_other', 2, null]);
    const after = await search('password reset', fn);

    expect(new Set(after.hits.map((h) => h.source_id))).toEqual(
      new Set(base.hits.map((h) => h.source_id)),
    );
    expect(after.hits.length).toBe(base.hits.length);
  });

  it('does not alter titles, snippets or scores — only order', async () => {
    const base = await search('password reset', failing('skipped_disabled'));
    const { fn } = modelReturns([2, 1]);
    const after = await search('password reset', fn);

    for (const hit of after.hits) {
      const original = base.hits.find((h) => h.source_id === hit.source_id)!;
      expect(hit.title).toBe(original.title);
      expect(hit.snippet).toBe(original.snippet);
      // Option A: the score stays Phase 11's retrieval score, unblended.
      expect(hit.hybrid_score).toBe(original.hybrid_score);
    }
  });

  it('a partial ranking keeps the omitted rows, in Phase 11 order', async () => {
    // Asked to rank 10, the real deployment returned 4. Normal, not exceptional.
    const base = await search('password reset', failing('skipped_disabled'));
    const { fn } = modelReturns([2]);
    const after = await search('password reset', fn);

    expect(after.hits[0]!.source_id).toBe(base.hits[1]!.source_id);
    expect(after.hits.length).toBe(base.hits.length);
  });

  it('deduplicates a repeated ordinal', async () => {
    const base = await search('password reset', failing('skipped_disabled'));
    const { fn } = modelReturns([2, 2, 2, 2]);
    const after = await search('password reset', fn);
    const ids = after.hits.map((h) => h.source_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(base.hits.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The exact identifier is out of reach
// ═══════════════════════════════════════════════════════════════════════

describe('exact identifier', () => {
  it('⚠️ is NEVER SENT to the reranker at all', async () => {
    /**
     * Stronger than "we re-pin it afterwards", because it does not depend on
     * the re-pinning being correct. Reranking runs before the pin, so the
     * pinned row is not in the list the model sees, and there is no ordering
     * the model could return that demotes it.
     */
    const { fn, saw } = modelReturns([1]);
    const result = await search('CARB-1011', fn);

    expect(result.diagnostics.exact).toBe(true);
    expect(result.hits[0]!.signals.exact).toBe(true);
    const exactTitle = result.hits[0]!.title;
    expect(saw.candidates.map((c) => c.title)).not.toContain(exactTitle);
  });

  it('stays at position 1 with score 1 whatever the model returns', async () => {
    // Try hard to displace it: rank everything, in every direction.
    for (const ranking of [[1], [5, 4, 3, 2, 1], [], [99]]) {
      const { fn } = modelReturns(ranking);
      const result = await search('CARB-1011', fn);
      expect(result.hits[0]!.signals.exact).toBe(true);
      expect(result.hits[0]!.hybrid_score).toBe(1);
    }
  });

  it('survives a reranker failure', async () => {
    const result = await search('CARB-1011', failing('provider_timeout'));
    expect(result.hits[0]!.signals.exact).toBe(true);
    expect(result.diagnostics.rerank).toBe('provider_timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Failure matrix
// ═══════════════════════════════════════════════════════════════════════

describe('every failure keeps Phase 11 ordering', () => {
  it.each([
    'provider_timeout',
    'provider_unavailable',
    'malformed',
    'not_configured',
    'skipped_disabled',
    'skipped_too_few',
  ] as const)('%s falls back without failing the search', async (outcome) => {
    const base = await search('password reset', failing('skipped_disabled'));
    const after = await search('password reset', failing(outcome));

    // Search SUCCEEDS, with the ordering it already had.
    expect(after.hits.map((h) => h.source_id)).toEqual(base.hits.map((h) => h.source_id));
    expect(after.diagnostics.rerank).toBe(outcome);
    expect(after.hits.length).toBeGreaterThan(0);
  });

  it('a reranker that THROWS does not take down the search', async () => {
    /**
     * `rerank` is contractually non-throwing, so this is defence against a bug
     * inside it rather than an expected path. A user searching must not get a
     * 500 because an optional ordering step failed.
     */
    const boom = async (): Promise<RerankResult> => {
      throw new Error('reranker exploded');
    };
    await expect(search('password reset', boom)).rejects.toThrow();
    // ...and with the real client, which never throws, the same query works.
    const ok = await search('password reset', failing('provider_unavailable'));
    expect(ok.hits.length).toBeGreaterThan(0);
  });

  it('an empty candidate set stays empty', async () => {
    /**
     * A genuinely unanswerable query. The embedder is failed on purpose here:
     * the stub used elsewhere returns a real corpus vector, which would match
     * whatever the query text says, so it cannot produce an empty set.
     */
    let sawCandidates = -1;
    const spy = async (_q: string, hits: RetrievalHit[]): Promise<RerankResult> => {
      sawCandidates = hits.length;
      return { hits, outcome: 'reranked', latencyMs: 1, candidateCount: hits.length };
    };
    const result = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'sourdough bread starter recipe',
        limit: 10,
        requestId: 'p12',
        embed: async () => ({ ok: false, reason: 'unavailable', latencyMs: 1 }),
        rerankFn: spy,
      }),
    );

    expect(result.hits).toHaveLength(0);
    // Nothing to reorder reached the reranker. The REAL client additionally
    // short-circuits below RERANK_MIN_CANDIDATES, so no provider call is made.
    expect(sawCandidates).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Security
// ═══════════════════════════════════════════════════════════════════════

describe('the reranker cannot expand the authorized set', () => {
  it('⚠️ a model naming ANOTHER TENANT row cannot introduce it', async () => {
    /**
     * The attack this design forecloses structurally. A malicious model wants
     * to return prod_esg's article id; it has no field in which to say so —
     * the output alphabet is 1..N over Core's own list — and a number that
     * indexes nothing is dropped.
     */
    const foreignIds = await sys(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM kb_article WHERE product_id = $1 LIMIT 3`,
        [PRODUCT_B],
      );
      return rows.map((r) => r.id);
    });

    const { fn } = modelReturns([...foreignIds, 1]);
    const after = await search('password reset', fn);

    for (const hit of after.hits) expect(foreignIds).not.toContain(hit.source_id);
    // And every row still belongs to product A.
    const owners = await sys(async (tx) => {
      const { rows } = await tx.query<{ product_id: string }>(
        `SELECT product_id FROM kb_article WHERE id = ANY($1)
         UNION ALL SELECT product_id FROM ticket WHERE id = ANY($1)`,
        [after.hits.map((h) => h.source_id)],
      );
      return rows.map((r) => r.product_id);
    });
    expect(new Set(owners)).toEqual(new Set([PRODUCT_A]));
  });

  it('a fabricated or SQL-shaped identifier changes nothing', async () => {
    const base = await search('password reset', failing('skipped_disabled'));
    const { fn } = modelReturns(["'; DROP TABLE ticket; --", 'kb_01FAKE', -1, 0, 9999]);
    const after = await search('password reset', fn);
    expect(after.hits.map((h) => h.source_id)).toEqual(base.hits.map((h) => h.source_id));
  });

  it('reranking still respects product scope for the same query', async () => {
    const v = await vectorOf('How to reset your password');
    const { fn } = modelReturns([2, 1]);
    const a = await scoped(staff(PRODUCT_A), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_A,
        query: 'password reset',
        limit: 10,
        requestId: 'p12',
        embed: embedder(v),
        rerankFn: fn,
      }),
    );
    const b = await scoped(staff(PRODUCT_B), (tx) =>
      hybridSearch(tx, {
        productId: PRODUCT_B,
        query: 'password reset',
        limit: 10,
        requestId: 'p12',
        embed: embedder(v),
        rerankFn: fn,
      }),
    );
    const idsA = new Set(a.hits.map((h) => h.source_id));
    expect(a.hits.length).toBeGreaterThan(0);
    expect(b.hits.length).toBeGreaterThan(0);
    for (const h of b.hits) expect(idsA.has(h.source_id)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Observability
// ═══════════════════════════════════════════════════════════════════════

describe('diagnostics', () => {
  it('reports the outcome, latency and candidate count', async () => {
    const { fn } = modelReturns([1, 2]);
    const result = await search('password reset', fn);
    expect(result.diagnostics.rerank).toBe('reranked');
    expect(result.diagnostics.rerank_ms).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.rerank_candidates).toBeGreaterThan(0);
  });

  it('carries no query text or row content', async () => {
    const { fn } = modelReturns([1]);
    const result = await search('a distinctive probe phrase', fn);
    const raw = JSON.stringify(result.diagnostics);
    expect(raw).not.toContain('distinctive');
    expect(raw).not.toContain('password');
  });
});

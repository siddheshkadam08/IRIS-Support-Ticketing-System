import { describe, expect, it } from 'vitest';
import {
  CANDIDATES_PER_STRATEGY,
  QUERY_MAX_CHARS,
  RRF_K,
  STRATEGY_WEIGHTS,
  TRIGRAM_SIMILARITY_FLOOR,
  VECTOR_SIMILARITY_FLOOR,
  candidateKey,
  compareHits,
  fuseRankings,
  isSearchableQuery,
  looksLikeReference,
  normalizeQuery,
  parseCandidateKey,
  type RetrievalHit,
} from './index.js';

/**
 * Hybrid ranking, as pure functions — Phase 11.
 *
 * The fusion is deliberately separable from SQL so its properties can be
 * asserted rather than inferred from end-to-end behaviour. The properties that
 * matter are all about things that fail SILENTLY if they are wrong:
 *
 *   BOUNDED       a score outside [0,1] would break `deflection.min_score`,
 *                 which every seeded product sets to 0.05 and which decides
 *                 whether the user is offered the ticket form.
 *   STABLE        identical text in two products produces identical ranks, so
 *                 ties are guaranteed here rather than hypothetical. Without a
 *                 total order the same query returns a different order each run.
 *   SCALE-FREE    a missing strategy must lower a row's score, never raise it.
 */

const hit = (over: Partial<RetrievalHit> = {}): RetrievalHit => ({
  source_type: 'kb_article',
  source_id: 'a',
  title: 't',
  snippet: 's',
  hybrid_score: 0.5,
  signals: {},
  ...over,
});

describe('query normalisation', () => {
  it('collapses every kind of whitespace run and trims', () => {
    expect(normalizeQuery('  export   \n\t failing  \r\n ')).toBe('export failing');
  });

  it('does NOT lowercase', () => {
    // Postgres folds case itself and the embedding model is case-aware in ways
    // that carry meaning. A second transformation here would only make the
    // query differ from the text it is compared against.
    expect(normalizeQuery('CARB-1011 Export')).toBe('CARB-1011 Export');
  });

  it('bounds the length', () => {
    expect(normalizeQuery('x'.repeat(5000))).toHaveLength(QUERY_MAX_CHARS);
  });

  it.each([undefined, null, 42, {}, [], true])('returns empty for a non-string (%p)', (bad) => {
    expect(normalizeQuery(bad)).toBe('');
  });

  it('treats empty and single characters as not searchable', () => {
    // A blank search box must not cost a provider call or a full scan.
    expect(isSearchableQuery(normalizeQuery(''))).toBe(false);
    expect(isSearchableQuery(normalizeQuery('   '))).toBe(false);
    expect(isSearchableQuery(normalizeQuery('a'))).toBe(false);
    expect(isSearchableQuery(normalizeQuery('ab'))).toBe(true);
  });

  it('leaves SQL-shaped and tsquery-shaped input alone', () => {
    // Nothing is escaped or stripped, because nothing needs to be: the value
    // is always a bound parameter and websearch_to_tsquery cannot raise a
    // syntax error on user text. Sanitising here would imply otherwise.
    expect(normalizeQuery("' OR 1=1 --")).toBe("' OR 1=1 --");
    expect(normalizeQuery('a & b | c ! (d)')).toBe('a & b | c ! (d)');
  });
});

describe('reference detection', () => {
  it.each(['CARB-1011', 'carb-1011', 'ESG-5', 'IFILE-123456'])('accepts %s', (r) => {
    expect(looksLikeReference(r)).toBe(true);
  });

  it.each([
    'export failing',
    'CARB-1011 export', // a reference PLUS words is a search, not a lookup
    '-1011',
    'CARB-',
    'CARB-abc',
    '',
    'a-1',
  ])('rejects %p', (r) => {
    expect(looksLikeReference(r)).toBe(false);
  });
});

describe('candidate identity', () => {
  it('round-trips and keeps the two corpora distinct', () => {
    const k = candidateKey('resolved_ticket', 'tkt_1');
    expect(parseCandidateKey(k)).toEqual({ sourceType: 'resolved_ticket', sourceId: 'tkt_1' });
    expect(k).not.toBe(candidateKey('kb_article', 'tkt_1'));
  });

  it('survives an id containing a colon', () => {
    // Splits on the FIRST colon only; the type prefix is a closed set.
    expect(parseCandidateKey(candidateKey('kb_article', 'kb:weird:id')).sourceId).toBe(
      'kb:weird:id',
    );
  });
});

describe('weighted RRF', () => {
  it('scores a row ranked first by EVERY strategy at exactly 1', () => {
    const f = fuseRankings({ fts: ['a'], trigram: ['a'], vector: ['a'] });
    expect(f.get('a')!.score).toBeCloseTo(1, 10);
  });

  it('scores a single-strategy top hit at that strategy weight', () => {
    // This is what keeps `min_score: 0.05` meaningful: the weakest possible
    // top hit still scores 0.2, comfortably above the gate, exactly as any
    // lexical match did under the old unbounded score.
    expect(fuseRankings({ vector: ['a'] }).get('a')!.score).toBeCloseTo(STRATEGY_WEIGHTS.vector, 10);
    expect(fuseRankings({ trigram: ['a'] }).get('a')!.score).toBeCloseTo(
      STRATEGY_WEIGHTS.trigram,
      10,
    );
  });

  it('never produces a score above 1 or below 0', () => {
    const many = Array.from({ length: CANDIDATES_PER_STRATEGY }, (_, i) => `d${i}`);
    for (const [, v] of fuseRankings({ fts: many, trigram: many, vector: many })) {
      expect(v.score).toBeGreaterThan(0);
      expect(v.score).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a row found by two strategies above one found by a better single rank', () => {
    // Agreement between independent signals is the whole point of fusion.
    const f = fuseRankings({ fts: ['b', 'a'], vector: ['b', 'c'] });
    expect(f.get('b')!.score).toBeGreaterThan(f.get('a')!.score);
    expect(f.get('b')!.score).toBeGreaterThan(f.get('c')!.score);
  });

  it('⚠️ a MISSING strategy lowers a score, never raises it', () => {
    /**
     * The denominator uses every DECLARED weight, not just the strategies that
     * answered. If a failed strategy shrank it, the same row would score higher
     * during an Azure outage than in normal operation — `min_score` would mean
     * something different depending on whether the provider was up, and nothing
     * would report it.
     */
    const all = fuseRankings({ fts: ['a'], trigram: ['a'], vector: ['a'] }).get('a')!.score;
    const degraded = fuseRankings({ fts: ['a'], trigram: ['a'] }).get('a')!.score;
    expect(degraded).toBeLessThan(all);
    expect(degraded).toBeCloseTo(STRATEGY_WEIGHTS.fts + STRATEGY_WEIGHTS.trigram, 10);
  });

  it('handles every strategy returning nothing', () => {
    expect(fuseRankings({ fts: [], trigram: [], vector: [] }).size).toBe(0);
    expect(fuseRankings({}).size).toBe(0);
  });

  it('records the rank each strategy gave', () => {
    const f = fuseRankings({ fts: ['x', 'a'], vector: ['a'] });
    expect(f.get('a')!.ranks).toEqual({ fts: 2, vector: 1 });
    expect(f.get('x')!.ranks).toEqual({ fts: 1 });
  });

  it('DEDUPLICATES within one strategy, keeping the better rank', () => {
    const f = fuseRankings({ fts: ['a', 'a'] });
    expect(f.get('a')!.ranks.fts).toBe(1);
    expect(f.get('a')!.score).toBeCloseTo(STRATEGY_WEIGHTS.fts, 10);
  });

  it('is deterministic — identical input, identical output', () => {
    const input = { fts: ['a', 'b'], trigram: ['b'], vector: ['c', 'a'] };
    const one = [...fuseRankings(input)].map(([k, v]) => [k, v.score]);
    const two = [...fuseRankings(input)].map(([k, v]) => [k, v.score]);
    expect(one).toEqual(two);
  });

  it('discriminates across the full candidate list at K=10', () => {
    /**
     * Why K is not 60. The paper's value is tuned for TREC runs of thousands of
     * documents; our lists hold at most 25. At K=60 rank 1 and rank 25 differ
     * by only 1/61 vs 1/85 — a 28% spread across the ENTIRE ranking, which
     * cannot separate a perfect hit from a marginal one.
     */
    const many = Array.from({ length: CANDIDATES_PER_STRATEGY }, (_, i) => `d${i}`);
    const f = fuseRankings({ fts: many });
    const first = f.get('d0')!.score;
    const last = f.get(`d${CANDIDATES_PER_STRATEGY - 1}`)!.score;
    expect(first / last).toBeGreaterThan(2.5);

    const flat = fuseRankings({ fts: many }, STRATEGY_WEIGHTS, 60);
    expect(flat.get('d0')!.score / flat.get(`d${CANDIDATES_PER_STRATEGY - 1}`)!.score).toBeLessThan(
      1.5,
    );
  });
});

describe('ordering is total and deterministic', () => {
  it('sorts by score descending', () => {
    const hits = [hit({ source_id: 'a', hybrid_score: 0.2 }), hit({ source_id: 'b', hybrid_score: 0.9 })];
    expect([...hits].sort(compareHits).map((h) => h.source_id)).toEqual(['b', 'a']);
  });

  it('⚠️ breaks ties on the composite key, so equal scores never reorder', () => {
    /**
     * Not hypothetical. The corpus holds the same 12 articles in four products
     * with identical text and therefore identical vectors and identical lexical
     * ranks, so exact ties are guaranteed. Without a tiebreak the same query
     * returns a different order run to run.
     */
    const a = hit({ source_type: 'kb_article', source_id: 'z', hybrid_score: 0.5 });
    const b = hit({ source_type: 'kb_article', source_id: 'a', hybrid_score: 0.5 });
    expect([a, b].sort(compareHits).map((h) => h.source_id)).toEqual(['a', 'z']);
    expect([b, a].sort(compareHits).map((h) => h.source_id)).toEqual(['a', 'z']);
  });

  it('separates the two corpora deterministically on an exact tie', () => {
    const t = hit({ source_type: 'resolved_ticket', source_id: 'x', hybrid_score: 0.5 });
    const k = hit({ source_type: 'kb_article', source_id: 'x', hybrid_score: 0.5 });
    expect([t, k].sort(compareHits).map((h) => h.source_type)).toEqual([
      'kb_article',
      'resolved_ticket',
    ]);
  });
});

describe('constants that encode a measurement', () => {
  it('pins the vector floor calibrated against relevant/irrelevant similarity', () => {
    // relevant top-1 0.425..0.513, irrelevant 0.084..0.217 — measured live.
    expect(VECTOR_SIMILARITY_FLOOR).toBe(0.3);
    expect(VECTOR_SIMILARITY_FLOOR).toBeGreaterThan(0.217);
    expect(VECTOR_SIMILARITY_FLOOR).toBeLessThan(0.425);
  });

  it('pins the trigram floor above the measured false-positive ceiling', () => {
    // "passport" vs "How to reset your password" scored 0.1930 at the old 0.15.
    expect(TRIGRAM_SIMILARITY_FLOOR).toBe(0.2);
    expect(TRIGRAM_SIMILARITY_FLOOR).toBeGreaterThan(0.193);
    expect(TRIGRAM_SIMILARITY_FLOOR).toBeLessThan(0.2222);
  });

  it('keeps the weights summing to 1, which is what bounds the score', () => {
    const total = Object.values(STRATEGY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('keeps K proportional to the candidate list, not to a TREC run', () => {
    expect(RRF_K).toBe(10);
    expect(RRF_K).toBeLessThan(CANDIDATES_PER_STRATEGY);
  });
});

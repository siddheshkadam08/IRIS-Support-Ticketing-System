import { describe, expect, it } from 'vitest';
import {
  AI_FEATURES,
  RERANKING_PROMPT_VERSION,
  RERANK_EXCERPT_CHARS,
  RERANK_MAX_CANDIDATES,
  RERANK_MIN_CANDIDATES,
  SUPPORTED_AI_FEATURES,
  applyRanking,
  isUsableRanking,
} from './index.js';

/**
 * The reranking rules, as pure functions — Phase 12.
 *
 * `applyRanking` is where a hostile or broken model meets Core, so almost every
 * test here is an attack or a malfunction rather than a happy path. The
 * property being defended is total:
 *
 *   WHATEVER THE MODEL RETURNS, THE OUTPUT IS A PERMUTATION OF 0..count-1.
 *
 * Not "usually", not "after validation" — by construction. No input can make it
 * produce an index that was not supplied, drop a candidate, or repeat one. That
 * is what makes "the reranker cannot expand the authorized result set" a
 * structural claim rather than a promise.
 */

/** The invariant asserted after every single case below. */
const isPermutation = (out: number[], count: number) =>
  out.length === count && new Set(out).size === count && out.every((i) => i >= 0 && i < count);

describe('applyRanking — the invariant holds for any input', () => {
  it('applies a complete ranking', () => {
    const out = applyRanking([3, 1, 2], 3);
    expect(out).toEqual([2, 0, 1]);
    expect(isPermutation(out, 3)).toBe(true);
  });

  it('⚠️ APPENDS what the model omitted, in Phase 11 order', () => {
    /**
     * Partial rankings are NORMAL, not exceptional. `[LIVE]` asked to rank 10
     * candidates, the real deployment returned `[1, 3, 6, 2]` — four of them.
     *
     * Dropping the rest would let a lazy or truncated response silently shrink
     * the result set, which looks like "search found less" rather than like a
     * provider quirk.
     */
    const out = applyRanking([1, 3], 5);
    expect(out).toEqual([0, 2, 1, 3, 4]);
    expect(isPermutation(out, 5)).toBe(true);
  });

  it('keeps Phase 11 order exactly when the model returns nothing', () => {
    expect(applyRanking([], 4)).toEqual([0, 1, 2, 3]);
  });

  describe('a fabricated identifier arrives as a number that indexes nothing', () => {
    const outOfRange: Array<[number[], string]> = [
      [[0], 'zero — ordinals are 1-based'],
      [[4], 'past the end'],
      [[999], 'far past the end'],
      [[-1], 'negative'],
      [[1.5], 'not an integer'],
    ];
    it.each(outOfRange)('drops %j (%s)', (ranking) => {
      const out = applyRanking(ranking, 3);
      expect(isPermutation(out, 3)).toBe(true);
      expect(out).toEqual([0, 1, 2]);
    });

    // Explicitly typed: heterogeneous tuples make `it.each` infer a union of
    // tuple types that does not match the callback arity.
    const nonOrdinals: Array<[unknown, string]> = [
      ['kb_01ABCDEF', 'a real-looking id'],
      ["'; DROP TABLE ticket; --", 'SQL-shaped'],
      [null, 'null'],
      [undefined, 'undefined'],
      [{ source_id: 'x' }, 'an object'],
      [['nested'], 'an array'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
    ];
    it.each(nonOrdinals)('ignores a non-ordinal value %p (%s)', (value) => {
      const out = applyRanking([value], 3);
      expect(isPermutation(out, 3)).toBe(true);
    });

    it('keeps the valid ordinals from a mixed hostile response', () => {
      // The realistic shape of an attack: a couple of real positions plus
      // whatever the attacker hoped would be dereferenced.
      const out = applyRanking([2, 'kb_other_tenant', 99, 1, null], 3);
      expect(out).toEqual([1, 0, 2]);
      expect(isPermutation(out, 3)).toBe(true);
    });
  });

  it('deduplicates, keeping the first occurrence', () => {
    const out = applyRanking([2, 2, 2, 1], 3);
    expect(out).toEqual([1, 0, 2]);
    expect(isPermutation(out, 3)).toBe(true);
  });

  it('survives a ranking far longer than the candidate set', () => {
    // A model that pads its output must not make the result set grow.
    const out = applyRanking(Array.from({ length: 500 }, (_, i) => (i % 3) + 1), 3);
    expect(isPermutation(out, 3)).toBe(true);
  });

  it('handles the degenerate counts', () => {
    expect(applyRanking([1], 1)).toEqual([0]);
    expect(applyRanking([1, 2], 0)).toEqual([]);
  });

  it('is deterministic', () => {
    const input = [3, 1, 9, 1, 2];
    expect(applyRanking(input, 4)).toEqual(applyRanking(input, 4));
  });
});

describe('response shape', () => {
  it('accepts an array of numbers', () => {
    expect(isUsableRanking([1, 2, 3])).toBe(true);
    expect(isUsableRanking([])).toBe(true);
  });

  it.each([undefined, null, 'ranking', 42, {}, [1, 'two'], [null]])(
    'rejects %p, so the caller keeps Phase 11 ordering',
    (bad) => {
      expect(isUsableRanking(bad)).toBe(false);
    },
  );
});

describe('the queue boundary', () => {
  it('declares reranking as a feature', () => {
    expect(AI_FEATURES).toContain('reranking');
  });

  it('KEEPS reranking off the ai.jobs queue', () => {
    /**
     * SUPPORTED_AI_FEATURES gates POST /internal/ai/jobs/:eventId/result.
     * Reranking is synchronous, has no execution row and no validator there;
     * listing it would let a queue job reach a handler that cannot check it.
     */
    expect(SUPPORTED_AI_FEATURES).not.toContain('reranking');
    expect(SUPPORTED_AI_FEATURES).toEqual(['noop', 'classification', 'summary']);
  });
});

describe('bounds that encode a measurement', () => {
  it('pins the candidate window', () => {
    // Latency was measured FLAT in candidate count (p50 1742/1715/1586ms at
    // n=5/10/15), so the bound is set by usefulness, not affordability.
    expect(RERANK_MAX_CANDIDATES).toBe(10);
    expect(RERANK_MIN_CANDIDATES).toBe(2);
  });

  it('bounds the excerpt so one long row cannot dominate the prompt', () => {
    expect(RERANK_EXCERPT_CHARS).toBe(240);
  });

  it('pins the prompt version', () => {
    expect(RERANKING_PROMPT_VERSION).toBe('reranking-v1');
  });
});

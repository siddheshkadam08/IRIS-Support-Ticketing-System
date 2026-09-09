import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
  SUPPORTED_AI_FEATURES,
  AI_FEATURES,
  toVectorLiteral,
  validateEmbeddingVector,
} from './index.js';

/**
 * The embedding contract — Phase 10.
 *
 * One property dominates and is worth stating before the assertions:
 *
 *   A BAD VECTOR DOES NOT FAIL LOUDLY, IT FAILS SILENTLY.
 *
 * pgvector accepts NaN without complaint. Every distance involving NaN is
 * NaN, and NaN sorts LAST under `ORDER BY ... ASC` — so a poisoned row never
 * appears in a result and never raises anything. The corpus rots one row at a
 * time with nothing anywhere reporting it. That is why validation happens
 * before persistence rather than being left to the database, and it is why
 * these tests are mostly about values Postgres would have accepted.
 */

const good = (fill = 0.1) => Array.from({ length: EMBEDDING_DIM }, () => fill);

describe('vector validation', () => {
  it('accepts a well-formed vector', () => {
    const r = validateEmbeddingVector(good());
    expect(r.ok).toBe(true);
  });

  it('accepts negative components — an embedding is not a probability', () => {
    const v = good();
    v[0] = -0.9;
    expect(validateEmbeddingVector(v).ok).toBe(true);
  });

  describe('values Postgres WOULD accept and that would corrupt ranking', () => {
    it('REJECTS NaN', () => {
      const v = good();
      v[500] = Number.NaN;
      const r = validateEmbeddingVector(v);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('not finite');
    });

    it('REJECTS Infinity and -Infinity', () => {
      for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const v = good();
        v[3] = bad;
        expect(validateEmbeddingVector(v).ok).toBe(false);
      }
    });

    it('REJECTS an all-zero vector', () => {
      /**
       * Cosine distance to the zero vector is undefined and pgvector returns
       * NaN for it — the same silent failure as an explicit NaN, wearing a
       * different mask. A provider returning zeros is also the shape a
       * misconfigured or stubbed client produces.
       */
      const r = validateEmbeddingVector(new Array(EMBEDDING_DIM).fill(0));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe('vector is all zeros');
    });

    it('accepts a vector that is only ONE non-zero component', () => {
      // Degenerate but well-defined: cosine distance to it is a real number.
      // The zero check must not have become a "looks reasonable" check.
      const v = new Array(EMBEDDING_DIM).fill(0);
      v[0] = 1;
      expect(validateEmbeddingVector(v).ok).toBe(true);
    });
  });

  describe('dimension', () => {
    it('REJECTS a vector that is too short — the Matryoshka trap', () => {
      /**
       * `text-embedding-3-small` will happily return 384 dimensions if asked.
       * Silently accepting a narrower vector to fit a column is the failure
       * this guards: it would be stored, it would rank, and it would simply be
       * worse forever with nothing to indicate why.
       */
      const r = validateEmbeddingVector(good().slice(0, 384));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('expected 1536 dimensions, got 384');
    });

    it('REJECTS a vector that is too long', () => {
      expect(validateEmbeddingVector([...good(), 0.1]).ok).toBe(false);
    });

    it('REJECTS an empty array', () => {
      expect(validateEmbeddingVector([]).ok).toBe(false);
    });
  });

  describe('the payload is untrusted, not a typed caller', () => {
    it.each([undefined, null, 42, 'vector', {}, { 0: 1 }])('rejects a non-array (%p)', (bad) => {
      const r = validateEmbeddingVector(bad);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('not an array');
    });

    it('rejects an array containing a non-number', () => {
      const v: unknown[] = good();
      v[7] = '0.5';
      const r = validateEmbeddingVector(v);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('not a number');
    });

    it('rejects nulls, which is what JSON.parse produces for a literal NaN', () => {
      const v: unknown[] = good();
      v[7] = null;
      expect(validateEmbeddingVector(v).ok).toBe(false);
    });
  });
});

describe('pgvector literal', () => {
  it('produces the bracketed comma form', () => {
    expect(toVectorLiteral([1, -2.5, 0])).toBe('[1,-2.5,0]');
  });

  it('round-trips through JSON without scientific notation surprises', () => {
    // Postgres parses 1e-7; the assertion pins the actual output so a change
    // in number formatting is a failing test rather than a silent difference.
    expect(toVectorLiteral([0.0000001])).toBe('[1e-7]');
  });
});

describe('the queue boundary', () => {
  it('declares `embedding` as a feature', () => {
    expect(AI_FEATURES).toContain('embedding');
  });

  it('KEEPS `embedding` OUT of SUPPORTED_AI_FEATURES', () => {
    /**
     * The security assertion, not a formality.
     *
     * SUPPORTED_AI_FEATURES gates POST /internal/ai/jobs/:eventId/result.
     * Embedding has its own route, its own validator and its own idempotency
     * key. Listing it here would let a queue job claim `feature: "embedding"`
     * and reach a result handler with no validator for that shape.
     */
    expect(SUPPORTED_AI_FEATURES).not.toContain('embedding');
    // The exact-set guard lives in shared/contracts/ai-contracts.test.ts, which
    // owns the whole queue surface. Repeating it here made every unrelated
    // feature test fail when Phase 19 added `screenshot` — a real queue
    // feature — while saying nothing about embedding. The property THIS test is
    // named for is the line above, and it is unchanged.
  });
});

describe('constants that must not drift from the schema', () => {
  it('pins the dimension to the migrated column width', () => {
    // ticket.embedding and kb_article.embedding are vector(1536) after
    // migration 014. Changing this constant alone would make every write fail.
    expect(EMBEDDING_DIM).toBe(1536);
  });

  it('pins the model id recorded on every row', () => {
    expect(EMBEDDING_MODEL_ID).toBe('azure/text-embedding-3-small');
  });
});

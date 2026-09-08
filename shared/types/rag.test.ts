import { describe, expect, it } from 'vitest';
import {
  AI_FEATURES,
  RAG_ANSWER_MAX_CHARS,
  RAG_ANSWER_MIN_CHARS,
  RAG_MAX_EVIDENCE,
  RAG_PROMPT_VERSION,
  SUPPORTED_AI_FEATURES,
  validateRagOutput,
} from './index.js';

/**
 * Grounded-answer validation — Phase 13.
 *
 * This is where a hostile or broken model meets Core, so most of these are
 * attacks and malfunctions rather than happy paths. One property dominates:
 *
 *   AN ANSWER WHOSE CITATIONS CANNOT BE VERIFIED IS DISCARDED ENTIRELY.
 *
 * ⚠️ THAT IS DELIBERATELY STRICTER THAN PHASE 12 RERANKING, which drops a bad
 * ordinal and keeps going. The difference is what the number MEANS. A mangled
 * ranking is still a valid set of authorized rows — the worst case is a worse
 * order. A mangled citation means the answer's provenance cannot be checked,
 * and an answer nobody can check is precisely what grounding exists to prevent.
 * So it fails closed and the caller shows plain retrieval results instead.
 */

const good = 'Use the Forgot password link on the sign-in page to reset it.';

describe('the answer', () => {
  it('accepts a well-formed grounded answer', () => {
    const r = validateRagOutput({ answer: good, citations: [1, 2] }, 3);
    expect(r.ok).toBe(true);
    expect(r.ok && r.answer).toBe(good);
    expect(r.ok && r.citations).toEqual([1, 2]);
    expect(r.ok && r.insufficient).toBe(false);
  });

  it('collapses whitespace and trims', () => {
    const r = validateRagOutput({ answer: `  Reset it   from\n\nthe   sign-in page.  `, citations: [1] }, 1);
    expect(r.ok && r.answer).toBe('Reset it from the sign-in page.');
  });

  it('strips control characters that would render literally', () => {
    const dirty = `Reset it${String.fromCharCode(7)} from the${String.fromCharCode(0)} sign-in page.`;
    const r = validateRagOutput({ answer: dirty, citations: [1] }, 1);
    expect(r.ok && r.answer).toBe('Reset it from the sign-in page.');
    expect(r.ok && [...r.answer].every((c) => (c.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
  });

  it('preserves unicode and non-English text', () => {
    const text = 'Réinitialisez votre mot de passe depuis la page de connexion.';
    const r = validateRagOutput({ answer: text, citations: [1] }, 1);
    expect(r.ok && r.answer).toBe(text);
  });

  it.each([undefined, null, 42, {}, [], true])('rejects a non-string answer (%p)', (bad) => {
    const r = validateRagOutput({ answer: bad, citations: [] }, 1);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty or whitespace-only answer', () => {
    expect(validateRagOutput({ answer: '', citations: [] }, 1).ok).toBe(false);
    expect(validateRagOutput({ answer: '   \n\t ', citations: [] }, 1).ok).toBe(false);
  });

  it('rejects a one-word reply — usually a refusal or an echo', () => {
    const r = validateRagOutput({ answer: 'Yes', citations: [1] }, 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('too short');
  });

  it('REJECTS an over-long answer rather than truncating it', () => {
    /**
     * The same reasoning as the Phase 5 summary: the answer IS the payload, so
     * truncation protects nothing — and a grounded answer cut mid-sentence
     * reads as complete while omitting whatever it went on to qualify.
     */
    const r = validateRagOutput(
      { answer: 'x'.repeat(RAG_ANSWER_MAX_CHARS + 1), citations: [1] },
      1,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('length contract');
  });

  it('accepts exactly the maximum length', () => {
    const r = validateRagOutput({ answer: 'x'.repeat(RAG_ANSWER_MAX_CHARS), citations: [1] }, 1);
    expect(r.ok).toBe(true);
  });

  it('measures length AFTER normalising, so padding cannot smuggle it over', () => {
    const padded = `${'x'.repeat(RAG_ANSWER_MAX_CHARS)}${' '.repeat(500)}`;
    const r = validateRagOutput({ answer: padded, citations: [1] }, 1);
    expect(r.ok && r.answer.length).toBe(RAG_ANSWER_MAX_CHARS);
  });
});

describe('⚠️ citation forgery fails CLOSED', () => {
  it('rejects a citation past the end of the evidence', () => {
    const r = validateRagOutput({ answer: good, citations: [999] }, 3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('outside the supplied evidence');
  });

  it('rejects a MIXTURE of valid and forged citations', () => {
    // The realistic attack: real citations for cover, one invented.
    const r = validateRagOutput({ answer: good, citations: [1, 999] }, 3);
    expect(r.ok).toBe(false);
  });

  it.each([[0], [-1], [1.5]])('rejects the non-ordinal citation %j', (c) => {
    expect(validateRagOutput({ answer: good, citations: c }, 3).ok).toBe(false);
  });

  it('rejects DUPLICATE citations', () => {
    const r = validateRagOutput({ answer: good, citations: [1, 1] }, 3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('duplicated');
  });

  it.each([
    ['a database id', ['kb_01M1KHKJTZCAWC6E5ERXNN3VNS']],
    ['a URL', ['https://internal.example/kb/1']],
    ['SQL-shaped text', ["'; DROP TABLE ticket; --"]],
    ['null', [null]],
    ['an object', [{ source_id: 'kb_1' }]],
    ['a nested array', [[1]]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Number.POSITIVE_INFINITY]],
  ])('rejects %s as a citation', (_label, citations) => {
    const r = validateRagOutput({ answer: good, citations }, 3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('citation');
  });

  it.each([undefined, null, 'one', 42, {}])('rejects a non-array citations field (%p)', (bad) => {
    expect(validateRagOutput({ answer: good, citations: bad }, 3).ok).toBe(false);
  });

  it('rejects any citation when NO evidence was supplied', () => {
    // Nothing can be cited if nothing was given; 1..0 is the empty range.
    expect(validateRagOutput({ answer: good, citations: [1] }, 0).ok).toBe(false);
  });

  it('accepts the whole evidence range and nothing past it', () => {
    expect(validateRagOutput({ answer: good, citations: [1, 2, 3] }, 3).ok).toBe(true);
    expect(validateRagOutput({ answer: good, citations: [4] }, 3).ok).toBe(false);
  });
});

describe('insufficient evidence is a first-class outcome', () => {
  it('accepts an empty citation list and FLAGS it', () => {
    /**
     * Not a failure — it is how the model says "the sources do not answer
     * this". Flagged rather than rejected so Core can act on it: ADR-009
     * requires the user to be offered a human, and prose with no sources under
     * it must never be shown as though it were grounded.
     */
    const r = validateRagOutput(
      { answer: 'I do not have enough information in the available sources.', citations: [] },
      3,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.insufficient).toBe(true);
    expect(r.ok && r.citations).toEqual([]);
  });

  it('a cited answer is never flagged insufficient', () => {
    const r = validateRagOutput({ answer: good, citations: [2] }, 3);
    expect(r.ok && r.insufficient).toBe(false);
  });
});

describe('the payload is untrusted, not a typed caller', () => {
  it.each([undefined, null, 'answer', 42, []])('rejects a non-object payload (%p)', (bad) => {
    expect(validateRagOutput(bad, 3).ok).toBe(false);
  });

  it('ignores extra fields a model tries to smuggle in', () => {
    /**
     * The structural narrowing. Even if the model returns a url, a score or a
     * source id, the validator returns only `answer` and `citations`, so
     * nothing downstream can read one.
     */
    const r = validateRagOutput(
      {
        answer: good,
        citations: [1],
        source_url: 'https://internal.example/secret',
        source_id: 'kb_01FAKE',
        confidence: 0.99,
      },
      2,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r)).toEqual(['ok', 'answer', 'citations', 'insufficient']);
  });

  it('is deterministic', () => {
    const input = { answer: good, citations: [2, 1] };
    expect(validateRagOutput(input, 3)).toEqual(validateRagOutput(input, 3));
  });
});

describe('the queue boundary', () => {
  it('declares rag as a feature', () => {
    expect(AI_FEATURES).toContain('rag');
  });

  it('KEEPS rag off the ai.jobs queue', () => {
    expect(SUPPORTED_AI_FEATURES).not.toContain('rag');
    expect(SUPPORTED_AI_FEATURES).toEqual(['noop', 'classification', 'summary']);
  });
});

describe('bounds', () => {
  it('pins the evidence window small', () => {
    expect(RAG_MAX_EVIDENCE).toBe(5);
  });

  it('pins the answer bounds', () => {
    expect(RAG_ANSWER_MIN_CHARS).toBe(10);
    expect(RAG_ANSWER_MAX_CHARS).toBe(1200);
  });

  it('pins the prompt version', () => {
    expect(RAG_PROMPT_VERSION).toBe('rag-v1');
  });
});

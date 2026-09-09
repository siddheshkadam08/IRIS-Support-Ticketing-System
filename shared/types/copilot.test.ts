import { describe, expect, it } from 'vitest';
import {
  AI_FEATURES,
  COPILOT_DRAFT_MAX_CHARS,
  COPILOT_DRAFT_MIN_CHARS,
  COPILOT_MAX_EVIDENCE,
  COPILOT_PROMPT_VERSION,
  SUPPORTED_AI_FEATURES,
  validateCopilotOutput,
} from './index.js';

/**
 * Copilot draft validation — Phase 15.
 *
 * This is where a hostile or broken model meets Core, so most of these are
 * attacks and malfunctions. The property being defended:
 *
 *   A DRAFT WHOSE CITATIONS CANNOT BE VERIFIED IS DISCARDED ENTIRELY.
 *
 * Same fail-closed stance as Phase 13 RAG, and for a sharper reason: this text
 * is about to be shown to a human who may send it to a customer. Putting
 * unverifiable prose in front of them is worse than putting nothing.
 */

const good =
  'Thank you for reporting this. Exports over 50 MB can time out; try narrowing the date range.';

describe('the draft', () => {
  it('accepts a well-formed draft with citations', () => {
    const r = validateCopilotOutput({ draft: good, citations: [1, 2] }, 3);
    expect(r.ok).toBe(true);
    expect(r.ok && r.draft).toBe(good);
    expect(r.ok && r.citations).toEqual([1, 2]);
    expect(r.ok && r.insufficient).toBe(false);
  });

  it('⚠️ PRESERVES paragraph breaks — a reply is not a one-liner', () => {
    /**
     * Deliberately different from the summary and RAG validators, which
     * collapse everything to one line. A customer reply has paragraphs, and
     * flattening them would make the agent reformat every draft by hand.
     */
    const multi = 'Thanks for getting in touch about the export.\n\nPlease try a smaller date range.';
    const r = validateCopilotOutput({ draft: multi, citations: [] }, 1);
    expect(r.ok && r.draft).toBe(multi);
  });

  it('collapses runs of blank lines and trailing spaces', () => {
    const messy = '  First paragraph.   \n\n\n\n   Second   paragraph.  \n\n ';
    const r = validateCopilotOutput({ draft: messy, citations: [] }, 1);
    expect(r.ok && r.draft).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('strips control characters that would render literally', () => {
    const dirty = `Thank you${String.fromCharCode(7)} for reporting${String.fromCharCode(0)} this issue today.`;
    const r = validateCopilotOutput({ draft: dirty, citations: [] }, 1);
    expect(r.ok && r.draft).toBe('Thank you for reporting this issue today.');
    expect(r.ok && [...r.draft].every((c) => (c.codePointAt(0) ?? 0) >= 0x20 || c === '\n')).toBe(true);
  });

  it('preserves unicode and non-English text', () => {
    const text = 'Merci de nous avoir signalé ce problème. Veuillez réduire la plage de dates.';
    const r = validateCopilotOutput({ draft: text, citations: [] }, 1);
    expect(r.ok && r.draft).toBe(text);
  });

  it.each([undefined, null, 42, {}, [], true])('rejects a non-string draft (%p)', (bad) => {
    expect(validateCopilotOutput({ draft: bad, citations: [] }, 1).ok).toBe(false);
  });

  it('rejects an empty or whitespace-only draft', () => {
    expect(validateCopilotOutput({ draft: '', citations: [] }, 1).ok).toBe(false);
    expect(validateCopilotOutput({ draft: '   \n\n\t ', citations: [] }, 1).ok).toBe(false);
  });

  it('rejects a one-word reply', () => {
    const r = validateCopilotOutput({ draft: 'Fixed.', citations: [] }, 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('too short');
  });

  it('REJECTS an over-long draft rather than truncating it', () => {
    /**
     * A reply cut mid-sentence reads as complete while omitting whatever
     * qualified it — the worst failure for text a human is about to send to a
     * customer.
     */
    const r = validateCopilotOutput(
      { draft: 'x'.repeat(COPILOT_DRAFT_MAX_CHARS + 1), citations: [] },
      1,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('length contract');
  });

  it('accepts exactly the maximum length', () => {
    expect(validateCopilotOutput({ draft: 'x'.repeat(COPILOT_DRAFT_MAX_CHARS), citations: [] }, 1).ok).toBe(true);
  });
});

describe('⚠️ citation forgery fails CLOSED — the whole draft is discarded', () => {
  it.each([
    ['out of range', [999]],
    ['valid plus forged', [1, 999]],
    ['zero', [0]],
    ['negative', [-1]],
    ['non-integer', [1.5]],
    ['duplicated', [2, 2]],
    ['a database id', ['kb_01M1KHKJTZCAWC6E5ERXNN3VNS']],
    ['a URL', ['https://internal.example/kb/1']],
    ['SQL-shaped text', ["'; DROP TABLE ticket; --"]],
    ['null', [null]],
    ['an object', [{ source_id: 'kb_1' }]],
    ['NaN', [Number.NaN]],
  ])('rejects %s', (_label, citations) => {
    const r = validateCopilotOutput({ draft: good, citations }, 3);
    expect(r.ok).toBe(false);
  });

  it.each([undefined, null, 'one', 42, {}])('rejects a non-array citations field (%p)', (bad) => {
    expect(validateCopilotOutput({ draft: good, citations: bad }, 3).ok).toBe(false);
  });

  it('rejects any citation when NO evidence was supplied', () => {
    expect(validateCopilotOutput({ draft: good, citations: [1] }, 0).ok).toBe(false);
  });

  it('accepts the whole evidence range and nothing past it', () => {
    expect(validateCopilotOutput({ draft: good, citations: [1, 2, 3] }, 3).ok).toBe(true);
    expect(validateCopilotOutput({ draft: good, citations: [4] }, 3).ok).toBe(false);
  });
});

describe('⚠️ empty citations are VALID here — unlike RAG', () => {
  it('accepts an uncited draft and flags it', () => {
    /**
     * RAG exists to answer from sources, so an uncited answer fails at its own
     * job. A support reply legitimately contains sentences that cite nothing —
     * an acknowledgement, a request for detail, a next step. Requiring a
     * citation would push the model to attach one to a sentence it does not
     * support, which is worse than none.
     */
    const r = validateCopilotOutput(
      { draft: 'Thanks for getting in touch. Could you tell us which report you were exporting?', citations: [] },
      3,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.insufficient).toBe(true);
  });

  it('a cited draft is never flagged insufficient', () => {
    expect(validateCopilotOutput({ draft: good, citations: [2] }, 3).ok && true).toBe(true);
    const r = validateCopilotOutput({ draft: good, citations: [2] }, 3);
    expect(r.ok && r.insufficient).toBe(false);
  });
});

describe('the payload is untrusted, not a typed caller', () => {
  it.each([undefined, null, 'draft', 42, []])('rejects a non-object payload (%p)', (bad) => {
    expect(validateCopilotOutput(bad, 3).ok).toBe(false);
  });

  it('DROPS any extra field a model tries to smuggle in', () => {
    /**
     * The structural narrowing. Even if the model returns a suggested status,
     * a priority or an "action", the validator returns only draft and
     * citations — so nothing downstream can read one, and Copilot cannot reach
     * a business decision even by accident.
     */
    const r = validateCopilotOutput(
      {
        draft: good,
        citations: [1],
        suggested_status: 'resolved',
        priority: 'Critical',
        action: 'close_ticket',
        assignee: 'su_1',
        source_url: 'https://internal.example',
      },
      2,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r)).toEqual(['ok', 'draft', 'citations', 'insufficient']);
  });

  it('is deterministic', () => {
    const input = { draft: good, citations: [2, 1] };
    expect(validateCopilotOutput(input, 3)).toEqual(validateCopilotOutput(input, 3));
  });
});

describe('the queue boundary', () => {
  it('declares copilot as a feature', () => {
    expect(AI_FEATURES).toContain('copilot');
  });

  it('⚠️ KEEPS copilot off the ai.jobs queue', () => {
    /**
     * This matters more than for the other synchronous features. The queue path
     * APPLIES results to tickets; a draft reply reaching a result handler would
     * be one step from being written somewhere. It runs inside an authenticated
     * admin request and persists nothing.
     */
    expect(SUPPORTED_AI_FEATURES).not.toContain('copilot');
    expect(SUPPORTED_AI_FEATURES).toEqual(['noop', 'classification', 'summary']);
  });
});

describe('bounds', () => {
  it('pins the evidence budget small', () => {
    expect(COPILOT_MAX_EVIDENCE).toBe(5);
  });

  it('pins the draft bounds', () => {
    expect(COPILOT_DRAFT_MIN_CHARS).toBe(20);
    expect(COPILOT_DRAFT_MAX_CHARS).toBe(2000);
  });

  it('pins the prompt version', () => {
    expect(COPILOT_PROMPT_VERSION).toBe('copilot-v3');
  });
});

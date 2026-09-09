import { describe, expect, it } from 'vitest';
import {
  KB_STATUSES,
  KB_TRANSITIONS,
  allowedKbTransitions,
  canEditKbArticle,
  canPublishKb,
  isKbStatus,
  isLegalKbTransition,
  kbIndexState,
  type KbArticleStatus,
  type KbIndexInputs,
} from './kb.js';

/**
 * The KB lifecycle contract — Phase 18.
 *
 * Everything here is a pure function, so this file is exhaustive rather than
 * representative: the transition matrix has nine ordered pairs and all nine are
 * asserted, because the interesting failures are the ones nobody thought to
 * write a case for. `archived -> published` is the one that matters and it gets
 * its own block.
 */

const ROLES = ['agent', 'manager', 'product_admin', 'super_admin'] as const;
const MODEL = 'azure/text-embedding-3-small';

// ═══════════════════════════════════════════════════════════════════════
// The transition matrix
// ═══════════════════════════════════════════════════════════════════════

describe('the transition matrix is exhaustive and closed', () => {
  /** Every ordered pair of states, with the single expected verdict. */
  const EXPECTED: Array<[KbArticleStatus, KbArticleStatus, boolean]> = [
    ['draft', 'draft', false],
    ['draft', 'published', true],
    ['draft', 'archived', true],
    ['published', 'draft', true],
    ['published', 'published', false],
    ['published', 'archived', true],
    ['archived', 'draft', true],
    ['archived', 'published', false],
    ['archived', 'archived', false],
  ];

  it('covers all nine ordered pairs of the three states', () => {
    expect(EXPECTED).toHaveLength(KB_STATUSES.length * KB_STATUSES.length);
  });

  for (const [from, to, legal] of EXPECTED) {
    it(`${from} -> ${to} is ${legal ? 'legal' : 'ILLEGAL'}`, () => {
      expect(isLegalKbTransition(from, to)).toBe(legal);
    });
  }

  it('no state can transition to itself', () => {
    for (const s of KB_STATUSES) {
      expect(KB_TRANSITIONS[s]).not.toContain(s);
    }
  });

  it('every target named in the matrix is a real status', () => {
    for (const s of KB_STATUSES) {
      for (const target of KB_TRANSITIONS[s]) expect(isKbStatus(target)).toBe(true);
    }
  });

  it('allowedKbTransitions agrees with isLegalKbTransition for every pair', () => {
    for (const from of KB_STATUSES) {
      for (const to of KB_STATUSES) {
        expect(allowedKbTransitions(from).includes(to)).toBe(isLegalKbTransition(from, to));
      }
    }
  });
});

describe('archived cannot be published directly', () => {
  it('rejects the direct transition', () => {
    expect(isLegalKbTransition('archived', 'published')).toBe(false);
  });

  it('offers draft as the only way out of archived', () => {
    expect(allowedKbTransitions('archived')).toEqual(['draft']);
  });

  /**
   * THE POINT OF THE RULE, stated as a test: the path back to published exists,
   * it is just not one step. A future change that "simplified" the matrix by
   * adding the direct edge would keep every other assertion in this file green.
   */
  it('archived reaches published in exactly two steps, via draft', () => {
    expect(isLegalKbTransition('archived', 'draft')).toBe(true);
    expect(isLegalKbTransition('draft', 'published')).toBe(true);
  });
});

describe('isKbStatus rejects anything that is not one of the three', () => {
  it.each([['', null, undefined, 'DRAFT', 'Published', 'deleted', 'retired', 0, {}]].flat())(
    'rejects %p',
    (v) => {
      expect(isKbStatus(v)).toBe(false);
    },
  );

  it('accepts exactly the three', () => {
    for (const s of KB_STATUSES) expect(isKbStatus(s)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Roles
// ═══════════════════════════════════════════════════════════════════════

describe('publication is a manager decision', () => {
  it('agents cannot publish', () => {
    expect(canPublishKb('agent')).toBe(false);
  });

  it.each(['manager', 'product_admin', 'super_admin'])('%s can publish', (role) => {
    expect(canPublishKb(role)).toBe(true);
  });

  /** Roles that never reach /admin/api at all must not slip through a string check. */
  it.each(['product', 'raiser', 'none', '', 'Manager', 'MANAGER'])('%p cannot publish', (role) => {
    expect(canPublishKb(role)).toBe(false);
  });
});

describe('editing depends on the article state, not only the role', () => {
  it.each(ROLES)('%s can edit a draft', (role) => {
    expect(canEditKbArticle(role, 'draft')).toBe(true);
  });

  it('an agent cannot edit a published article', () => {
    expect(canEditKbArticle('agent', 'published')).toBe(false);
  });

  it.each(['manager', 'product_admin', 'super_admin'])('%s can edit a published article', (role) => {
    expect(canEditKbArticle(role, 'published')).toBe(true);
  });

  /**
   * ⚠️ INCLUDING super_admin. An archived article may be the target of a
   * citation a customer has already been shown; editing it in place rewrites
   * what that citation said after the fact. Restoring to draft first makes the
   * intent explicit.
   */
  it.each(ROLES)('%s cannot edit an archived article', (role) => {
    expect(canEditKbArticle(role, 'archived')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Index state
// ═══════════════════════════════════════════════════════════════════════

const SHA = 'a'.repeat(64);
const OLD_SHA = 'b'.repeat(64);

const inputs = (over: Partial<KbIndexInputs> = {}): KbIndexInputs => ({
  status: 'published',
  is_public: true,
  has_embedding: true,
  embedding_error: null,
  embedding_fingerprint: SHA,
  embedding_content_sha: SHA,
  embedding_model: MODEL,
  current_model: MODEL,
  ...over,
});

describe('index state reports what the embedding pipeline has actually done', () => {
  it('indexed when the vector exists and its fingerprint matches the current text', () => {
    expect(kbIndexState(inputs())).toBe('indexed');
  });

  it('pending when no vector exists yet', () => {
    expect(kbIndexState(inputs({ has_embedding: false, embedding_fingerprint: null }))).toBe('pending');
  });

  it('pending when the text changed after embedding', () => {
    // The generated sha moved; the fingerprint records what was embedded.
    expect(kbIndexState(inputs({ embedding_content_sha: OLD_SHA }))).toBe('pending');
  });

  /**
   * A model swap invalidates the corpus: two models' vectors share no geometry,
   * so comparing them degrades every ranking while looking like nothing.
   */
  it('pending when the vector came from a different model', () => {
    expect(kbIndexState(inputs({ embedding_model: 'azure/some-older-model' }))).toBe('pending');
  });

  it('failed when this exact text was quarantined', () => {
    expect(kbIndexState(inputs({ embedding_error: 'content_filtered' }))).toBe('failed');
  });

  /**
   * ⚠️ THE CASE THE OBVIOUS DERIVATION GETS WRONG.
   *
   * Quarantine stamps the error together with the fingerprint of the text that
   * caused it, and the pending predicate only excludes the row while that
   * fingerprint still matches. Edit the text and the row is pending again —
   * even though `embedding_error` is still set from the previous attempt. A
   * check of "error IS NOT NULL" alone would show failed forever on an article
   * the pipeline had already picked back up.
   */
  it('pending, not failed, when the text was edited after a permanent failure', () => {
    expect(
      kbIndexState(
        inputs({ embedding_error: 'content_filtered', embedding_fingerprint: OLD_SHA }),
      ),
    ).toBe('pending');
  });

  /**
   * The other half of that ordering: a quarantined row can still hold a good
   * vector from the previous revision, which would read as 'indexed' if the
   * error were checked second. That would hide a real, billed failure.
   */
  it('failed wins over indexed when a stale vector is present alongside the error', () => {
    expect(kbIndexState(inputs({ has_embedding: true, embedding_error: 'provider_rejected' }))).toBe(
      'failed',
    );
  });
});

describe('index state is null for articles the corpus does not accept', () => {
  it.each(['draft', 'archived'] as const)('%s is not eligible', (status) => {
    expect(kbIndexState(inputs({ status }))).toBeNull();
  });

  /**
   * `is_public = false` is load-bearing in the embedding corpus predicate:
   * embedding writes run under role 'none' and kb_isolation hides a non-public
   * article from that role, so such a row could never be embedded at all.
   */
  it('a published but non-public article is not eligible', () => {
    expect(kbIndexState(inputs({ is_public: false }))).toBeNull();
  });

  /**
   * Ineligible beats every other signal. A draft that still carries a vector
   * from when it was published is NOT "indexed" — nothing will retrieve it.
   */
  it('a draft holding a vector from a previous publication is still null', () => {
    expect(kbIndexState(inputs({ status: 'draft', has_embedding: true }))).toBeNull();
  });

  it('a draft that previously failed is still null, not failed', () => {
    expect(kbIndexState(inputs({ status: 'draft', embedding_error: 'content_filtered' }))).toBeNull();
  });
});

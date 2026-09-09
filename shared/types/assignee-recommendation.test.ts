import { describe, expect, it } from 'vitest';
import {
  ASSIGNEE_RECOMMENDATION_VERSION,
  CATEGORY_EXPERIENCE_CAP,
  MIN_CORPUS_FOR_SPARSE_CAVEAT,
  SUGGESTIBLE_ROLES,
  SUGGESTION_VIEWER_ROLES,
  categoryExperienceLabel,
  compareCandidates,
  evidenceStrength,
  suggestionSummary,
  type RankableCandidate,
} from './index.js';

/**
 * The ordering and labelling rules for Suggested Assignees — Phase 16.
 *
 * All pure, so the whole ranking contract is testable without a database, a
 * provider or a network. That is the point of keeping the decision arithmetic
 * outside the repository: a disputed ordering months from now can be re-derived
 * exactly rather than argued about.
 *
 * Two properties dominate:
 *
 *   THE ORDER IS TOTAL AND STABLE. Identical inputs always produce an identical
 *   order, because the final tiebreak is a unique id.
 *
 *   EVIDENCE OUTRANKS WORKLOAD. An overloaded candidate who has actually
 *   handled this kind of problem ranks above an idle one who has not.
 */

const c = (over: Partial<RankableCandidate> & { support_user_id: string }): RankableCandidate => ({
  similar_hits: 0,
  best_similarity: null,
  category_count: 0,
  active_ticket_count: 0,
  ...over,
});

const order = (xs: RankableCandidate[]) => [...xs].sort(compareCandidates).map((x) => x.support_user_id);

// ═════════════════════════════════════════════════════════════════════════
// Category labels
// ═════════════════════════════════════════════════════════════════════════

describe('category experience labels', () => {
  it.each([
    [0, 'no relevant history'],
    [1, 'limited history'],
    [2, 'limited history'],
    [3, 'some relevant history'],
    [5, 'some relevant history'],
    [6, 'meaningful historical evidence'],
    [40, 'meaningful historical evidence'],
  ] as const)('%i -> %s', (count, label) => {
    expect(categoryExperienceLabel(count)).toBe(label);
  });

  it('⚠️ NEVER claims expertise, at any count', () => {
    /**
     * The vocabulary is part of the contract. Two tickets is not expertise, and
     * with this corpus neither is six — the strongest available claim is that
     * some evidence exists.
     */
    for (const n of [0, 1, 2, 3, 5, 6, 40, 1000]) {
      const label = categoryExperienceLabel(n);
      for (const forbidden of ['expert', 'specialist', 'best', 'top', 'skilled']) {
        expect(label.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('treats nonsense counts as no history rather than throwing', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
      expect(categoryExperienceLabel(bad)).toBe('no relevant history');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Evidence strength
// ═════════════════════════════════════════════════════════════════════════

describe('evidence strength', () => {
  it.each([
    [0, 0, 'none'],
    [0, 1, 'limited'],
    [0, 2, 'limited'],
    [0, 3, 'moderate'],
    [1, 0, 'moderate'],
    [2, 0, 'moderate'],
    [2, 3, 'strong'],
    [3, 0, 'strong'],
  ] as const)('F1=%i F2=%i -> %s', (f1, f2, expected) => {
    expect(evidenceStrength(f1, f2)).toBe(expected);
  });

  it('⚠️ uses the RAW category count, not the ordering cap', () => {
    // The cap exists to stop volume dominating the ORDER. It must not change
    // how the evidence is described.
    expect(evidenceStrength(2, 3)).toBe('strong');
    expect(evidenceStrength(2, 40)).toBe('strong');
  });

  it('is never a percentage or a number', () => {
    for (const f1 of [0, 1, 2, 3, 9]) {
      for (const f2 of [0, 1, 3, 40]) {
        const s = evidenceStrength(f1, f2);
        expect(typeof s).toBe('string');
        expect(s).not.toMatch(/\d/);
        expect(s).not.toContain('%');
      }
    }
  });

  it('degrades safely on nonsense input', () => {
    expect(evidenceStrength(Number.NaN, Number.NaN)).toBe('none');
    expect(evidenceStrength(-5, -5)).toBe('none');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Ordering — each precedence level proven independently
// ═════════════════════════════════════════════════════════════════════════

describe('the total order', () => {
  it('1. similar-ticket hits come first', () => {
    expect(
      order([
        c({ support_user_id: 'su_a', similar_hits: 1, best_similarity: 0.5 }),
        c({ support_user_id: 'su_b', similar_hits: 3, best_similarity: 0.5 }),
      ]),
    ).toEqual(['su_b', 'su_a']);
  });

  it('2. best similarity breaks EQUAL hit counts', () => {
    expect(
      order([
        c({ support_user_id: 'su_a', similar_hits: 2, best_similarity: 0.60 }),
        c({ support_user_id: 'su_b', similar_hits: 2, best_similarity: 0.95 }),
      ]),
    ).toEqual(['su_b', 'su_a']);
  });

  it('3. category experience breaks equal similar-ticket evidence', () => {
    expect(
      order([
        c({ support_user_id: 'su_a', similar_hits: 1, best_similarity: 0.8, category_count: 1 }),
        c({ support_user_id: 'su_b', similar_hits: 1, best_similarity: 0.8, category_count: 4 }),
      ]),
    ).toEqual(['su_b', 'su_a']);
  });

  it('4. workload breaks equal evidence — lower load first', () => {
    expect(
      order([
        c({ support_user_id: 'su_a', category_count: 2, active_ticket_count: 14 }),
        c({ support_user_id: 'su_b', category_count: 2, active_ticket_count: 3 }),
      ]),
    ).toEqual(['su_b', 'su_a']);
  });

  it('5. the id is the final, total tiebreak', () => {
    expect(order([c({ support_user_id: 'su_b' }), c({ support_user_id: 'su_a' })])).toEqual([
      'su_a',
      'su_b',
    ]);
  });
});

describe('⚠️ the properties the precedence exists to guarantee', () => {
  it('F1 beats F2 — similar-ticket evidence outranks raw category volume', () => {
    expect(
      order([
        c({ support_user_id: 'su_veteran', category_count: 40 }),
        c({ support_user_id: 'su_relevant', similar_hits: 1, best_similarity: 0.7 }),
      ]),
    ).toEqual(['su_relevant', 'su_veteran']);
  });

  it('F2 beats workload — evidence outranks being idle', () => {
    expect(
      order([
        c({ support_user_id: 'su_idle', active_ticket_count: 0 }),
        c({ support_user_id: 'su_busy', category_count: 3, active_ticket_count: 14 }),
      ]),
    ).toEqual(['su_busy', 'su_idle']);
  });

  it('⚠️ WORKLOAD CANNOT OVERRIDE EVIDENCE, however overloaded', () => {
    /**
     * The rule that keeps this a suggestion rather than a load balancer. An
     * overloaded person who has actually handled this problem is still shown
     * first; the reader sees the load and decides.
     */
    expect(
      order([
        c({ support_user_id: 'su_empty', active_ticket_count: 0 }),
        c({ support_user_id: 'su_swamped', similar_hits: 3, best_similarity: 0.9, active_ticket_count: 999 }),
      ]),
    ).toEqual(['su_swamped', 'su_empty']);
  });

  it('zero workload is NOT positive evidence', () => {
    // An idle candidate ties with a loaded one only when the evidence ties;
    // it never promotes them past evidence.
    const idle = c({ support_user_id: 'su_a', active_ticket_count: 0 });
    const loaded = c({ support_user_id: 'su_b', similar_hits: 1, best_similarity: 0.4, active_ticket_count: 20 });
    expect(order([idle, loaded])).toEqual(['su_b', 'su_a']);
  });
});

describe('the category cap', () => {
  it('⚠️ makes 6 and 40 equivalent FOR ORDERING', () => {
    const six = c({ support_user_id: 'su_a', category_count: 6, active_ticket_count: 5 });
    const forty = c({ support_user_id: 'su_b', category_count: 40, active_ticket_count: 5 });
    // Neither outranks the other on category; the id decides.
    expect(order([forty, six])).toEqual(['su_a', 'su_b']);
    expect(compareCandidates(six, forty)).toBeLessThan(0); // by id only
  });

  it('still distinguishes counts BELOW the cap', () => {
    expect(
      order([
        c({ support_user_id: 'su_a', category_count: 2 }),
        c({ support_user_id: 'su_b', category_count: 5 }),
      ]),
    ).toEqual(['su_b', 'su_a']);
  });

  it('pins the cap', () => {
    expect(CATEGORY_EXPERIENCE_CAP).toBe(5);
  });
});

describe('cold start', () => {
  it('⚠️ an all-zero candidate is still ORDERED, never dropped', () => {
    const all = [
      c({ support_user_id: 'su_new' }),
      c({ support_user_id: 'su_experienced', similar_hits: 2, best_similarity: 0.8, category_count: 4 }),
    ];
    const sorted = order(all);
    expect(sorted).toHaveLength(2);
    expect(sorted).toContain('su_new');
    expect(sorted[0]).toBe('su_experienced');
  });

  it('orders a cold-start-only field by workload, then id', () => {
    expect(
      order([
        c({ support_user_id: 'su_c', active_ticket_count: 2 }),
        c({ support_user_id: 'su_a', active_ticket_count: 9 }),
        c({ support_user_id: 'su_b', active_ticket_count: 2 }),
      ]),
    ).toEqual(['su_b', 'su_c', 'su_a']);
  });

  it('a single historical ticket counts as one — no probability is manufactured', () => {
    const one = c({ support_user_id: 'su_a', similar_hits: 1, best_similarity: 1.0 });
    const seven = c({ support_user_id: 'su_b', similar_hits: 7, best_similarity: 0.4 });
    // Seven pieces of evidence beat one, even at a lower best similarity.
    expect(order([one, seven])).toEqual(['su_b', 'su_a']);
  });

  it('rich category history but no similar evidence ranks BELOW any similar evidence', () => {
    expect(
      order([
        c({ support_user_id: 'su_deep', category_count: 40 }),
        c({ support_user_id: 'su_thin', similar_hits: 1, best_similarity: 0.31 }),
      ]),
    ).toEqual(['su_thin', 'su_deep']);
  });
});

describe('determinism', () => {
  it('⚠️ produces an identical order for identical input, whatever the input order', () => {
    const xs = [
      c({ support_user_id: 'su_c', similar_hits: 1, best_similarity: 0.5, category_count: 2, active_ticket_count: 4 }),
      c({ support_user_id: 'su_a', similar_hits: 1, best_similarity: 0.5, category_count: 2, active_ticket_count: 4 }),
      c({ support_user_id: 'su_b', similar_hits: 1, best_similarity: 0.5, category_count: 2, active_ticket_count: 4 }),
    ];
    const expected = ['su_a', 'su_b', 'su_c'];
    expect(order(xs)).toEqual(expected);
    expect(order([...xs].reverse())).toEqual(expected);
    // Fully tied on every factor except the id — so the id must decide, and
    // the result must not depend on the caller's array order.
    expect(order([xs[1]!, xs[2]!, xs[0]!])).toEqual(expected);
  });

  it('is a consistent comparator (antisymmetric)', () => {
    const a = c({ support_user_id: 'su_a', similar_hits: 2, best_similarity: 0.7 });
    const b = c({ support_user_id: 'su_b', similar_hits: 1, best_similarity: 0.9, category_count: 3 });
    expect(Math.sign(compareCandidates(a, b))).toBe(-Math.sign(compareCandidates(b, a)));
    expect(compareCandidates(a, a)).toBe(0);
  });

  it('treats a null best_similarity as worse than any real similarity', () => {
    expect(
      order([
        c({ support_user_id: 'su_a', similar_hits: 0, best_similarity: null }),
        c({ support_user_id: 'su_b', similar_hits: 0, best_similarity: 0.0 }),
      ]),
    ).toEqual(['su_b', 'su_a']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Summary text
// ═════════════════════════════════════════════════════════════════════════

describe('the one-line summary', () => {
  it('names both factors when both exist', () => {
    expect(suggestionSummary({ similarHits: 3, categoryCount: 2, category: 'reports' })).toBe(
      '3 similar resolved tickets; limited history in reports',
    );
  });

  it('singularises one ticket', () => {
    expect(suggestionSummary({ similarHits: 1, categoryCount: 0, category: 'reports' })).toBe(
      '1 similar resolved ticket',
    );
  });

  it('omits category when the ticket has none', () => {
    expect(suggestionSummary({ similarHits: 2, categoryCount: 5, category: null })).toBe(
      '2 similar resolved tickets',
    );
  });

  it('⚠️ says so plainly when there is no evidence, rather than inventing a reason', () => {
    // Never "available" or "low workload" — a free calendar is not a reason to
    // give someone a ticket.
    expect(suggestionSummary({ similarHits: 0, categoryCount: 0, category: 'reports' })).toBe(
      'No relevant historical evidence for this ticket',
    );
  });

  it('never claims expertise or confidence', () => {
    for (const [h, cc] of [[0, 0], [1, 1], [3, 6], [9, 40]] as const) {
      const s = suggestionSummary({ similarHits: h, categoryCount: cc, category: 'reports' }).toLowerCase();
      for (const forbidden of ['expert', 'specialist', 'best', 'confidence', '%']) {
        expect(s).not.toContain(forbidden);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// The contract's constants
// ═════════════════════════════════════════════════════════════════════════

describe('contract constants', () => {
  it('⚠️ excludes super_admin from suggestible roles', () => {
    expect(SUGGESTIBLE_ROLES).toEqual(['agent', 'product_admin', 'manager']);
    expect(SUGGESTIBLE_ROLES as readonly string[]).not.toContain('super_admin');
  });

  it('⚠️ excludes agent from viewer roles', () => {
    expect(SUGGESTION_VIEWER_ROLES).toEqual(['manager', 'product_admin', 'super_admin']);
    expect(SUGGESTION_VIEWER_ROLES as readonly string[]).not.toContain('agent');
  });

  it('recommendation eligibility and viewing are DIFFERENT sets', () => {
    // The distinction the audit insisted on: who may be suggested is not who
    // may ask, and neither equals who may assign.
    expect(SUGGESTIBLE_ROLES as readonly string[]).not.toEqual(
      SUGGESTION_VIEWER_ROLES as readonly string[],
    );
  });

  it('pins the sparse-evidence threshold and the version', () => {
    expect(MIN_CORPUS_FOR_SPARSE_CAVEAT).toBe(30);
    expect(ASSIGNEE_RECOMMENDATION_VERSION).toBe('assignee-recommendation-v1');
  });
});

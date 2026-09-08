import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_THRESHOLDS,
  DEFAULT_IMPACTS,
  PRIORITY_TO_SEVERITY,
  type AIThresholds,
  type PriorityFactors,
} from '@iris/shared/types';
import {
  classificationSourceFor,
  compositeConfidence,
  computeMargin,
  decide,
  determinePriority,
  determineRouting,
  normaliseKeywords,
} from './classification.rules.js';

/**
 * The deterministic decision engine — Phase 4.
 *
 * This is where "IRIS decides" is actually enforced, so it gets the densest
 * tests in the feature. Everything here is a pure function, which means these
 * run without a provider, without Redis and without Postgres — deliberately,
 * because the provider is the one part of Phase 4 that cannot be exercised
 * offline, and the business rules must not inherit that limitation.
 */

const IMPACTS = DEFAULT_IMPACTS;
const CORE = ['reports', 'login_access'];

/** Neutral factors: nothing urgent, nothing mitigating. Scores the baseline. */
const factors = (over: Partial<PriorityFactors> = {}): PriorityFactors => ({
  security_or_data_loss: false,
  system_down: false,
  hours_until_deadline: null,
  regulatory_impact: false,
  workaround_available: false,
  cosmetic_only: false,
  priority_factor_confidence: 0.9,
  ...over,
});

const priorityOf = (f: Partial<PriorityFactors>, over: Record<string, unknown> = {}) =>
  determinePriority({
    factors: factors(f),
    issue_type: 'Bug',
    category: 'other',
    impacts: IMPACTS,
    impact: 'Single User',
    core_categories: CORE,
    ...over,
  });

// ═════════════════════════════════════════════════════════════════════════
// Short-circuits
// ═════════════════════════════════════════════════════════════════════════

describe('short-circuits are absolute, not weights', () => {
  it('security or data loss is Critical whatever else is true', () => {
    const r = priorityOf({
      security_or_data_loss: true,
      // Everything here would otherwise argue for LOW.
      cosmetic_only: true,
      workaround_available: true,
    });
    expect(r.priority).toBe('Critical');
    expect(r.score, 'a short-circuit fires before any scoring').toBeNull();
    expect(r.breakdown).toBe('security_or_data_loss');
  });

  it.each(['Information', 'Question'])('%s is Low — a question is not an outage', (issue_type) => {
    const r = priorityOf(
      // Facts that would otherwise score Critical.
      { system_down: true, regulatory_impact: true, hours_until_deadline: 1 },
      { issue_type, impact: 'Entire Customer' },
    );
    expect(r.priority).toBe('Low');
    expect(r.breakdown).toBe('informational_or_question');
  });

  it.each(['Feature Request', 'Improvement'])('%s is Low', (issue_type) => {
    const r = priorityOf({ system_down: true }, { issue_type, impact: 'Entire Customer' });
    expect(r.priority).toBe('Low');
    expect(r.breakdown).toBe('enhancement_or_feature_request');
  });

  it('cosmetic_only is Low', () => {
    const r = priorityOf({ cosmetic_only: true, system_down: true });
    expect(r.priority).toBe('Low');
    expect(r.breakdown).toBe('cosmetic_only');
  });

  it('ORDER decides a conflict: security beats cosmetic', () => {
    // Both true is a model contradiction. The order is the resolution rule —
    // it must never depend on evaluation accident.
    expect(priorityOf({ security_or_data_loss: true, cosmetic_only: true }).priority).toBe(
      'Critical',
    );
  });

  it('an informational ticket outranks cosmetic in the order, but both give Low', () => {
    const r = priorityOf({ cosmetic_only: true }, { issue_type: 'Question' });
    expect(r.priority).toBe('Low');
    expect(r.breakdown, 'issue_type is checked before cosmetic_only').toBe(
      'informational_or_question',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Scoring
// ═════════════════════════════════════════════════════════════════════════

describe('the weighted score', () => {
  it('a plain bug scores the baseline alone', () => {
    const r = priorityOf({});
    expect(r.score).toBe(15);
    expect(r.priority).toBe('Normal'); // 15 is exactly the Normal threshold
    expect(r.breakdown).toBe('weighted_score=15 (baseline=+15)');
  });

  it('system_down adds 20', () => {
    expect(priorityOf({ system_down: true }).score).toBe(35);
  });

  it('a CORE category that is down adds a further 15', () => {
    const r = priorityOf({ system_down: true }, { category: 'reports' });
    expect(r.score, '15 + 20 + 15').toBe(50);
    expect(r.breakdown).toContain('core_category_system_down=+15');
  });

  it('the core bonus needs BOTH conditions', () => {
    // Core category but not down: no bonus.
    expect(priorityOf({}, { category: 'reports' }).score).toBe(15);
    // Down but not core: no bonus.
    expect(priorityOf({ system_down: true }, { category: 'other' }).score).toBe(35);
  });

  it.each([
    ['Single User', 15],
    ['Multiple Users', 35],
    ['Entire Customer', 45],
  ])('impact %s scores %i', (impact, expected) => {
    expect(priorityOf({}, { impact }).score).toBe(expected);
  });

  it('scores impact by POSITION, so renaming a tier does not re-weight it', () => {
    /**
     * A product may name its tiers anything. The engine reads the index in the
     * product's own list, so "Whole Tenant" in slot 2 scores exactly what
     * "Entire Customer" in slot 2 scored.
     */
    const renamed = ['One Person', 'A Team', 'Whole Tenant'];
    expect(priorityOf({}, { impacts: renamed, impact: 'Whole Tenant' }).score).toBe(45);
    expect(priorityOf({}, { impacts: renamed, impact: 'One Person' }).score).toBe(15);
  });

  it('an impact outside the product list contributes nothing rather than crashing', () => {
    // Core validation rejects this before scoring, but the engine must not be
    // the thing that explodes if it ever arrives.
    expect(priorityOf({}, { impact: 'Nonexistent' }).score).toBe(15);
  });

  it.each([
    [1, 60],
    [2, 60],
    [5, 50],
    [8, 50],
    [20, 40],
    [24, 40],
    [48, 30],
    [72, 30],
    [150, 20],
    [168, 20],
  ])('a deadline in %ih scores %i overall', (hours, expected) => {
    expect(priorityOf({ hours_until_deadline: hours }).score).toBe(expected);
  });

  it('a deadline beyond the widest band adds nothing', () => {
    expect(priorityOf({ hours_until_deadline: 500 }).score).toBe(15);
  });

  it('a NULL deadline adds nothing — absent is not imminent', () => {
    /**
     * The alternative reading ("unknown, so assume urgent") would let every
     * vague ticket inflate its own priority, which is precisely the failure
     * mode a deterministic engine exists to prevent.
     */
    const r = priorityOf({ hours_until_deadline: null });
    expect(r.score).toBe(15);
    expect(r.breakdown).not.toContain('deadline');
  });

  it('ignores a nonsensical negative deadline', () => {
    expect(priorityOf({ hours_until_deadline: -5 }).score).toBe(15);
  });

  it('regulatory impact adds 15', () => {
    expect(priorityOf({ regulatory_impact: true }).score).toBe(30);
  });

  it('a workaround SUBTRACTS 15 — it softens, it does not cancel', () => {
    const without = priorityOf({ system_down: true }, { impact: 'Entire Customer' });
    const withOne = priorityOf(
      { system_down: true, workaround_available: true },
      { impact: 'Entire Customer' },
    );
    expect(without.score, '15 + 20 + 30').toBe(65);
    expect(withOne.score, 'the same, minus 15').toBe(50);
    expect(withOne.priority, 'still High, not dismissed').toBe('High');
  });

  it('accumulates every component into one score', () => {
    const r = priorityOf(
      { system_down: true, regulatory_impact: true, hours_until_deadline: 1 },
      { category: 'reports', impact: 'Entire Customer' },
    );
    // 15 + 20 + 15 + 30 + 45 + 15
    expect(r.score).toBe(140);
    expect(r.priority).toBe('Critical');
  });
});

describe('score bands', () => {
  /**
   * Each case names the exact factor combination, the score it must produce,
   * and the band that score must land in. Asserting BOTH is what makes this a
   * test of the bands rather than a restatement of the scoring code.
   */
  it.each([
    // factors                                            impact             score  band
    [{ system_down: true, hours_until_deadline: 2 }, 'Single User', 80, 'Critical'],
    [{ hours_until_deadline: 2 }, 'Single User', 60, 'High'],
    [{ hours_until_deadline: 24 }, 'Single User', 40, 'High'],
    [{ regulatory_impact: true }, 'Single User', 30, 'Normal'],
    [{}, 'Single User', 15, 'Normal'],
    [{ workaround_available: true }, 'Single User', 0, 'Low'],
  ] as const)('%o on %s scores %i -> %s', (f, impact, score, band) => {
    const r = priorityOf(f, { impact });
    expect(r.score).toBe(score);
    expect(r.priority).toBe(band);
  });

  it('is inclusive at every boundary', () => {
    // 15 baseline + 25 (24h band) = 40 exactly -> High, not Normal.
    expect(priorityOf({ hours_until_deadline: 24 }).priority).toBe('High');
    // 15 baseline alone = 15 exactly -> Normal, not Low.
    expect(priorityOf({}).priority).toBe('Normal');
  });

  it('drops below Normal only when something subtracts', () => {
    const r = priorityOf({ workaround_available: true });
    expect(r.score).toBe(0);
    expect(r.priority).toBe('Low');
  });
});

describe('the breakdown explains itself', () => {
  it('names every component with a signed value', () => {
    const r = priorityOf({ system_down: true, workaround_available: true });
    expect(r.breakdown).toBe(
      'weighted_score=20 (baseline=+15, system_down=+20, workaround_penalty=-15)',
    );
  });

  it('is enough to re-derive the score without the original factors', () => {
    // The point of persisting it: "why is this Critical" answerable from one string.
    const r = priorityOf({ system_down: true, regulatory_impact: true });
    const sum = [...r.breakdown.matchAll(/=([+-]\d+)/g)].reduce(
      (a, m) => a + Number(m[1]),
      0,
    );
    expect(sum).toBe(r.score);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Severity
// ═════════════════════════════════════════════════════════════════════════

describe('severity mapping', () => {
  it('maps Priority onto IRIS severity, NOT the reference P1-P4', () => {
    /**
     * The naming trap from the audit. The reference has both a Priority and a
     * P1-P4 "Severity"; IRIS's `severity` column IS the urgency tier, so it
     * corresponds to the reference's PRIORITY. Mapping by field name would put
     * "P1" into a column whose CHECK cannot hold it.
     */
    expect(PRIORITY_TO_SEVERITY).toEqual({
      Critical: 'critical',
      High: 'high',
      Normal: 'medium',
      Low: 'low',
    });
  });

  it('never yields a value outside the ticket.severity CHECK', () => {
    const allowed = ['low', 'medium', 'high', 'critical'];
    for (const sev of Object.values(PRIORITY_TO_SEVERITY)) expect(allowed).toContain(sev);
  });

  it('"Normal" becomes "medium" — the one non-identity mapping', () => {
    expect(PRIORITY_TO_SEVERITY.Normal).toBe('medium');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Confidence
// ═════════════════════════════════════════════════════════════════════════

describe('margin', () => {
  it('is p1 - p2 when a runner-up exists', () => {
    expect(computeMargin(0.9, 0.4)).toBeCloseTo(0.5, 10);
  });

  it('is p1 when there is NO runner-up — maximal separation', () => {
    /**
     * The model had nothing close enough to name as a second guess. Treating
     * that as margin 0 would send every unambiguous ticket to manual triage.
     */
    expect(computeMargin(0.9, null)).toBe(0.9);
    expect(computeMargin(0.9, undefined)).toBe(0.9);
  });
});

describe('composite confidence', () => {
  it('is the MINIMUM, never an average', () => {
    const c = compositeConfidence({
      category_confidence: 0.95,
      issue_type_confidence: 0.95,
      impact_confidence: 0.2, // essentially a guess
      priority_factor_confidence: 0.95,
    });
    expect(c).toBe(0.2);
    // An average would have reported 0.7625 — comfortable-looking, and wrong.
    expect(c).not.toBeCloseTo(0.7625, 3);
  });

  it('uses exactly the four contracted fields', () => {
    expect(
      compositeConfidence({
        category_confidence: 0.4,
        issue_type_confidence: 0.5,
        impact_confidence: 0.6,
        priority_factor_confidence: 0.7,
      }),
    ).toBe(0.4);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Routing
// ═════════════════════════════════════════════════════════════════════════

describe('routing bands', () => {
  const T = DEFAULT_AI_THRESHOLDS;

  it('below the triage floor is manual triage', () => {
    expect(determineRouting(0.49, 0.49, T)).toBe('manual_triage');
  });

  it('high confidence AND a clear margin auto-routes', () => {
    expect(determineRouting(0.9, 0.4, T)).toBe('auto_route');
  });

  it('confident but NEARLY TIED does not auto-route', () => {
    // The specific case the middle band exists for: p1 is excellent, but the
    // runner-up is almost as good, so the choice is not actually settled.
    expect(determineRouting(0.95, 0.02, T)).toBe('soft_route_ai_uncertain');
  });

  it('the middle band catches everything else', () => {
    expect(determineRouting(0.6, 0.6, T)).toBe('soft_route_ai_uncertain');
    expect(determineRouting(0.79, 0.79, T)).toBe('soft_route_ai_uncertain');
  });

  it('is inclusive at both boundaries', () => {
    expect(determineRouting(0.5, 0.5, T)).toBe('soft_route_ai_uncertain'); // floor is >=
    expect(determineRouting(0.8, 0.25, T)).toBe('auto_route'); // both exactly on
  });

  it('honours per-product thresholds rather than the defaults', () => {
    const strict: AIThresholds = { auto_route_p1: 0.95, auto_route_margin: 0.5, triage_floor: 0.7 };
    expect(determineRouting(0.9, 0.4, strict)).toBe('soft_route_ai_uncertain');
    expect(determineRouting(0.6, 0.6, strict)).toBe('manual_triage');
  });

  it('uses the frozen platform defaults', () => {
    expect(T).toEqual({ auto_route_p1: 0.8, auto_route_margin: 0.25, triage_floor: 0.5 });
  });
});

describe('classification_source mapping', () => {
  it('only auto_route earns ai_auto', () => {
    expect(classificationSourceFor('auto_route')).toBe('ai_auto');
    expect(classificationSourceFor('soft_route_ai_uncertain')).toBe('ai_uncertain');
    expect(classificationSourceFor('manual_triage')).toBe('ai_uncertain');
  });

  it('only ever produces values the existing CHECK allows', () => {
    const allowed = ['product', 'ai_auto', 'ai_uncertain', 'unclassified'];
    for (const r of ['auto_route', 'soft_route_ai_uncertain', 'manual_triage'] as const) {
      expect(allowed).toContain(classificationSourceFor(r));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Keywords
// ═════════════════════════════════════════════════════════════════════════

describe('keyword normalisation — Core is authoritative', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normaliseKeywords(['  Login   Failure ', 'EXPORT'])).toEqual([
      'login failure',
      'export',
    ]);
  });

  it('dedupes AFTER normalising, preserving first-seen order', () => {
    expect(normaliseKeywords(['Login', 'login ', 'LOGIN', 'export'])).toEqual([
      'login',
      'export',
    ]);
  });

  it('TRUNCATES past 8 rather than failing the classification', () => {
    /**
     * A tenth keyword must not veto an otherwise-perfect classification. The
     * least important field does not get to reject the most important ones.
     */
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    const out = normaliseKeywords(many);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('tag0');
  });

  it('accepts an empty list — zero keywords is valid', () => {
    expect(normaliseKeywords([])).toEqual([]);
  });

  it.each([
    ['punctuation', 'sql;drop'],
    ['leading hyphen', '-leading'],
    ['at sign', 'user@host'],
    ['slash', 'a/b'],
    ['unicode', 'café'],
  ])('drops an invalid keyword (%s)', (_label, bad) => {
    expect(normaliseKeywords([bad, 'valid'])).toEqual(['valid']);
  });

  it('allows digits, spaces, underscores and inner hyphens', () => {
    expect(normaliseKeywords(['error 500', 'multi-word', 'snake_case', '2fa'])).toEqual([
      'error 500',
      'multi-word',
      'snake_case',
      '2fa',
    ]);
  });

  it('drops an over-long keyword but keeps the rest', () => {
    expect(normaliseKeywords(['x'.repeat(41), 'ok'])).toEqual(['ok']);
    expect(normaliseKeywords(['x'.repeat(40)])).toHaveLength(1);
  });

  it('survives anything that is not an array of strings', () => {
    // The model is untrusted input, not a typed caller.
    expect(normaliseKeywords(null)).toEqual([]);
    expect(normaliseKeywords('login')).toEqual([]);
    expect(normaliseKeywords({})).toEqual([]);
    expect(normaliseKeywords([1, true, null, 'ok'])).toEqual(['ok']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// The whole decision
// ═════════════════════════════════════════════════════════════════════════

describe('decide() composes the whole engine', () => {
  const base = {
    category: 'reports',
    category_confidence: 0.9,
    category_runner_up_confidence: 0.4,
    issue_type: 'Bug',
    issue_type_confidence: 0.85,
    impact: 'Entire Customer',
    impact_confidence: 0.8,
    impacts: IMPACTS,
    core_categories: CORE,
    thresholds: DEFAULT_AI_THRESHOLDS,
  };

  it('turns signals into a complete, self-explaining decision', () => {
    const d = decide({
      ...base,
      factors: factors({ system_down: true, hours_until_deadline: 4 }),
    });

    // 15 + 20 + 15(core) + 30(impact) + 35(deadline)
    expect(d.score).toBe(115);
    expect(d.priority).toBe('Critical');
    expect(d.severity).toBe('critical');
    expect(d.margin).toBeCloseTo(0.5, 10);
    expect(d.routing_decision).toBe('auto_route');
    expect(d.composite_confidence).toBe(0.8);
    expect(d.score_breakdown).toContain('weighted_score=115');
  });

  it('severity always agrees with priority', () => {
    for (const f of [
      { security_or_data_loss: true },
      { cosmetic_only: true },
      { system_down: true },
      {},
    ]) {
      const d = decide({ ...base, factors: factors(f) });
      expect(d.severity).toBe(PRIORITY_TO_SEVERITY[d.priority]);
    }
  });

  it('is deterministic — identical input, identical output', () => {
    const input = { ...base, factors: factors({ system_down: true }) };
    expect(decide(input)).toEqual(decide(input));
  });

  it('a low-confidence classification is still a DECISION, not a failure', () => {
    // The engine has no failure mode. Uncertainty routes differently; it does
    // not throw, and it does not refuse to decide.
    const d = decide({
      ...base,
      category_confidence: 0.2,
      category_runner_up_confidence: 0.19,
      factors: factors(),
    });
    expect(d.routing_decision).toBe('manual_triage');
    expect(d.priority).toBeTruthy();
    expect(d.severity).toBeTruthy();
  });
});

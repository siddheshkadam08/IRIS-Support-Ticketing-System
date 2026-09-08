import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_THRESHOLDS, type AITaxonomy } from '@iris/shared/types';
import { validateClassification, type ValidationContext } from './classification.validator.js';

/**
 * Core's independent validation of model output — Phase 4.
 *
 * The rule under test: PYTHON HAVING ACCEPTED IT IS NOT ENOUGH. Python is
 * handed its taxonomy by Core, so a stale copy, a misconfiguration or a
 * compromised inference service all produce payloads Python validates happily
 * and Core must reject. Every enum is therefore re-checked here against Core's
 * own product config.
 *
 * These tests deliberately feed the validator payloads that a correctly
 * behaving Python would never send — that is the point.
 */

const taxonomy: AITaxonomy = {
  categories: [
    { value: 'login_access', label: 'Login / Access' },
    { value: 'reports', label: 'Reports' },
    { value: 'billing', label: 'Billing' },
  ],
  severities: ['low', 'medium', 'high', 'critical'],
  issue_types: ['Bug', 'Question', 'Feature Request'],
  impacts: ['Single User', 'Multiple Users', 'Entire Customer'],
};

const ctx: ValidationContext = {
  taxonomy,
  thresholds: DEFAULT_AI_THRESHOLDS,
  coreCategories: ['reports'],
};

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: 'reports',
  category_confidence: 0.9,
  category_runner_up: 'billing',
  category_runner_up_confidence: 0.3,
  issue_type: 'Bug',
  issue_type_confidence: 0.85,
  impact: 'Multiple Users',
  impact_confidence: 0.8,
  priority_factors: {
    security_or_data_loss: false,
    system_down: false,
    hours_until_deadline: null,
    regulatory_impact: false,
    workaround_available: false,
    cosmetic_only: false,
    priority_factor_confidence: 0.75,
  },
  sentiment: 'Frustrated (an export they rely on is failing)',
  keywords_tags: ['reports', 'export'],
  rationale: 'Export fails, a functional defect in the reporting area.',
  ...over,
});

const withFactors = (over: Record<string, unknown>) =>
  payload({ priority_factors: { ...(payload().priority_factors as object), ...over } });

const ok = (data: Record<string, unknown>) => {
  const r = validateClassification(data, ctx);
  if (!r.ok) throw new Error(`expected valid, got: ${r.message}`);
  return r;
};

const rejected = (data: Record<string, unknown>) => {
  const r = validateClassification(data, ctx);
  expect(r.ok, 'expected this payload to be rejected').toBe(false);
  return r as { ok: false; code: string; message: string };
};

// ═════════════════════════════════════════════════════════════════════════
// Taxonomy membership — the reason this layer exists
// ═════════════════════════════════════════════════════════════════════════

describe('taxonomy membership is re-checked against CORE', () => {
  it('accepts a payload whose values are all in the product taxonomy', () => {
    const r = ok(payload());
    expect(r.value.category).toBe('reports');
    expect(r.decision.priority).toBeTruthy();
  });

  it('REJECTS a category outside the taxonomy', () => {
    const r = rejected(payload({ category: 'invented' }));
    expect(r.code).toBe('invalid_ai_output');
    expect(r.message).toContain('invented');
  });

  it('rejects an issue_type outside the taxonomy', () => {
    expect(rejected(payload({ issue_type: 'Catastrophe' })).code).toBe('invalid_ai_output');
  });

  it('rejects an impact outside the taxonomy', () => {
    expect(rejected(payload({ impact: 'The Whole Planet' })).code).toBe('invalid_ai_output');
  });

  it('rejects a RUNNER-UP outside the taxonomy', () => {
    /**
     * Not a cosmetic field: the runner-up feeds the margin, and the margin
     * decides whether the ticket auto-routes. An unchecked runner-up is a path
     * from raw model output to an automation decision.
     */
    expect(rejected(payload({ category_runner_up: 'made_up' })).ok).toBe(false);
  });

  it('is scoped per product — another product’s category is not accepted', () => {
    const otherProduct: ValidationContext = {
      ...ctx,
      taxonomy: { ...taxonomy, categories: [{ value: 'hardware', label: 'Hardware' }] },
    };
    const r = validateClassification(payload(), otherProduct);
    expect(r.ok, 'reports is valid for one product and not another').toBe(false);
  });

  it('rejects a missing required signal', () => {
    for (const field of ['category', 'issue_type', 'impact']) {
      const p = payload();
      delete p[field];
      expect(rejected(p).ok).toBe(false);
    }
  });

  it('rejects a non-string signal', () => {
    expect(rejected(payload({ category: 42 })).ok).toBe(false);
    expect(rejected(payload({ category: null })).ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Confidence
// ═════════════════════════════════════════════════════════════════════════

describe('confidence ranges', () => {
  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, '0.9', null])(
    'rejects category_confidence %p',
    (bad) => {
      expect(rejected(payload({ category_confidence: bad })).ok).toBe(false);
    },
  );

  it('accepts the boundaries', () => {
    expect(ok(payload({ category_confidence: 0 })).value.category_confidence).toBe(0);
    expect(ok(payload({ category_confidence: 1 })).value.category_confidence).toBe(1);
  });

  it('rejects an out-of-range priority_factor_confidence', () => {
    expect(rejected(withFactors({ priority_factor_confidence: 2 })).ok).toBe(false);
  });

  it('computes the margin from the runner-up', () => {
    expect(ok(payload()).decision.margin).toBeCloseTo(0.6, 10);
  });

  it('treats a null runner-up as maximal separation', () => {
    const r = ok(payload({ category_runner_up: null, category_runner_up_confidence: null }));
    expect(r.decision.margin).toBe(0.9);
  });

  it('DROPS a runner-up confidence with no runner-up value', () => {
    /**
     * A confidence that refers to nothing cannot form a margin. Keeping it
     * would subtract a number describing a value that was never chosen.
     */
    const r = ok(payload({ category_runner_up: null, category_runner_up_confidence: 0.4 }));
    expect(r.value.category_runner_up_confidence).toBeNull();
    expect(r.decision.margin).toBe(0.9);
  });

  it('composite confidence is the weakest of the four', () => {
    const r = ok(payload({ impact_confidence: 0.11 }));
    expect(r.decision.composite_confidence).toBe(0.11);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Priority factors
// ═════════════════════════════════════════════════════════════════════════

describe('priority factors', () => {
  it('rejects a missing factors object', () => {
    expect(rejected(payload({ priority_factors: undefined })).ok).toBe(false);
    expect(rejected(payload({ priority_factors: null })).ok).toBe(false);
    expect(rejected(payload({ priority_factors: [] })).ok).toBe(false);
  });

  it.each([
    'security_or_data_loss',
    'system_down',
    'regulatory_impact',
    'workaround_available',
    'cosmetic_only',
  ])('rejects a non-boolean %s', (field) => {
    expect(rejected(withFactors({ [field]: 'yes' })).ok).toBe(false);
  });

  it('accepts a NULL deadline — no deadline was mentioned', () => {
    const r = ok(withFactors({ hours_until_deadline: null }));
    expect(r.value.priority_factors.hours_until_deadline).toBeNull();
  });

  it('accepts a numeric deadline', () => {
    expect(ok(withFactors({ hours_until_deadline: 20 })).value.priority_factors.hours_until_deadline).toBe(20);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 'soon'])(
    'rejects a nonsensical deadline (%p)',
    (bad) => {
      // A negative or non-finite value would corrupt the band lookup.
      expect(rejected(withFactors({ hours_until_deadline: bad })).ok).toBe(false);
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Narrative — bounded, never fatal
// ═════════════════════════════════════════════════════════════════════════

describe('narrative fields are bounded rather than rejected', () => {
  it('truncates an over-long rationale instead of failing', () => {
    // Losing a long rationale is cosmetic; losing the classification is not.
    const r = ok(payload({ rationale: 'x'.repeat(5000) }));
    expect(r.value.rationale.length).toBe(1000);
  });

  it('truncates an over-long sentiment', () => {
    expect(ok(payload({ sentiment: 'y'.repeat(1000) })).value.sentiment.length).toBe(300);
  });

  it('tolerates missing narrative entirely', () => {
    const r = ok(payload({ sentiment: undefined, rationale: undefined, keywords_tags: undefined }));
    expect(r.value.sentiment).toBe('');
    expect(r.value.keywords_tags).toEqual([]);
  });

  it('normalises keywords rather than trusting them', () => {
    const r = ok(payload({ keywords_tags: ['  Login  Failure ', 'LOGIN failure', 'bad;tag'] }));
    expect(r.value.keywords_tags).toEqual(['login failure']);
  });

  it('truncates a flood of keywords to 8 without failing', () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(ok(payload({ keywords_tags: many })).value.keywords_tags).toHaveLength(8);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// The decision the validator returns
// ═════════════════════════════════════════════════════════════════════════

describe('validation produces the decision, not just a payload', () => {
  it('runs the deterministic engine and returns priority, severity and routing', () => {
    const r = ok(
      withFactors({ system_down: true, hours_until_deadline: 1, regulatory_impact: true }),
    );
    // 15 + 20 + 15(core: reports) + 20(Multiple Users) + 45(<=2h) + 15(reg)
    expect(r.decision.score).toBe(130);
    expect(r.decision.priority).toBe('Critical');
    expect(r.decision.severity).toBe('critical');
    expect(r.decision.routing_decision).toBe('auto_route');
  });

  it('honours the product’s core_categories', () => {
    const nonCore = ok(payload({ category: 'billing', ...{} }));
    const core = ok(payload({ category: 'reports' }));
    expect(nonCore.decision.score).toBe(core.decision.score); // neither is down
    const downNonCore = validateClassification(
      { ...payload({ category: 'billing' }), priority_factors: { ...(payload().priority_factors as object), system_down: true } },
      ctx,
    );
    const downCore = validateClassification(
      { ...payload({ category: 'reports' }), priority_factors: { ...(payload().priority_factors as object), system_down: true } },
      ctx,
    );
    if (!downNonCore.ok || !downCore.ok) throw new Error('expected both valid');
    expect(downCore.decision.score! - downNonCore.decision.score!).toBe(15);
  });

  it('a low-confidence result is VALID, and routes to triage', () => {
    /**
     * The distinction the whole failure model rests on: uncertainty is a
     * successful classification the system treats differently, not an error to
     * retry six times.
     */
    const r = ok(payload({ category_confidence: 0.2, category_runner_up_confidence: 0.19 }));
    expect(r.decision.routing_decision).toBe('manual_triage');
    expect(r.decision.priority).toBeTruthy();
  });

  it('is deterministic', () => {
    expect(ok(payload()).decision).toEqual(ok(payload()).decision);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Nothing extra survives
// ═════════════════════════════════════════════════════════════════════════

describe('the validated payload is a narrowing, not a passthrough', () => {
  it('drops fields the contract does not include', () => {
    /**
     * A model that volunteers `priority` must not have it persisted and later
     * mistaken for a decision Core made.
     */
    const r = ok(payload({ priority: 'Critical', product: 'iFile', subject: 'rewritten' }));
    expect(Object.keys(r.value).sort()).toEqual([
      'category',
      'category_confidence',
      'category_runner_up',
      'category_runner_up_confidence',
      'impact',
      'impact_confidence',
      'issue_type',
      'issue_type_confidence',
      'keywords_tags',
      'priority_factors',
      'rationale',
      'sentiment',
    ]);
  });

  it('never lets a model-supplied priority reach the decision', () => {
    const r = ok(payload({ priority: 'Critical', severity: 'critical' }));
    // Baseline only: the engine ignored the model's opinion entirely.
    expect(r.decision.priority).toBe('Normal');
    expect(r.decision.score).toBe(35);
  });
});

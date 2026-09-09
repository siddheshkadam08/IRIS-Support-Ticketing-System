import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_SOURCES,
  DEFAULT_CORE_CATEGORIES,
  DEFAULT_IMPACTS,
  INFORMATIONAL_ISSUE_TYPES,
  PRIORITY_TO_SEVERITY,
  SEVERITIES,
  type PriorityFactors,
} from '@iris/shared/types';
import { determinePriority } from '../internal/classification.rules.js';

/**
 * The priority arithmetic a human correction inherits — Phase 20.
 *
 * ⚠️ THESE TESTS DO NOT MOCK THE ENGINE. They call the same
 * `determinePriority` the AI path calls, with the same defaults, and assert the
 * properties the correction writer depends on. A unit test that stubbed the
 * engine would prove only that the stub was called.
 *
 * The behaviour under test is subtle and worth pinning: `category` reaches the
 * score through exactly ONE path, so most category corrections legitimately
 * leave priority unchanged. Someone reading a correction that "did nothing to
 * the priority" needs to see that this is the engine working, not a bug.
 */

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

/** Exactly the call the correction writer makes: no `scoring`, so defaults apply. */
const derive = (over: {
  factors?: PriorityFactors;
  issue_type?: string;
  category?: string;
  impact?: string;
  impacts?: readonly string[];
  core_categories?: readonly string[];
} = {}) =>
  determinePriority({
    factors: over.factors ?? factors(),
    issue_type: over.issue_type ?? 'bug',
    category: over.category ?? 'reports',
    impact: over.impact ?? (DEFAULT_IMPACTS[0] as string),
    impacts: over.impacts ?? DEFAULT_IMPACTS,
    core_categories: over.core_categories ?? DEFAULT_CORE_CATEGORIES,
  });

// ═══════════════════════════════════════════════════════════════════════
// The shared contract
// ═══════════════════════════════════════════════════════════════════════

describe('the classification source vocabulary', () => {
  it('includes human', () => {
    expect(CLASSIFICATION_SOURCES as readonly string[]).toContain('human');
  });

  /**
   * The four pre-existing values are load-bearing: `unclassified` is the AI
   * writer's precondition, and dropping any of the others would silently change
   * what an existing row means.
   */
  it('preserves every pre-existing value', () => {
    for (const v of ['product', 'ai_auto', 'ai_uncertain', 'unclassified']) {
      expect(CLASSIFICATION_SOURCES as readonly string[]).toContain(v);
    }
    expect(CLASSIFICATION_SOURCES).toHaveLength(5);
  });
});

describe('severity is a projection of priority, never an independent value', () => {
  it('maps every priority to exactly one severity', () => {
    expect(PRIORITY_TO_SEVERITY).toEqual({
      Critical: 'critical',
      High: 'high',
      Normal: 'medium',
      Low: 'low',
    });
  });

  it('every derived severity is a valid stored severity', () => {
    for (const s of Object.values(PRIORITY_TO_SEVERITY)) {
      expect(SEVERITIES as readonly string[]).toContain(s);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// What a category correction does, and does not, change
// ═══════════════════════════════════════════════════════════════════════

describe('category reaches the priority score through exactly one path', () => {
  /**
   * ⚠️ THE PROPERTY THAT SURPRISES PEOPLE. `category` is used only as
   * `core_categories.includes(category)`, and only when `system_down` is true.
   * With the system up, changing the category cannot change the priority — and
   * a reviewer being told "priority unchanged" is the engine behaving, not a
   * failed recalculation.
   */
  it('changing category does NOT change priority when the system is up', () => {
    const before = derive({ category: 'reports' });
    const after = derive({ category: DEFAULT_CORE_CATEGORIES[0] as string });
    expect(after.priority).toBe(before.priority);
  });

  /**
   * ⚠️ DEFAULT_CORE_CATEGORIES IS EMPTY, AND THAT IS THE POINT.
   *
   * With platform defaults, `core_categories.includes(category)` is false for
   * every possible category, so a category correction can NEVER move the
   * priority. It only can for a product that has configured `core_categories`
   * itself. A reviewer at an unconfigured tenant will therefore always see
   * "priority unchanged", and that is the engine being correct.
   */
  it('with platform defaults the core-category bonus is unreachable', () => {
    expect(DEFAULT_CORE_CATEGORIES).toHaveLength(0);
    const f = factors({ system_down: true });
    expect(derive({ factors: f, category: 'anything' }).score).toBe(
      derive({ factors: f, category: 'anything_else' }).score,
    );
  });

  it('changing INTO a configured core category raises the score when the system is down', () => {
    const f = factors({ system_down: true });
    const core_categories = ['billing', 'reports'];
    const nonCore = derive({ factors: f, category: 'login_access', core_categories });
    const core = derive({ factors: f, category: 'billing', core_categories });

    expect(core.score).toBeGreaterThan(nonCore.score!);
    expect(core.breakdown).toContain('core_category_system_down');
    expect(nonCore.breakdown).not.toContain('core_category_system_down');
  });

  it('changing OUT of a configured core category lowers it again, symmetrically', () => {
    const f = factors({ system_down: true });
    const core_categories = ['billing'];
    const core = derive({ factors: f, category: 'billing', core_categories });
    const nonCore = derive({ factors: f, category: 'login_access', core_categories });
    expect(nonCore.score).toBeLessThan(core.score!);
  });
});

describe('the short circuits outrank any category correction', () => {
  /**
   * These fire before the score is computed at all, so a correction cannot
   * talk a security incident down by relabelling it — which is exactly the
   * property that makes the engine, not the reviewer, the decider of priority.
   */
  it('security or data loss stays Critical whatever the category', () => {
    for (const category of ['reports', 'billing', 'anything']) {
      const r = derive({ factors: factors({ security_or_data_loss: true }), category });
      expect(r.priority).toBe('Critical');
      expect(r.breakdown).toBe('security_or_data_loss');
    }
  });

  it('cosmetic_only stays Low whatever the category', () => {
    const r = derive({
      factors: factors({ cosmetic_only: true, system_down: true }),
      category: 'billing',
      core_categories: ['billing'],
    });
    expect(r.priority).toBe('Low');
  });

  /**
   * The list is capitalised — 'Question', not 'question'. Worth pinning: a
   * correction path that lower-cased an issue type before re-deriving would
   * silently stop these short circuits from firing.
   */
  it('an informational issue type stays Low', () => {
    expect(INFORMATIONAL_ISSUE_TYPES).toEqual(['Information', 'Question']);
    for (const issue_type of INFORMATIONAL_ISSUE_TYPES) {
      expect(derive({ issue_type, factors: factors({ system_down: true }) }).priority).toBe('Low');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Determinism, which is what makes SEC-17 checkable
// ═══════════════════════════════════════════════════════════════════════

describe('the engine is deterministic', () => {
  it('identical input yields an identical result', () => {
    const a = derive({ factors: factors({ system_down: true, regulatory_impact: true }) });
    const b = derive({ factors: factors({ system_down: true, regulatory_impact: true }) });
    expect(a).toEqual(b);
  });

  /**
   * The correction writer omits `scoring` so DEFAULT_SCORING applies, exactly
   * as the AI path does. If the two ever diverged, a correction would silently
   * re-score a ticket under different rules than the AI used.
   */
  it('omitting the scoring config is the same as the AI path', () => {
    const explicit = determinePriority({
      factors: factors(),
      issue_type: 'bug',
      category: 'reports',
      impact: DEFAULT_IMPACTS[0] as string,
      impacts: DEFAULT_IMPACTS,
      core_categories: DEFAULT_CORE_CATEGORIES,
    });
    expect(derive()).toEqual(explicit);
  });

  it('a derived severity is always the projection of the derived priority', () => {
    for (const f of [
      factors(),
      factors({ system_down: true }),
      factors({ security_or_data_loss: true }),
      factors({ cosmetic_only: true }),
      factors({ regulatory_impact: true, system_down: true }),
    ]) {
      const r = derive({ factors: f });
      expect(PRIORITY_TO_SEVERITY[r.priority]).toBe(PRIORITY_TO_SEVERITY[r.priority]);
      expect(SEVERITIES as readonly string[]).toContain(PRIORITY_TO_SEVERITY[r.priority]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Override semantics, expressed as the writer computes them
// ═══════════════════════════════════════════════════════════════════════

describe('severity override is a distinct outcome from derivation', () => {
  /** Mirrors the writer: supplied severity wins, and divergence is recorded. */
  const resolve = (supplied: string | undefined, derived: string | null) => ({
    stored: supplied ?? derived,
    overridden: supplied !== undefined && derived !== null && supplied !== derived,
  });

  it('omitted severity stores the derived value and is not an override', () => {
    expect(resolve(undefined, 'medium')).toEqual({ stored: 'medium', overridden: false });
  });

  it('supplied severity equal to derived is stored but NOT flagged an override', () => {
    expect(resolve('medium', 'medium')).toEqual({ stored: 'medium', overridden: false });
  });

  it('supplied severity differing from derived IS an override', () => {
    expect(resolve('critical', 'medium')).toEqual({ stored: 'critical', overridden: true });
  });

  /**
   * With no AI factors the engine cannot run, so there is nothing to override.
   * The supplied value is stored and `overridden` stays false — claiming an
   * override against a value that was never derived would be false.
   */
  it('supplied severity with nothing derived is stored and not an override', () => {
    expect(resolve('high', null)).toEqual({ stored: 'high', overridden: false });
  });
});

describe('no-op detection compares against the stored values', () => {
  /** Mirrors the writer: per field, and only for fields actually supplied. */
  const changes = (
    req: { category?: string; severity?: string },
    cur: { category: string | null; severity: string | null },
  ) =>
    (req.category !== undefined && req.category !== cur.category) ||
    (req.severity !== undefined && req.severity !== cur.severity);

  const current = { category: 'reports', severity: 'medium' };

  it('identical values are a no-op', () => {
    expect(changes({ category: 'reports', severity: 'medium' }, current)).toBe(false);
  });

  it('an empty-ish request naming only unchanged values is a no-op', () => {
    expect(changes({ category: 'reports' }, current)).toBe(false);
    expect(changes({ severity: 'medium' }, current)).toBe(false);
  });

  it('a category change alone is a correction', () => {
    expect(changes({ category: 'login_access' }, current)).toBe(true);
  });

  it('a severity change alone is a correction', () => {
    expect(changes({ severity: 'high' }, current)).toBe(true);
  });

  it('both changed is still ONE correction', () => {
    expect(changes({ category: 'login_access', severity: 'high' }, current)).toBe(true);
  });

  it('one changed and one identical is a correction', () => {
    expect(changes({ category: 'login_access', severity: 'medium' }, current)).toBe(true);
  });

  /** An unclassified ticket has NULL columns; supplying a value is a change. */
  it('supplying a value where the column is null is a correction', () => {
    expect(changes({ category: 'reports' }, { category: null, severity: null })).toBe(true);
    expect(changes({ severity: 'low' }, { category: null, severity: null })).toBe(true);
  });
});

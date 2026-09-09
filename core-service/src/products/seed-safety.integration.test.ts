import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_AI_THRESHOLDS, DEFAULT_SCORING, type AIThresholds } from '@iris/shared/types';
import { closePool } from '../db/pool.js';
import { withSystemScope, type Tx } from '../db/with-scope.js';
import { determinePriority, determineRouting } from '../internal/classification.rules.js';

/**
 * The AI safety configuration, asserted against the DEPLOYED database.
 *
 * Pre-Phase-16 hardening. `auto_route_p1 = 1.01` disables unattended AI routing
 * and had been applied BY HAND to the live database only — while `seed.ts`
 * replaces `product.config` wholesale on conflict and did not carry it. One
 * `npm run seed` therefore restored the 0.8 default and re-enabled auto-routing
 * on a confidence signal Phase 4 measured as uncalibrated. Nine tickets were
 * auto-routed that way before the switch was applied.
 *
 * ⚠️ SO THIS TEST DELIBERATELY READS THE DATABASE, not the seed constants.
 *
 * A unit test over `tenantConfig()` would prove the seed intends the right
 * thing; only this proves the running system HAS it. That makes the test
 * environment-dependent on purpose: if someone restores a snapshot, edits
 * config by hand, or writes a migration that drops the key, this fails — which
 * is the entire point of a safety control.
 *
 *   npm run infra:up && npm run migrate && npm run seed
 *   npx vitest run core-service/src/products
 */

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('seed-safety', fn);

interface ProductRow {
  id: string;
  thresholds: AIThresholds | null;
  categories: Array<{ value: string }> | null;
  core_categories: string[] | null;
}

async function products(): Promise<ProductRow[]> {
  return sys(async (tx) => {
    const { rows } = await tx.query<ProductRow>(
      `SELECT id,
              config->'ai_thresholds'   AS thresholds,
              config->'categories'      AS categories,
              config->'core_categories' AS core_categories
         FROM product
        WHERE is_active = true
        ORDER BY id`,
    );
    return rows;
  });
}

afterAll(async () => {
  await closePool();
});

describe('⚠️ the auto-routing kill switch (A-1)', () => {
  it('every active product carries ai_thresholds', async () => {
    const rows = await products();
    // Positive control: a database with no products would make every assertion
    // below vacuously true.
    expect(rows.length, 'no active products — this suite would prove nothing').toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.thresholds, `${p.id} has no ai_thresholds — it would fall back to the 0.8 default`).not.toBeNull();
    }
  });

  it('⚠️ auto_route_p1 is ABOVE 1.0 on every product', async () => {
    for (const p of await products()) {
      expect(p.thresholds!.auto_route_p1, p.id).toBeGreaterThan(1.0);
    }
  });

  it('⚠️ makes auto_route UNREACHABLE at the maximum possible confidence', async () => {
    /**
     * The arithmetic, not the value. `category_confidence` is bounded at 1.0 by
     * the schema, so a threshold above 1.0 cannot be met — proved here by
     * running the real routing function at the most confident input that can
     * exist, rather than by asserting a number.
     */
    for (const p of await products()) {
      const perfect = determineRouting(1.0, 1.0, p.thresholds!);
      expect(perfect, `${p.id} would auto-route a perfectly confident ticket`).not.toBe('auto_route');
      expect(perfect).toBe('soft_route_ai_uncertain');
    }
  });

  it('and the default it would fall back to WOULD auto-route — which is why this matters', () => {
    // The counterfactual, so the test above cannot pass for a trivial reason.
    expect(determineRouting(1.0, 1.0, DEFAULT_AI_THRESHOLDS)).toBe('auto_route');
    expect(DEFAULT_AI_THRESHOLDS.auto_route_p1).toBeLessThan(1.0);
  });

  it('keeps the other thresholds inside their meaningful range', async () => {
    for (const p of await products()) {
      expect(p.thresholds!.triage_floor).toBeGreaterThan(0);
      expect(p.thresholds!.triage_floor).toBeLessThanOrEqual(1);
      expect(p.thresholds!.auto_route_margin).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('core_categories (B-1)', () => {
  it('is configured on every active product', async () => {
    const rows = await products();
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.core_categories, `${p.id} has no core_categories`).not.toBeNull();
      expect(p.core_categories!.length, `${p.id} has an empty core_categories`).toBeGreaterThan(0);
    }
  });

  it('⚠️ the +15 core-category branch can ACTUALLY FIRE with the live config', async () => {
    /**
     * The branch was dead in this deployment: `core_categories` was null, so
     * `input.core_categories.includes(category)` was never true and every
     * system-down ticket in a core workflow scored 15 points low, silently.
     *
     * This runs the real `determinePriority` twice on the same ticket, once
     * with the product's real core list and once with an empty one, and
     * requires the scores to differ by exactly the bonus. The paired run is the
     * control: if the branch were still dead, both would score the same and
     * this fails.
     */
    for (const p of await products()) {
      const category = p.core_categories![0]!;
      const base = {
        factors: {
          security_or_data_loss: false,
          system_down: true,
          hours_until_deadline: null,
          regulatory_impact: false,
          workaround_available: false,
          cosmetic_only: false,
          priority_factor_confidence: 0.9,
        },
        issue_type: 'bug',
        category,
        impacts: ['single_user', 'team', 'entire_customer'],
        impact: 'single_user',
      };

      const withCore = determinePriority({ ...base, core_categories: p.core_categories! });
      const without = determinePriority({ ...base, core_categories: [] });

      expect(withCore.score, `${p.id}: no score`).not.toBeNull();
      expect(withCore.score! - without.score!, `${p.id}: the core-category bonus did not fire`).toBe(
        DEFAULT_SCORING.core_category_system_down_bonus,
      );
      expect(withCore.breakdown).toContain('core_category_system_down');
    }
  });

  it('⚠️ satisfies core_categories ⊆ categories[].value', async () => {
    /**
     * The invariant `invalidCoreCategories` enforces on write. Asserted here on
     * the STORED state too, because a violation is silent at runtime: an
     * unmatched entry simply never matches, the +15 core-category bonus never
     * applies, and every affected ticket scores one tier low indefinitely.
     */
    for (const p of await products()) {
      const allowed = new Set((p.categories ?? []).map((c) => c.value));
      expect(allowed.size, `${p.id} has no categories`).toBeGreaterThan(0);
      for (const core of p.core_categories!) {
        expect(allowed.has(core), `${p.id}: core category "${core}" is not in categories`).toBe(true);
      }
    }
  });
});

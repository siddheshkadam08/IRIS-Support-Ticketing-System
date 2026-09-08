import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withSystemScope } from '../db/with-scope.js';
import { invalidCoreCategories } from '../products/product.repo.js';

/**
 * The classification taxonomy invariant — Phase 4 Step 3A.
 *
 *     core_categories ⊆ categories[].value
 *
 * THE BUG THIS SUITE EXISTS FOR: the original check was a zod refinement on the
 * REQUEST BODY, and this endpoint merges into stored config. So a request that
 * sent only one side of the relationship passed silently — which is precisely
 * when the check matters.
 *
 * The failure it lets through is invisible at runtime rather than loud: an
 * unmatched core_categories entry simply never matches, so the +15
 * core-category bonus quietly never applies and every affected ticket is scored
 * one tier too low, forever, with nothing logged.
 *
 * These tests therefore drive the REAL endpoint against the REAL database,
 * because the bug was in the seam between the request and the stored row —
 * exactly the part a unit test of either half would have missed.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/admin/taxonomy-config.test.ts
 */

const PRODUCT = 'prod_carbon';

let app: Awaited<ReturnType<typeof buildServer>>;
/** The product's real config, restored after every test in this file. */
let originalConfig: Record<string, unknown>;

const admin = () => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': 'su_taxonomy_test',
  'x-iris-role': 'product_admin',
  'x-iris-scope': PRODUCT,
});

const patch = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/admin/api/tenants/${PRODUCT}/widget-config`,
    headers: admin(),
    payload,
  });

const storedConfig = () =>
  withSystemScope('taxonomy-test', async (tx) => {
    const { rows } = await tx.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM product WHERE id = $1`,
      [PRODUCT],
    );
    return rows[0]!.config ?? {};
  });

/** Put the product back into a known shape before each scenario. */
const seedConfig = (over: Record<string, unknown>) =>
  withSystemScope('taxonomy-test', async (tx) => {
    await tx.query(`UPDATE product SET config = $2::jsonb WHERE id = $1`, [
      PRODUCT,
      JSON.stringify({ ...originalConfig, ...over }),
    ]);
  });

const CATEGORIES = [
  { value: 'login_access', label: 'Login / Access' },
  { value: 'reports', label: 'Reports' },
  { value: 'billing', label: 'Billing' },
];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  originalConfig = await storedConfig();
});

afterAll(async () => {
  // Never leave a shared development tenant reconfigured by a test run.
  await withSystemScope('taxonomy-test', async (tx) => {
    await tx.query(`UPDATE product SET config = $2::jsonb WHERE id = $1`, [
      PRODUCT,
      JSON.stringify(originalConfig),
    ]);
  });
  await app.close();
  await closePool();
});

// ═════════════════════════════════════════════════════════════════════════
// The pure invariant
// ═════════════════════════════════════════════════════════════════════════

describe('invalidCoreCategories', () => {
  it('accepts a subset', () => {
    expect(
      invalidCoreCategories({ categories: CATEGORIES, core_categories: ['reports'] }),
    ).toEqual([]);
  });

  it('names every value that is not a real category', () => {
    // "Invalid" without saying which value is a support ticket waiting to happen.
    expect(
      invalidCoreCategories({
        categories: CATEGORIES,
        core_categories: ['reports', 'ghost', 'phantom'],
      }),
    ).toEqual(['ghost', 'phantom']);
  });

  it('treats an empty core_categories as valid — nothing is core', () => {
    expect(invalidCoreCategories({ categories: CATEGORIES, core_categories: [] })).toEqual([]);
    expect(invalidCoreCategories({ categories: CATEGORIES })).toEqual([]);
  });

  it('rejects any core category when there are NO categories at all', () => {
    expect(invalidCoreCategories({ core_categories: ['reports'] })).toEqual(['reports']);
    expect(invalidCoreCategories({ categories: [], core_categories: ['reports'] })).toEqual([
      'reports',
    ]);
  });

  it('compares by value, not by label', () => {
    expect(
      invalidCoreCategories({
        categories: [{ value: 'reports', label: 'Reports' }],
        core_categories: ['Reports'],
      }),
      'a label is not an identifier',
    ).toEqual(['Reports']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Through the real endpoint
// ═════════════════════════════════════════════════════════════════════════

describe('1. full categories + valid core_categories', () => {
  it('is accepted and stored', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: [] });

    const res = await patch({
      categories: CATEGORIES,
      core_categories: ['reports', 'login_access'],
    });

    expect(res.statusCode, res.body).toBe(200);
    const stored = await storedConfig();
    expect(stored.core_categories).toEqual(['reports', 'login_access']);
  });
});

describe('2. full categories + invalid core_categories', () => {
  it('is rejected', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: [] });

    const res = await patch({ categories: CATEGORIES, core_categories: ['reports', 'ghost'] });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('ghost');
  });
});

describe('3. PARTIAL core_categories against EXISTING categories — valid', () => {
  it('is accepted, validated against what is already stored', async () => {
    /**
     * The first case the old body-level check could not see: `categories` is
     * absent from the request entirely, so the only place the relationship
     * exists is the merged config.
     */
    await seedConfig({ categories: CATEGORIES, core_categories: [] });

    const res = await patch({ core_categories: ['billing'] });

    expect(res.statusCode, res.body).toBe(200);
    expect((await storedConfig()).core_categories).toEqual(['billing']);
  });
});

describe('4. PARTIAL core_categories against EXISTING categories — invalid', () => {
  it('is REJECTED — this is the bug Step 3A fixes', async () => {
    /**
     * Before the fix this returned 200 and stored a core category that matches
     * nothing. Nothing would have errored; the priority engine would simply
     * have scored those tickets one tier low, silently, indefinitely.
     */
    await seedConfig({ categories: CATEGORIES, core_categories: ['reports'] });

    const res = await patch({ core_categories: ['reports', 'not_a_category'] });

    expect(res.statusCode, 'a partial update must not escape the invariant').toBe(400);
    expect(res.json().error.message).toContain('not_a_category');
  });
});

describe('5. PARTIAL categories, existing core_categories stay valid', () => {
  it('is accepted', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: ['reports'] });

    // Drops `login_access` but keeps `reports`, which is the core one.
    const res = await patch({
      categories: [
        { value: 'reports', label: 'Reports' },
        { value: 'billing', label: 'Billing' },
      ],
    });

    expect(res.statusCode, res.body).toBe(200);
    const stored = await storedConfig();
    expect(stored.core_categories).toEqual(['reports']);
    expect((stored.categories as unknown[]).length).toBe(2);
  });
});

describe('6. PARTIAL categories that would INVALIDATE existing core_categories', () => {
  it('is REJECTED — the other half of the same bug', async () => {
    /**
     * The mirror case: the request carries only `categories`, and narrowing
     * them would orphan a core category that is already stored. The old check
     * saw a request containing categories and no core_categories, and passed.
     */
    await seedConfig({ categories: CATEGORIES, core_categories: ['reports'] });

    const res = await patch({
      categories: [{ value: 'billing', label: 'Billing' }], // `reports` removed
    });

    expect(res.statusCode, 'narrowing categories must not orphan a core category').toBe(400);
    expect(res.json().error.message).toContain('reports');
  });

  it('rejects emptying categories while a core category exists', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: ['reports'] });
    expect((await patch({ categories: [] })).statusCode).toBe(400);
  });
});

describe('7. empty core_categories', () => {
  it('is accepted — declaring nothing core is a legitimate choice', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: ['reports'] });

    const res = await patch({ core_categories: [] });

    expect(res.statusCode, res.body).toBe(200);
    expect((await storedConfig()).core_categories).toEqual([]);
  });

  it('accepts a config that never mentions core_categories at all', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: undefined });
    expect((await patch({ categories: CATEGORIES })).statusCode).toBe(200);
  });
});

describe('8. a rejected write changes nothing', () => {
  it('leaves the stored configuration byte-for-byte identical', async () => {
    /**
     * The check runs inside the transaction, so throwing rolls back. Asserted
     * on the WHOLE config, not just the two taxonomy keys: this endpoint merges
     * widget branding, capabilities and flags in the same write, and a partial
     * application would be worse than a clean rejection.
     */
    await seedConfig({ categories: CATEGORIES, core_categories: ['reports'] });
    const before = await storedConfig();

    const res = await patch({
      // A valid change bundled with an invalid one.
      branding: { title: 'Should Not Be Saved' },
      suggestions: ['neither should this'],
      core_categories: ['reports', 'ghost'],
    });

    expect(res.statusCode).toBe(400);
    expect(await storedConfig(), 'the whole write must roll back').toEqual(before);
  });

  it('does not apply the valid half of a mixed update', async () => {
    await seedConfig({ categories: CATEGORIES, core_categories: [] });
    const before = await storedConfig();

    await patch({ issue_types: ['Bug', 'Question'], core_categories: ['nope'] });

    const after = await storedConfig();
    expect(after.issue_types, 'issue_types must not survive a rejected write').toEqual(
      before.issue_types,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// The refinements that legitimately stay on the body
// ═════════════════════════════════════════════════════════════════════════

describe('body-level refinements are unchanged', () => {
  it('still rejects duplicate issue_types', async () => {
    // A property of the submitted list alone, so the body is the right judge.
    expect((await patch({ issue_types: ['Bug', 'Bug'] })).statusCode).toBe(400);
  });

  it('still rejects duplicate impacts', async () => {
    expect((await patch({ impacts: ['One', 'One'] })).statusCode).toBe(400);
  });

  it('still rejects duplicate category values', async () => {
    const res = await patch({
      categories: [
        { value: 'reports', label: 'A' },
        { value: 'reports', label: 'B' },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('still enforces the list size bounds', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `Type${i}`);
    expect((await patch({ issue_types: tooMany })).statusCode).toBe(400);
    expect((await patch({ impacts: Array.from({ length: 11 }, (_, i) => `I${i}`) })).statusCode).toBe(
      400,
    );
  });
});

describe('authorization is unchanged', () => {
  it('an agent cannot edit taxonomy', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/api/tenants/${PRODUCT}/widget-config`,
      headers: { ...admin(), 'x-iris-role': 'agent' },
      payload: { core_categories: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});

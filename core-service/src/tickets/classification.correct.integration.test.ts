import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CORE_CATEGORIES,
  DEFAULT_IMPACTS,
  PRIORITY_TO_SEVERITY,
  type PriorityFactors,
} from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type Tx } from '../db/with-scope.js';
import { determinePriority } from '../internal/classification.rules.js';
import { applyClassification } from './ticket.repo.js';

/**
 * Human classification correction, against the REAL Postgres — Phase 20.
 *
 * Nothing is mocked. RLS enforces, the CHECK constraint from migration 019
 * enforces, and the priority engine under test is the one the AI path uses.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/tickets/classification.correct.integration.test.ts
 *
 * ⚠️ EVERY ISOLATION TEST CARRIES A POSITIVE CONTROL. "The foreign product got
 * a 404" passes just as well when the endpoint is broken for everyone, so each
 * refusal is paired with the same request succeeding for the rightful caller,
 * on the same ticket, in the same run.
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

let app: Awaited<ReturnType<typeof buildServer>>;
const madeTickets: string[] = [];

/** Categories this tenant actually has configured. Read once, live. */
let categoriesA: string[] = [];

// ─────────────────────────────────────────────────────────────────────────
// Callers
// ─────────────────────────────────────────────────────────────────────────

const admin = (role: string, scope: string, userId = 'su_corr_test') => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': userId,
  'x-iris-role': role,
  'x-iris-scope': scope,
});

const raiser = (productId: string) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-product-id': productId,
  'x-iris-role': 'raiser',
  'x-iris-raiser-ref': 'corr-test-raiser',
  'x-iris-tenant-id': 'tenant_corr_test',
});

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('corr-test', fn);

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const FACTORS: PriorityFactors = {
  security_or_data_loss: false,
  system_down: false,
  hours_until_deadline: null,
  regulatory_impact: false,
  workaround_available: false,
  cosmetic_only: false,
  priority_factor_confidence: 0.9,
};

async function makeTicket(productId: string, subject: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: raiser(productId),
    payload: JSON.stringify({
      product_tenant_id: 'tenant_corr_test',
      subject,
      description: `${subject} — Phase 20 correction suite.`,
    }),
  });
  const id = res.json().id as string;
  madeTickets.push(id);
  return id;
}

/** A ticket that has been AI-classified, so the engine has factors to reuse. */
async function classifiedTicket(
  productId: string,
  over: { category?: string; factors?: Partial<PriorityFactors>; issue_type?: string; impact?: string } = {},
) {
  const id = await makeTicket(productId, 'Export fails');
  const factors = { ...FACTORS, ...(over.factors ?? {}) };
  const category = over.category ?? categoriesA[0]!;
  const issue_type = over.issue_type ?? 'Bug';
  const impact = over.impact ?? (DEFAULT_IMPACTS[0] as string);

  const derived = determinePriority({
    factors,
    issue_type,
    category,
    impact,
    impacts: DEFAULT_IMPACTS,
    core_categories: DEFAULT_CORE_CATEGORIES,
  });

  await withScope({ productScope: [productId], role: 'none', requestId: 'corr-seed' }, (tx) =>
    applyClassification(tx, {
      ticketId: id,
      category,
      severity: PRIORITY_TO_SEVERITY[derived.priority],
      sentiment: 'Neutral (seeded by the Phase 20 suite)',
      classificationSource: 'ai_uncertain',
      aiClassification: {
        category,
        issue_type,
        impact,
        priority_factors: factors,
        decision: {
          priority: derived.priority,
          severity: PRIORITY_TO_SEVERITY[derived.priority],
          score: derived.score,
          score_breakdown: derived.breakdown,
        },
      },
    }),
  );
  return { id, category, factors, issue_type, impact, derived };
}

const correct = (
  hdrs: Record<string, string>,
  ticketId: string,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: 'PATCH',
    url: `/admin/api/tickets/${ticketId}/classification`,
    headers: hdrs,
    payload: JSON.stringify(body),
  });

const row = (id: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{
      category: string | null;
      severity: string | null;
      classification_source: string;
      ai_classification: Record<string, unknown> | null;
    }>(
      `SELECT category, severity, classification_source, ai_classification
         FROM ticket WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });

const corrections = (id: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{ action: string; before: any; after: any; actor_ref: string | null }>(
      `SELECT action, before, after, actor_ref FROM audit_event
        WHERE entity_type = 'ticket' AND entity_id = $1
          AND action = 'ticket.classification_corrected'
        ORDER BY occurred_at, id`,
      [id],
    );
    return rows;
  });

/** Every ticket column, so "nothing else moved" is checkable. */
const wholeTicket = (id: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM ticket WHERE id = $1`, [id]);
    return rows[0]!;
  });

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

beforeAll(async () => {
  app = await buildServer();
  categoriesA = await sys(async (tx) => {
    const { rows } = await tx.query<{ config: { categories?: Array<{ value: string }> } }>(
      `SELECT config FROM product WHERE id = $1`,
      [PRODUCT_A],
    );
    return (rows[0]?.config.categories ?? []).map((c) => c.value);
  });
  expect(categoriesA.length).toBeGreaterThan(1);
});

afterAll(async () => {
  await app.close();
  const c = new pg.Client({ connectionString: ADMIN_URL, application_name: 'iris-corr-test' });
  await c.connect();
  try {
    if (madeTickets.length) {
      await c.query(`DELETE FROM ai_execution WHERE ticket_id = ANY($1)`, [madeTickets]);
      await c.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
      await c.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
      await c.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
    }
  } finally {
    await c.end();
  }
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// Authorization
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-1..5 authorization', () => {
  it('SEC-1 a manager can correct', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: t.category, severity: (await row(t.id)).severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
    expect((await row(t.id)).classification_source).toBe('human');
  });

  it('SEC-2 a product_admin can correct', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('product_admin', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('SEC-3 a super_admin can correct', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('super_admin', `${PRODUCT_A},${PRODUCT_B}`), t.id, {
      category: categoriesA[1],
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('SEC-4 an agent is refused, and the ticket is untouched', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const before = await row(t.id);
    const res = await correct(admin('agent', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: before.category, severity: before.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect(await row(t.id)).toEqual(before);
    expect(await corrections(t.id)).toHaveLength(0);
  });

  it('SEC-5 an unauthenticated caller is refused', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/api/tickets/${t.id}/classification`,
      headers: { 'x-internal-key': config.INTERNAL_API_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ category: categoriesA[1], expected: { category: null, severity: null, classification_source: 'ai_uncertain' } }),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tenant isolation
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-6..7 isolation and non-disclosure', () => {
  it('SEC-6 a foreign product cannot correct, but the owner can', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const before = await row(t.id);
    const body = {
      category: categoriesA[1],
      expected: { category: before.category, severity: before.severity, classification_source: 'ai_uncertain' },
    };

    const foreign = await correct(admin('product_admin', PRODUCT_B), t.id, body);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('ticket_not_found');
    expect(await row(t.id)).toEqual(before);
    expect(await corrections(t.id)).toHaveLength(0);

    // Positive control, same ticket, same body.
    expect((await correct(admin('manager', PRODUCT_A), t.id, body)).statusCode).toBe(200);
  });

  it('SEC-7 a nonexistent ticket is indistinguishable from a foreign one', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const body = {
      category: categoriesA[1],
      expected: { category: null, severity: null, classification_source: 'ai_uncertain' },
    };
    const foreign = await correct(admin('product_admin', PRODUCT_B), t.id, body);
    const missing = await correct(admin('product_admin', PRODUCT_B), 'tkt_does_not_exist', body);

    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.json().error.code).toBe(foreign.json().error.code);
    expect(missing.json().error.message).toBe(foreign.json().error.message);
  });

  it('the refusal names neither the product nor the ticket subject', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const res = await correct(admin('product_admin', PRODUCT_B), t.id, {
      category: categoriesA[1],
      expected: { category: null, severity: null, classification_source: 'ai_uncertain' },
    });
    const text = JSON.stringify(res.json());
    expect(text).not.toContain(PRODUCT_A);
    expect(text).not.toContain('Export fails');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-8..9 validation', () => {
  it('SEC-8 a category outside the product configuration is refused', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: 'a_category_this_tenant_never_configured',
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
    expect(await corrections(t.id)).toHaveLength(0);
  });

  it('SEC-9 an invalid severity is refused', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      severity: 'catastrophic',
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('sending neither category nor severity is refused', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a field the endpoint does not accept is a loud 400, not a silent drop', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      status: 'resolved',
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Correction semantics
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-10..14 correction semantics and audit', () => {
  it('SEC-10 a no-op writes nothing and audits nothing', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const before = await wholeTicket(t.id);
    const r = await row(t.id);

    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: r.category,
      severity: r.severity,
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
    expect(await corrections(t.id)).toHaveLength(0);
    // Including classification_source: confirming is not correcting.
    expect(await wholeTicket(t.id)).toEqual(before);
    expect((await row(t.id)).classification_source).toBe('ai_uncertain');
  });

  it('SEC-11 a category-only correction writes exactly one audit event', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
    expect(await corrections(t.id)).toHaveLength(1);
    expect((await row(t.id)).category).toBe(categoriesA[1]);
  });

  it('SEC-12 a severity-only correction writes exactly one audit event', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const target = r.severity === 'critical' ? 'low' : 'critical';
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      severity: target,
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
    expect(await corrections(t.id)).toHaveLength(1);
    const after = await row(t.id);
    expect(after.severity).toBe(target);
    // Omitted category is preserved, not nulled.
    expect(after.category).toBe(r.category);
  });

  it('SEC-13 correcting both fields writes exactly ONE audit event', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      severity: 'critical',
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    expect(res.statusCode).toBe(200);
    expect(await corrections(t.id)).toHaveLength(1);
  });

  it('SEC-14 the audit records the true before and after', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    await correct(admin('manager', PRODUCT_A, 'su_named_reviewer'), t.id, {
      category: categoriesA[1],
      severity: 'high',
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });

    const [event] = await corrections(t.id);
    expect(event!.before).toEqual({
      category: r.category,
      severity: r.severity,
      classification_source: 'ai_uncertain',
    });
    expect(event!.after).toMatchObject({
      category: categoriesA[1],
      severity: 'high',
      classification_source: 'human',
    });
    expect(event!.actor_ref).toBe('su_named_reviewer');
    // No customer content anywhere in the row.
    const text = JSON.stringify(event);
    expect(text).not.toContain('Export fails');
    expect(text).not.toContain('Phase 20 correction suite');
  });

  it('a human ticket can be corrected again', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r1 = await row(t.id);
    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: r1.category, severity: r1.severity, classification_source: 'ai_uncertain' },
    });

    const r2 = await row(t.id);
    const res = await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[0],
      expected: { category: r2.category, severity: r2.severity, classification_source: 'human' },
    });
    expect(res.statusCode).toBe(200);
    expect(await corrections(t.id)).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The AI record, and the AI writer
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-15..16 the AI record is immutable and cannot overwrite a human', () => {
  it('SEC-15 ai_classification and ai_execution.result are unchanged by a correction', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const before = await row(t.id);
    const executionsBefore = await sys(async (tx) => {
      const { rows } = await tx.query(`SELECT result FROM ai_execution WHERE ticket_id = $1`, [t.id]);
      return JSON.stringify(rows);
    });

    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      severity: 'critical',
      expected: { category: before.category, severity: before.severity, classification_source: 'ai_uncertain' },
    });

    const after = await row(t.id);
    // The AI's own record on the ticket is byte-identical.
    expect(after.ai_classification).toEqual(before.ai_classification);
    const executionsAfter = await sys(async (tx) => {
      const { rows } = await tx.query(`SELECT result FROM ai_execution WHERE ticket_id = $1`, [t.id]);
      return JSON.stringify(rows);
    });
    expect(executionsAfter).toBe(executionsBefore);
  });

  /**
   * ⚠️ THE GUARANTEE IS INHERITED, NOT ADDED. `applyClassification` updates only
   * `WHERE classification_source = 'unclassified'`, so a late or replayed AI
   * result matches zero rows once a human has corrected. Phase 20 modifies that
   * function not at all; this test proves the inheritance holds.
   */
  it('SEC-16 a late AI result cannot overwrite a human correction', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      severity: 'low',
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    const human = await row(t.id);

    const applied = await withScope(
      { productScope: [PRODUCT_A], role: 'none', requestId: 'late-ai' },
      (tx) =>
        applyClassification(tx, {
          ticketId: t.id,
          category: categoriesA[0]!,
          severity: 'critical',
          sentiment: 'Angry (a late AI result)',
          classificationSource: 'ai_auto',
          aiClassification: { category: categoriesA[0], late: true },
        }),
    );

    expect(applied).toBe(false);
    expect(await row(t.id)).toEqual(human);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Priority
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-17 priority is derived by the existing engine', () => {
  it('an omitted severity stores exactly what determinePriority produced', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const nextCategory = categoriesA[1]!;

    await correct(admin('manager', PRODUCT_A), t.id, {
      category: nextCategory,
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });

    const expected = determinePriority({
      factors: t.factors,
      issue_type: t.issue_type,
      category: nextCategory,
      impact: t.impact,
      impacts: DEFAULT_IMPACTS,
      core_categories: DEFAULT_CORE_CATEGORIES,
    });

    const [event] = await corrections(t.id);
    expect(event!.after.derived_priority).toBe(expected.priority);
    expect(event!.after.derived_severity).toBe(PRIORITY_TO_SEVERITY[expected.priority]);
    expect((await row(t.id)).severity).toBe(PRIORITY_TO_SEVERITY[expected.priority]);
    expect(event!.after.severity_overridden).toBe(false);
  });

  it('a supplied severity that differs is recorded as an override', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const opposite = r.severity === 'critical' ? 'low' : 'critical';

    await correct(admin('manager', PRODUCT_A), t.id, {
      severity: opposite,
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });

    const [event] = await corrections(t.id);
    expect(event!.after.severity).toBe(opposite);
    expect(event!.after.severity_overridden).toBe(true);
    // The engine's own answer is still recorded beside it.
    expect(event!.after.derived_severity).not.toBe(opposite);
  });

  it('a supplied severity equal to the derived one is NOT an override', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    const derived = PRIORITY_TO_SEVERITY[
      determinePriority({
        factors: t.factors,
        issue_type: t.issue_type,
        category: categoriesA[1]!,
        impact: t.impact,
        impacts: DEFAULT_IMPACTS,
        core_categories: DEFAULT_CORE_CATEGORIES,
      }).priority
    ];

    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      severity: derived,
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });

    const [event] = await corrections(t.id);
    expect(event!.after.severity_overridden).toBe(false);
  });

  /**
   * With platform defaults `core_categories` is empty, so a category correction
   * cannot move the priority. Recorded as such rather than hidden.
   */
  it('a category correction that does not change priority still records the derivation', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const r = await row(t.id);
    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    const [event] = await corrections(t.id);
    expect(event!.after.derived_severity).toBe(r.severity);
    expect((await row(t.id)).severity).toBe(r.severity);
  });

  it('a security short circuit keeps the derived priority Critical whatever the category', async () => {
    const t = await classifiedTicket(PRODUCT_A, { factors: { security_or_data_loss: true } });
    const r = await row(t.id);
    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      expected: { category: r.category, severity: r.severity, classification_source: 'ai_uncertain' },
    });
    const [event] = await corrections(t.id);
    expect(event!.after.derived_priority).toBe('Critical');
    expect((await row(t.id)).severity).toBe('critical');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Unclassified tickets
// ═══════════════════════════════════════════════════════════════════════

describe('a ticket with no AI classification', () => {
  it('is refused without an explicit severity, because nothing can be derived', async () => {
    const id = await makeTicket(PRODUCT_A, 'Never classified');
    const res = await correct(admin('manager', PRODUCT_A), id, {
      category: categoriesA[1],
      expected: { category: null, severity: null, classification_source: 'unclassified' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/severity/i);
    expect(await corrections(id)).toHaveLength(0);
  });

  it('is accepted with an explicit severity, and says why nothing was derived', async () => {
    const id = await makeTicket(PRODUCT_A, 'Never classified either');
    const res = await correct(admin('manager', PRODUCT_A), id, {
      category: categoriesA[1],
      severity: 'high',
      expected: { category: null, severity: null, classification_source: 'unclassified' },
    });
    expect(res.statusCode).toBe(200);

    const [event] = await corrections(id);
    expect(event!.after.derived_priority).toBeNull();
    expect(event!.after.reason).toBe('no_ai_factors');
    expect(event!.after.severity_overridden).toBe(false);
    expect((await row(id)).classification_source).toBe('human');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Concurrency, RLS, blast radius
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-18..20 concurrency, RLS and blast radius', () => {
  it('SEC-19 a stale expected state is refused and writes nothing', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const original = await row(t.id);

    // First reviewer wins.
    expect(
      (await correct(admin('manager', PRODUCT_A), t.id, {
        category: categoriesA[1],
        expected: { category: original.category, severity: original.severity, classification_source: 'ai_uncertain' },
      })).statusCode,
    ).toBe(200);

    const afterFirst = await wholeTicket(t.id);

    // Second reviewer submits the state they loaded before the first won.
    const stale = await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[0],
      expected: { category: original.category, severity: original.severity, classification_source: 'ai_uncertain' },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('invalid_state_transition');
    expect(await wholeTicket(t.id)).toEqual(afterFirst);
    expect(await corrections(t.id)).toHaveLength(1);
  });

  it('SEC-18 RLS is still enabled and forced on ticket', async () => {
    const r = await sys(async (tx) => {
      const { rows } = await tx.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ticket'`,
      );
      return rows[0]!;
    });
    expect(r.relrowsecurity).toBe(true);
    expect(r.relforcerowsecurity).toBe(true);
  });

  it('SEC-20 no field other than category, severity, source and updated_at moves', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const before = await wholeTicket(t.id);

    await correct(admin('manager', PRODUCT_A), t.id, {
      category: categoriesA[1],
      severity: 'high',
      expected: { category: before.category, severity: before.severity, classification_source: 'ai_uncertain' },
    });

    const after = await wholeTicket(t.id);
    const moved = Object.keys(before).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    expect(moved.sort()).toEqual(['category', 'classification_source', 'severity', 'updated_at']);
  });

  /**
   * ⚠️ PROBED UNDER A PRODUCT SCOPE, NOT SYSTEM SCOPE. `ticket_isolation`'s
   * WITH CHECK is `product_id = ANY (app_scope())` and system scope carries an
   * EMPTY scope, so an unscoped write is refused by RLS before Postgres ever
   * evaluates the CHECK constraint — and the test would then pass for the
   * wrong reason, proving RLS rather than the migration.
   */
  it('the migration allows human and still rejects an invented source', async () => {
    const t = await classifiedTicket(PRODUCT_A);
    const scoped = <T>(fn: (tx: Tx) => Promise<T>) =>
      withScope({ productScope: [PRODUCT_A], role: 'super_admin', requestId: 'check-probe' }, fn);

    // The value migration 019 added is accepted.
    await expect(
      scoped((tx) =>
        tx.query(`UPDATE ticket SET classification_source = 'human' WHERE id = $1`, [t.id]),
      ),
    ).resolves.toBeDefined();

    // Anything outside the five is still refused by the constraint itself.
    await expect(
      scoped((tx) =>
        tx.query(`UPDATE ticket SET classification_source = 'robot' WHERE id = $1`, [t.id]),
      ),
    ).rejects.toThrow(/classification_source_check|check constraint/i);
  });
});

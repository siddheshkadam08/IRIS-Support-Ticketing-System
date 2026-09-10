import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORRECTION_DISCLAIMER, MIN_SAMPLE_FOR_RATE } from '@iris/shared/types';
import type { GovernanceResponse } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { GOVERNANCE_CORRECTIONS_SQL } from './governance.repo.js';

/**
 * Phase 21 — human classification corrections, end to end.
 *
 * ⚠️ EVERY WINDOW HERE IS IN 2021, AND THAT IS THE WHOLE TEST DESIGN.
 *
 * The live stack writes audit rows continuously, so a test that asserted exact
 * counts over "the last 30 days" would be measuring the dev environment and
 * would fail for reasons that have nothing to do with this code. Each scenario
 * below therefore owns a disjoint far-past window that nothing else can reach,
 * and every count in it is known in advance. The Phase 17 suite established
 * this pattern with 2019; 2021 stays clear of it so the two cannot interfere.
 *
 * ⚠️ FIXTURES ARE WRITTEN AND REMOVED WITH THE MIGRATION CREDENTIAL. `iris_app`
 * holds INSERT and SELECT on `audit_event` and nothing else — the audit trail
 * is append-only to the application by design, which is exactly why a test
 * cannot clean up after itself through it. Nothing in the assertions uses that
 * connection: every read goes through the real route, real roles and real RLS.
 *
 * ⚠️ NO CORRECTION IS PERFORMED HERE. Phase 20's write path is not exercised,
 * imported or touched. These are audit rows shaped exactly as that path emits
 * them, and a separate test binds that shape to the exported interface so the
 * two cannot drift apart silently.
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

/** Every fixture carries this in `request_id`, and purge keys off it. */
const TAG = 'req_p21corr';

/** Disjoint windows, one scenario each. */
const W = {
  /** The mixed deterministic population. */
  main: { from: '2021-03-01T00:00:00.000Z', to: '2021-03-02T00:00:00.000Z' },
  /** Deliberately empty. */
  empty: { from: '2021-01-01T00:00:00.000Z', to: '2021-01-02T00:00:00.000Z' },
  /** One short of the threshold. */
  below: { from: '2021-04-01T00:00:00.000Z', to: '2021-04-02T00:00:00.000Z' },
  /** Exactly the threshold. */
  atThreshold: { from: '2021-05-01T00:00:00.000Z', to: '2021-05-02T00:00:00.000Z' },
  /** Rows sitting exactly on both edges. */
  boundary: { from: '2021-06-01T00:00:00.000Z', to: '2021-06-02T00:00:00.000Z' },
  /** A row whose `severity_overridden` is not a boolean. */
  malformed: { from: '2021-07-01T00:00:00.000Z', to: '2021-07-02T00:00:00.000Z' },
  /** A row with no ticket reference. */
  orphan: { from: '2021-08-01T00:00:00.000Z', to: '2021-08-02T00:00:00.000Z' },
} as const;

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: pg.Client;

// ─────────────────────────────────────────────────────────────────────────
// Callers
// ─────────────────────────────────────────────────────────────────────────

const headers = (over: Record<string, string> = {}) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': 'su_p21_corr',
  'x-iris-role': 'manager',
  'x-iris-scope': PRODUCT_A,
  ...over,
});

const asSuper = () => headers({ 'x-iris-role': 'super_admin', 'x-iris-scope': '' });
const asManagerA = () => headers({ 'x-iris-role': 'manager', 'x-iris-scope': PRODUCT_A });
const asManagerB = () => headers({ 'x-iris-role': 'manager', 'x-iris-scope': PRODUCT_B });
const asProductAdminA = () => headers({ 'x-iris-role': 'product_admin', 'x-iris-scope': PRODUCT_A });
const asAgent = () => headers({ 'x-iris-role': 'agent', 'x-iris-scope': PRODUCT_A });
const asRaiser = () => headers({ 'x-iris-role': 'raiser', 'x-iris-scope': PRODUCT_A });

function get(query: Record<string, string>, hdrs: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return app.inject({ method: 'GET', url: `/admin/api/ai/governance?${qs}`, headers: hdrs });
}

async function report(
  hdrs: Record<string, string>,
  query: Record<string, string>,
): Promise<GovernanceResponse> {
  const res = await get(query, hdrs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as GovernanceResponse;
}

/** The panel alone, which is all most assertions below care about. */
async function corrections(
  hdrs: Record<string, string>,
  query: Record<string, string>,
): Promise<GovernanceResponse['corrections']> {
  return (await report(hdrs, query)).corrections;
}

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — audit rows shaped exactly as Phase 20 writes them
// ─────────────────────────────────────────────────────────────────────────

interface Before {
  category: string | null;
  severity: string | null;
  classification_source: string;
}

interface After {
  category: string | null;
  severity: string | null;
  classification_source: 'human';
  derived_priority: string | null;
  derived_severity: string | null;
  /** `unknown` so a malformed fixture can be written deliberately. */
  severity_overridden: unknown;
  reason?: 'no_ai_factors';
}

interface Correction {
  at: string;
  product: string;
  /** null writes a row with no ticket reference — the defensive case. */
  ticket: string | null;
  before: Before;
  after: After;
}

let seq = 0;

async function seed(c: Correction): Promise<void> {
  seq += 1;
  await admin.query(
    `INSERT INTO audit_event
       (product_id, actor_type, actor_ref, action, entity_type, entity_id,
        before, after, request_id, source_ip, occurred_at)
     VALUES ($1,'support_user',$2,'ticket.classification_corrected','ticket',$3,
             $4::jsonb,$5::jsonb,$6,NULL,$7)`,
    [
      c.product,
      `su_p21_reviewer_${seq % 3}`,
      c.ticket,
      JSON.stringify(c.before),
      JSON.stringify(c.after),
      `${TAG}_${seq}`,
      c.at,
    ],
  );
}

/** A correction the priority engine could score. */
const derived = (severity: string, overridden: boolean, priority = 'Normal') => ({
  classification_source: 'human' as const,
  derived_priority: priority,
  derived_severity: severity,
  severity_overridden: overridden,
});

/** A correction on a ticket with no stored AI factors — engine could not run. */
const notDerived = () => ({
  classification_source: 'human' as const,
  derived_priority: null,
  derived_severity: null,
  severity_overridden: false,
  reason: 'no_ai_factors' as const,
});

async function purge(): Promise<void> {
  await admin.query(`DELETE FROM audit_event WHERE request_id LIKE $1`, [`${TAG}_%`]);
}

/**
 * The hand-built population for `W.main`, product A.
 *
 * Chosen so every count differs from every other, which is the only way a
 * transposed assertion fails rather than passing by coincidence:
 *
 *   events                            7
 *   tickets                           5   (t4 corrected three times)
 *   tickets_corrected_more_than_once  1
 *   category_changes                  3
 *   severity_changes                  5
 *   severity_overrides                2
 *   override_eligible                 6   (the product-sourced one cannot score)
 *   prior_source                      5 distinct values
 */
async function seedMain(): Promise<void> {
  const P = PRODUCT_A;
  const at = (h: number) => `2021-03-01T${String(h).padStart(2, '0')}:00:00.000Z`;

  // 1. Category only, from ai_auto.
  await seed({
    at: at(1),
    product: P,
    ticket: 't_p21_1',
    before: { category: 'billing', severity: 'high', classification_source: 'ai_auto' },
    after: { category: 'reports', severity: 'high', ...derived('high', false, 'High') },
  });

  // 2. Severity only, from ai_uncertain.
  await seed({
    at: at(2),
    product: P,
    ticket: 't_p21_2',
    before: { category: 'reports', severity: 'low', classification_source: 'ai_uncertain' },
    after: { category: 'reports', severity: 'high', ...derived('high', false, 'High') },
  });

  // 3. Both, from unclassified — ⚠️ NULL on both sides of `before`. This is the
  //    row `<>` would have dropped from both change counts.
  await seed({
    at: at(3),
    product: P,
    ticket: 't_p21_3',
    before: { category: null, severity: null, classification_source: 'unclassified' },
    after: { category: 'reports', severity: 'medium', ...derived('medium', false) },
  });

  // 4. A severity override, from ai_auto. Category unchanged.
  await seed({
    at: at(4),
    product: P,
    ticket: 't_p21_4',
    before: { category: 'reports', severity: 'medium', classification_source: 'ai_auto' },
    after: { category: 'reports', severity: 'critical', ...derived('medium', true) },
  });

  // 5. The SAME ticket again — a second override, now from 'human'.
  await seed({
    at: at(5),
    product: P,
    ticket: 't_p21_4',
    before: { category: 'reports', severity: 'critical', classification_source: 'human' },
    after: { category: 'reports', severity: 'high', ...derived('medium', true) },
  });

  // 6. And a third, settling back onto the derived value.
  await seed({
    at: at(6),
    product: P,
    ticket: 't_p21_4',
    before: { category: 'reports', severity: 'high', classification_source: 'human' },
    after: { category: 'reports', severity: 'medium', ...derived('medium', false) },
  });

  // 7. From 'product', on a ticket the engine could not score.
  await seed({
    at: at(7),
    product: P,
    ticket: 't_p21_5',
    before: { category: 'login_access', severity: 'low', classification_source: 'product' },
    after: { category: 'reports', severity: 'low', ...notDerived() },
  });

  // Product B, so isolation has something to hide.
  for (const [i, h] of [8, 9].entries()) {
    await seed({
      at: at(h),
      product: PRODUCT_B,
      ticket: `t_p21_b${i}`,
      before: { category: 'billing', severity: 'low', classification_source: 'ai_auto' },
      after: { category: 'reports', severity: 'high', ...derived('high', true, 'High') },
    });
  }
}

/** N eligible corrections in a window, `overrides` of them overriding. */
async function seedBulk(
  window: { from: string },
  count: number,
  overrides: number,
): Promise<void> {
  const day = window.from.slice(0, 10);
  for (let i = 0; i < count; i += 1) {
    const minute = String(i).padStart(2, '0');
    await seed({
      at: `${day}T06:${minute}:00.000Z`,
      product: PRODUCT_A,
      ticket: `t_p21_bulk_${day}_${i}`,
      before: { category: 'billing', severity: 'low', classification_source: 'ai_auto' },
      after: {
        category: 'billing',
        severity: i < overrides ? 'critical' : 'medium',
        ...derived('medium', i < overrides),
      },
    });
  }
}

async function seedAll(): Promise<void> {
  await seedMain();

  await seedBulk(W.below, MIN_SAMPLE_FOR_RATE - 1, 10);
  await seedBulk(W.atThreshold, MIN_SAMPLE_FOR_RATE, 12);

  // Boundary: one row exactly at `from` (inside) and one exactly at `to`
  // (outside, because the window is half-open).
  for (const [i, at] of [W.boundary.from, W.boundary.to].entries()) {
    await seed({
      at,
      product: PRODUCT_A,
      ticket: `t_p21_edge_${i}`,
      before: { category: 'billing', severity: 'low', classification_source: 'ai_auto' },
      after: { category: 'reports', severity: 'medium', ...derived('medium', false) },
    });
  }

  // ⚠️ A malformed boolean. `(after->>'severity_overridden')::boolean` would
  // abort the WHOLE governance response on this row, taking every unrelated
  // metric down with it. The text comparison skips it instead.
  await seed({
    at: '2021-07-01T06:00:00.000Z',
    product: PRODUCT_A,
    ticket: 't_p21_bad',
    before: { category: 'billing', severity: 'low', classification_source: 'ai_auto' },
    after: {
      category: 'billing',
      severity: 'high',
      classification_source: 'human',
      derived_priority: 'Normal',
      derived_severity: 'medium',
      severity_overridden: 'yes, definitely',
    },
  });
  await seed({
    at: '2021-07-01T07:00:00.000Z',
    product: PRODUCT_A,
    ticket: 't_p21_good',
    before: { category: 'billing', severity: 'low', classification_source: 'ai_auto' },
    after: { category: 'billing', severity: 'critical', ...derived('medium', true) },
  });

  // A correction with no ticket reference. Should never happen; must be visible.
  await seed({
    at: '2021-08-01T06:00:00.000Z',
    product: PRODUCT_A,
    ticket: null,
    before: { category: 'billing', severity: 'low', classification_source: 'ai_auto' },
    after: { category: 'reports', severity: 'medium', ...derived('medium', false) },
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  admin = new pg.Client({ connectionString: ADMIN_URL, application_name: 'p21-corr-fixtures' });
  await admin.connect();

  await purge();
  await seedAll();
});

afterAll(async () => {
  await purge().catch(() => undefined);
  await admin.end().catch(() => undefined);
  await app.close();
  await closePool();
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Zero corrections
// ═════════════════════════════════════════════════════════════════════════

describe('a window with no corrections', () => {
  it('reports zero events, not a suppressed rate and not a percentage', async () => {
    const c = await corrections(asManagerA(), W.empty);
    expect(c.events).toBe(0);
    expect(c.tickets).toBe(0);
    expect(c.category_changes).toBe(0);
    expect(c.severity_changes).toBe(0);
    expect(c.severity_overrides).toBe(0);
    expect(c.override_eligible).toBe(0);
    expect(c.prior_source).toEqual([]);
  });

  /** ⚠️ `none`, not `insufficient`. Nothing happened is not too little data. */
  it('distinguishes no observations from too few', async () => {
    const c = await corrections(asManagerA(), W.empty);
    expect(c.sample).toBe('none');
    expect(c.severity_override_rate).toBeNull();
  });

  it('says so in a caveat, in words that make no claim about the AI', async () => {
    const r = await report(asManagerA(), W.empty);
    const text = r.caveats.join(' ');
    expect(text).toContain('No classification corrections were recorded');
    expect(text).toContain('not a finding about the AI');
  });

  it('the panel still applies — it is empty, not withheld', async () => {
    const c = await corrections(asManagerA(), W.empty);
    expect(c.applies_to_filter).toBe(true);
    expect(c.population).toBe('corrections');
    expect(c.source).toBe('audit_event');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2, 3, 13. Events versus tickets
// ═════════════════════════════════════════════════════════════════════════

describe('correction events and corrected tickets are different numbers', () => {
  it('counts seven decisions across five tickets', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.events).toBe(7);
    expect(c.tickets).toBe(5);
  });

  /**
   * ⚠️ THE SUBSTITUTION THIS PHASE EXISTS TO PREVENT. One ticket was corrected
   * three times. Reporting 7 as "tickets corrected" would overstate the number
   * of tickets a reviewer touched by 40%.
   */
  it('three corrections on one ticket do not inflate the ticket count', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.tickets_corrected_more_than_once).toBe(1);
    expect(c.events - c.tickets).toBe(2);
  });

  it('a single correction is one event and one ticket', async () => {
    const c = await corrections(asManagerA(), W.boundary);
    expect(c.events).toBe(1);
    expect(c.tickets).toBe(1);
    expect(c.tickets_corrected_more_than_once).toBe(0);
  });

  it('spells the difference out in a caveat rather than leaving it to arithmetic', async () => {
    const r = await report(asManagerA(), W.main);
    expect(r.caveats.join(' ')).toContain('never interchangeable');
  });

  it('a correction with no ticket reference is counted and flagged', async () => {
    const c = await corrections(asManagerA(), W.orphan);
    expect(c.events).toBe(1);
    expect(c.tickets).toBe(0);
    expect(c.events_without_ticket).toBe(1);
  });

  it('the deterministic population has no orphans, so the flag stays at zero', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.events_without_ticket).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4, 5, 6, 7. What changed
// ═════════════════════════════════════════════════════════════════════════

describe('what a correction changed', () => {
  it('counts category and severity changes independently', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.category_changes).toBe(3);
    expect(c.severity_changes).toBe(5);
  });

  /**
   * ⚠️ THE NULL CASE, WHICH `<>` WOULD HAVE SILENTLY DROPPED. An unclassified
   * ticket has NULL category and NULL severity. `NULL <> 'reports'` is NULL,
   * so a naive predicate excludes the correction that first gave the ticket a
   * classification at all — the most consequential kind there is.
   *
   * `category_changes` is 3 only if that row counted. Two of the three come
   * from non-null transitions; the third is this one.
   */
  it('a change from NULL counts as a change', async () => {
    const c = await corrections(asManagerA(), W.main);
    // Remove the null-origin correction and the counts must both drop by one.
    await admin.query(
      `DELETE FROM audit_event WHERE entity_id = 't_p21_3' AND request_id LIKE $1`,
      [`${TAG}_%`],
    );
    const after = await corrections(asManagerA(), W.main);
    expect(after.category_changes).toBe(c.category_changes - 1);
    expect(after.severity_changes).toBe(c.severity_changes - 1);
    // Put it back; every later assertion depends on the full population.
    await seed({
      at: '2021-03-01T03:00:00.000Z',
      product: PRODUCT_A,
      ticket: 't_p21_3',
      before: { category: null, severity: null, classification_source: 'unclassified' },
      after: { category: 'reports', severity: 'medium', ...derived('medium', false) },
    });
    const restored = await corrections(asManagerA(), W.main);
    expect(restored.category_changes).toBe(c.category_changes);
    expect(restored.severity_changes).toBe(c.severity_changes);
  });

  /**
   * ⚠️ A correction that changed both fields is ONE event. Phase 20 writes one
   * audit row per decision, never one per field, so the two change counts
   * overlap and must not be added.
   */
  it('the change counts overlap and do not sum to the event count', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.category_changes + c.severity_changes).toBeGreaterThan(c.events);
    const r = await report(asManagerA(), W.main);
    expect(r.caveats.join(' ')).toContain('do not sum to the number of corrections');
  });

  it('counts severity overrides, and only where the engine actually ran', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.severity_overrides).toBe(2);
    expect(c.override_eligible).toBe(6);
    // Seven corrections, six eligible: the product-sourced one had no factors.
    expect(c.events - c.override_eligible).toBe(1);
  });

  it('an override is always a severity change, never the other way round', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.severity_overrides).toBeLessThanOrEqual(c.severity_changes);
    expect(c.severity_overrides).toBeLessThanOrEqual(c.override_eligible);
  });

  /**
   * ⚠️ A cast to boolean would abort the ENTIRE governance response here, not
   * just this panel. The response must still arrive, with the unreadable row
   * counted in `events` and excluded from the override count.
   */
  it('a malformed severity_overridden is skipped, not fatal', async () => {
    const r = await report(asManagerA(), W.malformed);
    expect(r.corrections.events).toBe(2);
    expect(r.corrections.severity_overrides).toBe(1);
    expect(r.corrections.override_eligible).toBe(2);
    // And the rest of the report is intact.
    expect(r.meta.governance_version).toBe('ai-governance-v1');
    expect(r.population).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 8. Prior classification source
// ═════════════════════════════════════════════════════════════════════════

describe('the classification source each correction replaced', () => {
  it('reports every source present, including human on a repeat correction', async () => {
    const c = await corrections(asManagerA(), W.main);
    const byKey = Object.fromEntries(c.prior_source.map((s) => [s.key, s.n]));
    expect(byKey).toEqual({
      ai_auto: 2,
      ai_uncertain: 1,
      unclassified: 1,
      human: 2,
      product: 1,
    });
  });

  it('the source counts sum to the event count', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.prior_source.reduce((s, r) => s + r.n, 0)).toBe(c.events);
  });

  it('is ordered by count, so the page needs no sort of its own', async () => {
    const c = await corrections(asManagerA(), W.main);
    const counts = c.prior_source.map((s) => s.n);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  /**
   * ⚠️ GROUPED, NOT ENUMERATED. A sixth classification source added later must
   * appear here on its own rather than vanishing into a hardcoded list.
   */
  it('an unforeseen source value appears rather than being dropped', async () => {
    await seed({
      at: '2021-01-01T06:00:00.000Z',
      product: PRODUCT_A,
      ticket: 't_p21_future',
      before: { category: 'billing', severity: 'low', classification_source: 'imported_v2' },
      after: { category: 'reports', severity: 'medium', ...derived('medium', false) },
    });
    const c = await corrections(asManagerA(), W.empty);
    expect(c.prior_source).toEqual([{ key: 'imported_v2', n: 1 }]);
    await admin.query(`DELETE FROM audit_event WHERE entity_id = 't_p21_future'`);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 10. Half-open window
// ═════════════════════════════════════════════════════════════════════════

describe('⚠️ half-open window semantics', () => {
  /**
   * With an inclusive upper bound a correction at exactly midnight belongs to
   * two adjacent days and every period-over-period comparison is wrong by
   * however many rows landed on the boundary.
   */
  it('includes a correction at `from` and excludes one at `to`', async () => {
    const c = await corrections(asManagerA(), W.boundary);
    expect(c.events).toBe(1);
  });

  it('the excluded row belongs to the NEXT window, and is not lost', async () => {
    const next = await corrections(asManagerA(), {
      from: W.boundary.to,
      to: '2021-06-03T00:00:00.000Z',
    });
    expect(next.events).toBe(1);
  });

  it('a window covering both edges sees both', async () => {
    const both = await corrections(asManagerA(), {
      from: W.boundary.from,
      to: '2021-06-03T00:00:00.000Z',
    });
    expect(both.events).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 11, 12. Suppression
// ═════════════════════════════════════════════════════════════════════════

describe('⚠️ the severity override share, and when it is withheld', () => {
  it('withholds the share one observation short of the threshold', async () => {
    const c = await corrections(asManagerA(), W.below);
    expect(c.override_eligible).toBe(MIN_SAMPLE_FOR_RATE - 1);
    expect(c.sample).toBe('insufficient');
    expect(c.severity_override_rate).toBeNull();
  });

  /** ⚠️ Null, never 0. A zero percent is a measurement; null is an admission. */
  it('never publishes a zero in place of a withheld share', async () => {
    for (const w of [W.empty, W.below]) {
      const c = await corrections(asManagerA(), w);
      expect(c.severity_override_rate).toBeNull();
      expect(c.severity_override_rate).not.toBe(0);
    }
  });

  it('still publishes the counts while withholding the share', async () => {
    const c = await corrections(asManagerA(), W.below);
    expect(c.severity_overrides).toBe(10);
    expect(c.events).toBe(MIN_SAMPLE_FOR_RATE - 1);
  });

  it('publishes the share at exactly the threshold', async () => {
    const c = await corrections(asManagerA(), W.atThreshold);
    expect(c.override_eligible).toBe(MIN_SAMPLE_FOR_RATE);
    expect(c.sample).toBe('sufficient');
    expect(c.severity_override_rate).toBe(0.4);
    expect(c.severity_overrides).toBe(12);
  });

  it('the share is numerator over denominator, both from the same rows', async () => {
    const c = await corrections(asManagerA(), W.atThreshold);
    expect(c.severity_override_rate).toBeCloseTo(c.severity_overrides / c.override_eligible, 6);
  });

  it('explains the suppression in words rather than leaving a blank', async () => {
    const r = await report(asManagerA(), W.below);
    const text = r.caveats.join(' ');
    expect(text).toContain('withheld');
    expect(text).toContain(String(MIN_SAMPLE_FOR_RATE));
  });

  it('says what the share is measured against once it IS published', async () => {
    const r = await report(asManagerA(), W.atThreshold);
    const text = r.caveats.join(' ');
    expect(text).toContain('deterministic');
    expect(text).toContain('not against the AI');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 9, 15. Isolation
// ═════════════════════════════════════════════════════════════════════════

describe('⚠️ product isolation, with a positive control on both sides', () => {
  /**
   * The anti-vacuity rule. An isolation test over an empty product passes for
   * the wrong reason, so both products are proved non-empty FIRST.
   */
  it('a manager sees their own tenant and not the other', async () => {
    const a = await corrections(asManagerA(), W.main);
    const b = await corrections(asManagerB(), W.main);

    expect(a.events, 'A must be non-empty or this proves nothing').toBe(7);
    expect(b.events, 'B must be non-empty or this proves nothing').toBe(2);
    expect(a.events).not.toBe(b.events);
  });

  it('the platform total is the sum, so neither manager saw everything', async () => {
    const platform = await corrections(asSuper(), W.main);
    expect(platform.events).toBe(9);
    expect(platform.tickets).toBe(7);
  });

  /**
   * ⚠️ `app_scope()` IS EMPTY FOR A SUPER ADMIN — RLS carries them on the
   * `app_role() = 'super_admin'` branch. A panel written as
   * `product_id = ANY(app_scope())` returns nothing for the platform
   * administrator and looks exactly like "no corrections". This is the test
   * that catches that.
   */
  it('the super-admin view is NON-EMPTY', async () => {
    const c = await corrections(asSuper(), W.main);
    expect(c.events).toBeGreaterThan(0);
  });

  it('an explicit product filter narrows within scope', async () => {
    const c = await corrections(asSuper(), { ...W.main, product_id: PRODUCT_B });
    expect(c.events).toBe(2);
  });

  it('a foreign product filter is refused, not silently narrowed', async () => {
    const res = await get({ ...W.main, product_id: PRODUCT_B }, asManagerA());
    expect(res.statusCode).toBe(404);
  });

  /**
   * ⚠️ RLS, NOT THE PREDICATE, IS THE BOUNDARY. Manager B asks with no product
   * filter at all, so the `$3` predicate is NULL and contributes nothing. Only
   * `audit_isolation` stands between them and product A's corrections.
   */
  it('with no product filter, RLS alone still hides the other tenant', async () => {
    const b = await corrections(asManagerB(), W.main);
    expect(b.events).toBe(2);
    expect(b.prior_source).toEqual([{ key: 'ai_auto', n: 2 }]);
    // Product A's distinctive sources are absent.
    const keys = b.prior_source.map((s) => s.key);
    expect(keys).not.toContain('unclassified');
    expect(keys).not.toContain('product');
    expect(keys).not.toContain('human');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 14. Access
// ═════════════════════════════════════════════════════════════════════════

describe('who may read the correction panel', () => {
  it('manager and product_admin are both served', async () => {
    for (const h of [asManagerA(), asProductAdminA()]) {
      const c = await corrections(h, W.main);
      expect(c.events).toBe(7);
    }
  });

  it('an agent is refused — governance is a management surface', async () => {
    expect((await get(W.main, asAgent())).statusCode).toBe(403);
  });

  it('a raiser is not an admin role at all', async () => {
    expect((await get(W.main, asRaiser())).statusCode).toBe(401);
  });

  it('an unauthenticated caller is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/ai/governance?from=${W.main.from}&to=${W.main.to}`,
      headers: { 'x-internal-key': config.INTERNAL_API_KEY },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * ⚠️ NO CONTENT-TYPE ON PURPOSE. With `application/json` and no body Fastify
   * fails in the body parser before the router can answer, and the test would
   * be asserting on the parser rather than on the route table. Sent bare, an
   * unrouted verb produces the 404 that actually proves the point.
   */
  it('no mutation verb is exposed on the governance route', async () => {
    const { 'content-type': _ct, ...noBody } = asManagerA();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/admin/api/ai/governance', headers: noBody });
      expect(res.statusCode, `${method} must not be routed`).toBe(404);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Feature filter
// ═════════════════════════════════════════════════════════════════════════

describe('the feature filter, where it applies and where it cannot', () => {
  it('classification is the filter the panel measures', async () => {
    const c = await corrections(asManagerA(), { ...W.main, feature: 'classification' });
    expect(c.applies_to_filter).toBe(true);
    expect(c.events).toBe(7);
  });

  /**
   * ⚠️ WITHHELD, NOT ZEROED. Corrections exist for classification only. Showing
   * `events: 0` under a summary filter would read as "no corrections happened",
   * which is a different and false statement.
   */
  it('summary withholds the panel rather than reporting zeros as fact', async () => {
    const c = await corrections(asManagerA(), { ...W.main, feature: 'summary' });
    expect(c.applies_to_filter).toBe(false);
    expect(c.population).toBe('corrections+filtered_out');
    expect(c.events).toBe(0);
    expect(c.sample).toBe('none');
    expect(c.severity_override_rate).toBeNull();
  });

  it('and says why, so the zeros above cannot be misread', async () => {
    const r = await report(asManagerA(), { ...W.main, feature: 'summary' });
    const text = r.caveats.join(' ');
    expect(text).toContain('not reported under this feature filter');
    expect(text).toContain('rather than shown as zero');
  });

  it('an ungoverned feature is still a 400, unchanged by this phase', async () => {
    expect((await get({ ...W.main, feature: 'noop' }, asManagerA())).statusCode).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Nothing leaks, nothing else moved
// ═════════════════════════════════════════════════════════════════════════

describe('⚠️ the panel exposes counts and nothing else', () => {
  it('no category or severity VALUE reaches the response', async () => {
    const r = await report(asManagerA(), W.main);
    const body = JSON.stringify(r.corrections);
    for (const leak of ['billing', 'login_access', 'reports', 'critical', 'medium']) {
      expect(body, `${leak} must not appear`).not.toContain(leak);
    }
  });

  it('no ticket id, reviewer or audit payload reaches the response', async () => {
    const r = await report(asManagerA(), W.main);
    const body = JSON.stringify(r.corrections);
    expect(body).not.toContain('t_p21_');
    expect(body).not.toContain('su_p21_reviewer');
    expect(body).not.toContain('derived_priority');
    expect(body).not.toContain('before');
  });

  it('the response says its own source and population, as every panel must', async () => {
    const c = await corrections(asManagerA(), W.main);
    expect(c.source).toBe('audit_event');
    expect(c.population).toBe('corrections');
  });

  it('carries the disclaimer that denies the causal claim', async () => {
    const r = await report(asManagerA(), W.main);
    expect(r.caveats).toContain(CORRECTION_DISCLAIMER);
  });

  /**
   * ⚠️ CORRECTIONS ARE NOT EXECUTIONS. Adding an audit-sourced count to an
   * execution-sourced one produces a number that means nothing, and the page
   * has three sources now rather than two.
   */
  it('correction counts are never folded into the execution figures', async () => {
    const r = await report(asManagerA(), W.main);
    expect(r.executions.population).toBe('headline');
    expect(r.corrections.population).toBe('corrections');
    // The main window holds corrections and no executions at all — proof the
    // two populations are independent rather than merely differently named.
    expect(r.corrections.events).toBe(7);
    expect(r.executions.n).toBe(0);
  });

  /**
   * ⚠️ A window with corrections and no executions is exactly where the
   * empty-execution early return would have swallowed every correction caveat.
   */
  it('correction caveats survive a window with no executions', async () => {
    const r = await report(asManagerA(), W.main);
    expect(r.population.headline).toBe(0);
    expect(r.caveats).toContain(CORRECTION_DISCLAIMER);
    expect(r.caveats.join(' ')).toContain('never interchangeable');
  });

  it('human_correction_rate stays declared unmeasurable', async () => {
    const r = await report(asManagerA(), W.main);
    expect(r.unmeasurable).toContain('human_correction_rate');
    expect(r.unmeasurable).toContain('accuracy');
  });

  it('the governance version is unchanged — no existing figure moved', async () => {
    const r = await report(asManagerA(), W.main);
    expect(r.meta.governance_version).toBe('ai-governance-v1');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Query shape and cost
// ═════════════════════════════════════════════════════════════════════════

describe('the correction query reads one table, once', () => {
  /**
   * ⚠️ ONE SCAN, NOT NINE. Nine metrics are computed here, and written the
   * obvious way each would carry its own `FROM audit_event`. The CTE chain
   * exists so that a metric physically cannot re-scan the table with a
   * slightly different predicate — which is how denominators drift apart.
   */
  it('mentions audit_event exactly once', () => {
    const occurrences = GOVERNANCE_CORRECTIONS_SQL.match(/FROM audit_event/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('never touches ai_execution — a correction is not an execution', () => {
    expect(GOVERNANCE_CORRECTIONS_SQL).not.toContain('ai_execution');
    expect(GOVERNANCE_CORRECTIONS_SQL).not.toContain('event_outbox');
  });

  it('never touches the ticket table, so nothing depends on current state', () => {
    // The audit row is the record. Reading `ticket` would make a metric change
    // retroactively every time somebody corrected a ticket again.
    expect(GOVERNANCE_CORRECTIONS_SQL).not.toMatch(/\bFROM ticket\b/);
  });

  it('binds every request-derived value and interpolates none', () => {
    for (const p of ['$1', '$2', '$3']) expect(GOVERNANCE_CORRECTIONS_SQL).toContain(p);
    expect(GOVERNANCE_CORRECTIONS_SQL).not.toContain('$4');
    // The action and entity_type are compile-time literals, not parameters.
    expect(GOVERNANCE_CORRECTIONS_SQL).toContain("a.action      = 'ticket.classification_corrected'");
  });

  it('uses IS DISTINCT FROM, never a bare inequality, on the change counts', () => {
    expect(GOVERNANCE_CORRECTIONS_SQL).toContain('before_category IS DISTINCT FROM after_category');
    expect(GOVERNANCE_CORRECTIONS_SQL).toContain('before_severity IS DISTINCT FROM after_severity');
  });

  it('compares the override flag as text, never casting jsonb to boolean', () => {
    expect(GOVERNANCE_CORRECTIONS_SQL).toContain("overridden_text = 'true'");
    expect(GOVERNANCE_CORRECTIONS_SQL).not.toContain('::boolean');
  });

  it('is half-open on the window, so adjacent periods cannot double-count', () => {
    expect(GOVERNANCE_CORRECTIONS_SQL).toContain('a.occurred_at >= $1');
    expect(GOVERNANCE_CORRECTIONS_SQL).toContain('a.occurred_at <  $2');
  });
});

describe('cost, measured rather than assumed', () => {
  /**
   * ⚠️ NO INDEX WAS ADDED FOR THIS QUERY, and that was a decision rather than
   * an oversight. `action` is unindexed; with a product filter the planner has
   * `audit_product_time_idx (product_id, occurred_at DESC)` and without one it
   * scans the window. Adding an index would mean a migration, which this phase
   * excluded, so the obligation is to MEASURE and report instead of assuming.
   *
   * The ceiling is deliberately generous — this is a regression tripwire for
   * something pathological, not a benchmark. A dev box under load must not
   * turn a green suite red.
   */
  const CEILING_MS = 2_000;

  const explain = async (productId: string | null) => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const started = Date.now();
    const { rows } = await admin.query<{ 'QUERY PLAN': unknown[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${GOVERNANCE_CORRECTIONS_SQL}`,
      [from, to, productId],
    );
    return { plan: rows[0]!['QUERY PLAN'], elapsed: Date.now() - started };
  };

  it('completes over a live 30-day window, scoped to one product', async () => {
    const { plan, elapsed } = await explain(PRODUCT_A);
    const total = (plan[0] as { 'Execution Time': number })['Execution Time'];
    // eslint-disable-next-line no-console
    console.log(`[p21] corrections EXPLAIN, one product: ${total.toFixed(1)} ms execution`);
    expect(total).toBeLessThan(CEILING_MS);
    expect(elapsed).toBeLessThan(CEILING_MS * 5);
  });

  /** The unfiltered platform view is the worst case, so it is the one to watch. */
  it('completes over a live 30-day window with no product filter', async () => {
    const { plan } = await explain(null);
    const total = (plan[0] as { 'Execution Time': number })['Execution Time'];
    // eslint-disable-next-line no-console
    console.log(`[p21] corrections EXPLAIN, all products: ${total.toFixed(1)} ms execution`);
    expect(total).toBeLessThan(CEILING_MS);
  });

  it('the whole report, correction panel included, stays fast through the route', async () => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const r = await report(asManagerA(), { from, to });
    // eslint-disable-next-line no-console
    console.log(`[p21] full governance report: ${r.meta.query_ms} ms`);
    expect(r.meta.query_ms).toBeLessThan(CEILING_MS * 3);
  });
});

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AI_GOVERNANCE_VERSION,
  MIN_SAMPLE_FOR_RATE,
  PROHIBITED_CLAIM_TERMS,
  assertsProhibitedClaim,
} from '@iris/shared/types';
import type { GovernanceResponse } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { GOVERNANCE_METRICS_SQL } from './governance.repo.js';

/**
 * Phase 17 — AI Governance: integration and security.
 *
 * ⚠️ TWO KINDS OF EVIDENCE, AND BOTH ARE NEEDED.
 *
 *   DETERMINISTIC   a hand-built population in a window nothing else touches,
 *                   where every count is known in advance. This is what proves
 *                   the population arithmetic, the replay split and the LEFT
 *                   JOIN, because on live data those numbers move.
 *
 *   LIVE            the same endpoint over the real corpus, which is what
 *                   proves isolation means anything. An isolation test on an
 *                   empty product passes for the wrong reason, so every one of
 *                   them asserts non-emptiness FIRST. A zero-row response is
 *                   INCONCLUSIVE, never a pass.
 *
 * ⚠️ FIXTURES ARE WRITTEN AND REMOVED WITH THE MIGRATION CREDENTIAL, not the
 * application one. `iris_app` has DELETE revoked on `ai_execution` — execution
 * history is the governance record and the application must not be able to
 * erase it. That guarantee is exactly why a test cannot clean up after itself
 * through the app, and why cleanup here uses the same credential migrations do.
 * Nothing in the assertions below uses that connection: every read goes through
 * the real route, the real roles and real RLS.
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

/** A window in the far past, so the fixture population is exactly the fixtures. */
const W1_FROM = '2019-06-01T00:00:00.000Z';
const W1_TO = '2019-06-02T00:00:00.000Z';
/** A second window, for the half-open boundary rows. */
const W2_A = '2019-07-01T00:00:00.000Z';
const W2_B = '2019-07-02T00:00:00.000Z';
const W2_END = '2019-07-03T00:00:00.000Z';

const FIXTURE_TAG = 'p17gov';

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: pg.Client;
let ticketA: string;
let ticketB: string;

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

// ─────────────────────────────────────────────────────────────────────────
// Callers
// ─────────────────────────────────────────────────────────────────────────

const headers = (over: Record<string, string> = {}) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': 'su_p17_gov',
  'x-iris-role': 'manager',
  'x-iris-scope': PRODUCT_A,
  ...over,
});

const asSuper = () => headers({ 'x-iris-role': 'super_admin', 'x-iris-scope': '' });
const asManagerA = () => headers({ 'x-iris-role': 'manager', 'x-iris-scope': PRODUCT_A });
const asManagerB = () => headers({ 'x-iris-role': 'manager', 'x-iris-scope': PRODUCT_B });
const asProductAdminA = () => headers({ 'x-iris-role': 'product_admin', 'x-iris-scope': PRODUCT_A });
const asAgent = () => headers({ 'x-iris-role': 'agent', 'x-iris-scope': PRODUCT_A });

function get(query: Record<string, string>, hdrs: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return app.inject({ method: 'GET', url: `/admin/api/ai/governance?${qs}`, headers: hdrs });
}

/** The fixture window, which every deterministic assertion below uses. */
const W1 = { from: W1_FROM, to: W1_TO };

async function report(
  hdrs: Record<string, string>,
  query: Record<string, string> = W1,
): Promise<GovernanceResponse> {
  const res = await get(query, hdrs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as GovernanceResponse;
}

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

interface Fixture {
  key: string;
  product: 'A' | 'B';
  feature: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  attempt?: number;
  errorCode?: string | null;
  latencyMs?: number | null;
  confidence?: number | null;
  fallback?: boolean;
  /** none = no outbox row at all; replay = outbox payload carries replay_of. */
  outbox: 'none' | 'plain' | 'replay';
  /** Milliseconds the outbox row precedes the execution, for queue delay. */
  queuedMsBefore?: number;
  routing?: string | null;
}

/**
 * The hand-built population.
 *
 * Chosen so that every layer of the pipeline is exercised and every count is
 * known in advance:
 *
 *   L1 scoped   7
 *   excluded    2  (one ungoverned feature, one test-artifact code)
 *   L2 corpus   5
 *   L3' replay  1
 *   L3 headline 4  ← and one of those four has NO outbox row
 */
const FIXTURES: Fixture[] = [
  {
    key: 'plain-ok',
    product: 'A',
    feature: 'classification',
    status: 'succeeded',
    createdAt: '2019-06-01T06:00:00.000Z',
    completedAt: '2019-06-01T06:00:04.000Z',
    latencyMs: 1200,
    confidence: 0.82,
    outbox: 'plain',
    queuedMsBefore: 500,
    routing: 'soft_route_ai_uncertain',
  },
  {
    key: 'plain-failed',
    product: 'A',
    feature: 'summary',
    status: 'failed',
    createdAt: '2019-06-01T07:00:00.000Z',
    completedAt: '2019-06-01T07:00:09.000Z',
    attempt: 3,
    errorCode: 'invalid_ai_output',
    outbox: 'plain',
    queuedMsBefore: 900,
  },
  {
    // ⚠️ SEC-16. A replay is a real, measurable execution that must not be
    // counted alongside the original work it re-runs.
    key: 'replay',
    product: 'A',
    feature: 'classification',
    status: 'succeeded',
    createdAt: '2019-06-01T08:00:00.000Z',
    completedAt: '2019-06-01T08:00:03.000Z',
    latencyMs: 2500,
    confidence: 0.91,
    outbox: 'replay',
    queuedMsBefore: 300,
  },
  {
    // ⚠️ SEC-17. THE ROW THE FIRST DESIGN WOULD HAVE LOST. An INNER JOIN to the
    // outbox drops it from every headline figure with no error anywhere.
    key: 'no-outbox',
    product: 'A',
    feature: 'classification',
    status: 'succeeded',
    createdAt: '2019-06-01T09:00:00.000Z',
    completedAt: '2019-06-01T09:00:02.000Z',
    latencyMs: null,
    fallback: true,
    outbox: 'none',
  },
  {
    // Excluded by the corpus rule: the stub feature.
    key: 'noop',
    product: 'A',
    feature: 'noop',
    status: 'succeeded',
    createdAt: '2019-06-01T10:00:00.000Z',
    completedAt: '2019-06-01T10:00:01.000Z',
    outbox: 'plain',
  },
  {
    // Excluded by the corpus rule: a test-only error code.
    key: 'test-artifact',
    product: 'A',
    feature: 'classification',
    status: 'failed',
    createdAt: '2019-06-01T11:00:00.000Z',
    errorCode: 'test_cleanup',
    outbox: 'plain',
  },
  {
    // The other tenant, for isolation inside the deterministic window.
    key: 'other-tenant',
    product: 'B',
    feature: 'classification',
    status: 'succeeded',
    createdAt: '2019-06-01T12:00:00.000Z',
    completedAt: '2019-06-01T12:00:05.000Z',
    latencyMs: 3300,
    confidence: 0.55,
    outbox: 'plain',
    queuedMsBefore: 700,
  },
  // ── half-open boundary rows, in their own window ──────────────────────
  {
    key: 'boundary-a',
    product: 'A',
    feature: 'classification',
    status: 'succeeded',
    createdAt: W2_A,
    completedAt: '2019-07-01T00:00:01.000Z',
    outbox: 'plain',
  },
  {
    key: 'boundary-b',
    product: 'A',
    feature: 'classification',
    status: 'succeeded',
    createdAt: W2_B,
    completedAt: '2019-07-02T00:00:01.000Z',
    outbox: 'plain',
  },
];

const eventIdOf = (key: string) => `evt_${FIXTURE_TAG}_${key}`;
const execIdOf = (key: string) => `aix_${FIXTURE_TAG}_${key}`;

/** Remove anything a previous (possibly crashed) run left in the fixture windows. */
async function purge(): Promise<void> {
  await admin.query(`DELETE FROM ai_execution  WHERE id LIKE $1`, [`aix_${FIXTURE_TAG}_%`]);
  await admin.query(`DELETE FROM event_outbox  WHERE event_id LIKE $1`, [`evt_${FIXTURE_TAG}_%`]);
}

async function seedFixtures(): Promise<void> {
  for (const f of FIXTURES) {
    const productId = f.product === 'A' ? PRODUCT_A : PRODUCT_B;
    const ticketId = f.product === 'A' ? ticketA : ticketB;
    const eventId = eventIdOf(f.key);

    if (f.outbox !== 'none') {
      const payload =
        f.outbox === 'replay'
          ? // The exact shape the replay endpoint emits.
            JSON.stringify({ ticket_id: ticketId, replay_of: 'aix_original', ai_features: [f.feature] })
          : JSON.stringify({ ticket_id: ticketId });
      const enqueuedAt = new Date(
        new Date(f.createdAt).getTime() - (f.queuedMsBefore ?? 0),
      ).toISOString();
      await admin.query(
        `INSERT INTO event_outbox (event_id, product_id, aggregate, aggregate_id, event_type,
                                   payload, request_id, created_at, published_at)
         VALUES ($1,$2,'ticket',$3,'ticket.created',$4::jsonb,$5,$6,$6)`,
        [eventId, productId, ticketId, payload, `req_${eventId}`, enqueuedAt],
      );
    }

    const result =
      f.routing === undefined || f.routing === null
        ? null
        : JSON.stringify({ decision: { routing_decision: f.routing, composite_confidence: f.confidence } });

    await admin.query(
      `INSERT INTO ai_execution (id, product_id, ticket_id, feature, event_id, job_id,
                                 correlation_id, status, attempt, provider, model, model_version,
                                 prompt_version, confidence, latency_ms, result, fallback_used,
                                 error_code, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'azure','azure/gpt-4.1','2024-12-01-preview',
               $10,$11,$12,$13::jsonb,$14,$15,$16,$17)`,
      [
        execIdOf(f.key),
        productId,
        ticketId,
        f.feature,
        eventId,
        `aij_${FIXTURE_TAG}_${f.key}`,
        `req_${eventId}`,
        f.status,
        f.attempt ?? 1,
        `${f.feature}-v1`,
        f.confidence ?? null,
        f.latencyMs ?? null,
        result,
        f.fallback ?? false,
        f.errorCode ?? null,
        f.createdAt,
        f.completedAt ?? null,
      ],
    );
  }
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  admin = new pg.Client({ connectionString: ADMIN_URL, application_name: 'p17-gov-fixtures' });
  await admin.connect();

  // Real tickets, so the foreign keys hold. Nothing is created or deleted here:
  // borrowing an existing ticket avoids leaving ticket debris behind, and the
  // governance surface never reads ticket content anyway.
  const a = await admin.query<{ id: string }>(
    `SELECT id FROM ticket WHERE product_id = $1 ORDER BY raised_at LIMIT 1`,
    [PRODUCT_A],
  );
  const b = await admin.query<{ id: string }>(
    `SELECT id FROM ticket WHERE product_id = $1 ORDER BY raised_at LIMIT 1`,
    [PRODUCT_B],
  );
  expect(a.rows[0], `${PRODUCT_A} must have a ticket for fixtures to reference`).toBeDefined();
  expect(b.rows[0], `${PRODUCT_B} must have a ticket for fixtures to reference`).toBeDefined();
  ticketA = a.rows[0]!.id;
  ticketB = b.rows[0]!.id;

  await purge();
  await seedFixtures();
});

afterAll(async () => {
  await purge().catch(() => undefined);
  await admin.end().catch(() => undefined);
  await app.close();
  await closePool();
});

// ═════════════════════════════════════════════════════════════════════════
// Population integrity — the deterministic window
// ═════════════════════════════════════════════════════════════════════════

describe('⚠️ the population layers', () => {
  it('reports L1, the exclusions, L2, L3 and L3 prime for the requested window', async () => {
    const r = await report(asSuper());
    expect(r.population.scoped).toBe(7);
    expect(r.population.corpus).toBe(5);
    expect(r.population.replays).toBe(1);
    expect(r.population.headline).toBe(4);

    const reasons = Object.fromEntries(r.population.excluded_from_corpus.map((e) => [e.reason, e.n]));
    expect(reasons['feature_not_governed']).toBe(1);
    expect(reasons['test_artifact']).toBe(1);
  });

  it('⚠️ the identity holds: L1 = L2 + excluded, and L2 = L3 + replays', async () => {
    const r = await report(asSuper());
    const excluded = r.population.excluded_from_corpus.reduce((s, e) => s + e.n, 0);
    expect(r.population.scoped).toBe(r.population.corpus + excluded);
    expect(r.population.corpus).toBe(r.population.headline + r.population.replays);
    expect(r.population.identity_holds).toBe(true);
  });

  it('⚠️ every population count obeys the product filter, not just the metrics', async () => {
    /**
     * The correction that produced this test: the first draft reported the
     * whole table's 13,187 rows as "scoped" inside a 30-day window. A corpus
     * panel that ignores the filters is worse than no panel — it is an
     * authoritative-looking number describing a different question.
     */
    const r = await report(asSuper(), { ...W1, product_id: PRODUCT_B });
    expect(r.population.scoped).toBe(1);
    expect(r.population.corpus).toBe(1);
    expect(r.population.headline).toBe(1);
    expect(r.population.identity_holds).toBe(true);
  });

  it('scopes the population to what the caller may see', async () => {
    const a = await report(asManagerA());
    // Six of the seven fixtures belong to product A.
    expect(a.population.scoped).toBe(6);
    expect(a.population.headline).toBe(3);
    expect(a.population.identity_holds).toBe(true);
  });
});

describe('⚠️ SEC-16 — replays are excluded from every headline metric', () => {
  it('counts the replay in its own layer, and nowhere else', async () => {
    const r = await report(asSuper());

    // POSITIVE CONTROL FIRST. Without this the assertions below would pass just
    // as well if the replay fixture had never been created.
    expect(r.replays.n, 'the replay fixture must be identified as a replay').toBe(1);
    expect(r.replays.rows[0]?.feature).toBe('classification');

    // The replay is a succeeded classification. If it leaked into the headline
    // population these would read 5 and 4.
    expect(r.executions.n).toBe(4);
    expect(r.executions.succeeded).toBe(3);
    expect(r.executions.failed).toBe(1);
  });

  it('no headline metric has an n larger than the headline population', async () => {
    const r = await report(asSuper());
    const headline = r.population.headline;
    const ns: Array<[string, number]> = [
      ['executions', r.executions.n],
      ['success_rate', r.executions.success_rate_n],
      ['provider_latency', r.latency.provider.n],
      ['wall_clock', r.latency.wall_clock.n],
      ['queue_delay', r.latency.queue_delay.n],
      ['attempts', r.attempts.n],
      ['failures', r.failures.n],
      ['confidence', r.confidence.n],
      ['routing', r.routing.n],
      ['inventory', r.inventory.n],
      ['by_feature', r.by_feature.rows.reduce((s, f) => s + f.n, 0)],
      ['by_product', r.by_product.rows.reduce((s, p) => s + p.n, 0)],
    ];
    for (const [name, n] of ns) {
      expect(n, `${name} must not exceed the headline population`).toBeLessThanOrEqual(headline);
    }
  });

  it('every metric declares which population it stands on', async () => {
    const r = await report(asSuper());
    expect(r.executions.population).toBe('headline');
    expect(r.attempts.population).toBe('headline');
    expect(r.inventory.population).toBe('headline');
    expect(r.fallback.population).toBe('headline');
    expect(r.by_product.population).toBe('headline');
    expect(r.failures.population).toBe('headline+failed');
    expect(r.confidence.population).toBe('headline+confidence');
    expect(r.latency.provider.population).toBe('headline+succeeded+latency');
    expect(r.latency.wall_clock.population).toBe('headline+completed');
    expect(r.latency.queue_delay.population).toBe('headline+enqueued');
    expect(r.replays.population).toBe('replay');
    // ⚠️ Copilot is a different source entirely and says so.
    expect(r.copilot.population).toBe('copilot_invocations');
    expect(r.copilot.source).toBe('audit_event');
  });
});

describe('⚠️ SEC-17 — an execution with no outbox row stays in the population', () => {
  it('remains in the headline metrics and is absent only from queue delay', async () => {
    const r = await report(asSuper());

    // POSITIVE CONTROL: the headline population must actually contain the row.
    // Under an INNER JOIN it would be 3 here and the identity would break.
    expect(r.population.headline).toBe(4);
    expect(r.population.identity_holds).toBe(true);

    // Three of the four headline rows have an outbox event; the fourth does not.
    expect(r.latency.queue_delay.n).toBe(3);
    expect(r.population.headline - r.latency.queue_delay.n).toBe(1);

    // And it still contributes everywhere else — it is the fallback occurrence.
    expect(r.fallback.occurrences).toBe(1);
  });

  it('the pipeline uses a LEFT JOIN, stated in the SQL itself', () => {
    // The property is asserted above on data; this pins the mechanism, so a
    // future edit to the join cannot pass by coincidence of the fixture set.
    expect(GOVERNANCE_METRICS_SQL).toContain('LEFT JOIN event_outbox');
    expect(GOVERNANCE_METRICS_SQL).not.toMatch(/(?<!LEFT )\bJOIN event_outbox/);
  });
});

describe('⚠️ half-open window semantics', () => {
  it('includes the lower bound and excludes the upper bound', async () => {
    const first = await report(asSuper(), { from: W2_A, to: W2_B });
    const second = await report(asSuper(), { from: W2_B, to: W2_END });

    expect(first.population.headline, 'the row created at exactly `from` is included').toBe(1);
    expect(second.population.headline, 'the row created at exactly `to` belongs to the next window').toBe(1);
  });

  it('adjacent windows never count the same row twice', async () => {
    const both = await report(asSuper(), { from: W2_A, to: W2_END });
    const first = await report(asSuper(), { from: W2_A, to: W2_B });
    const second = await report(asSuper(), { from: W2_B, to: W2_END });
    expect(both.population.headline).toBe(first.population.headline + second.population.headline);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Metric semantics
// ═════════════════════════════════════════════════════════════════════════

describe('metric semantics', () => {
  it('⚠️ suppresses the rate below the sample threshold rather than showing a percentage', async () => {
    const r = await report(asSuper());
    expect(r.executions.success_rate_n).toBeLessThan(MIN_SAMPLE_FOR_RATE);
    expect(r.executions.rate_suppressed).toBe(true);
    // Null, not 0 — a zero here would read as "nothing succeeded".
    expect(r.executions.success_rate).toBeNull();
  });

  it('publishes a smaller n where a metric cannot use every row', async () => {
    const r = await report(asSuper());
    // Three headline rows succeeded; only two of them recorded a latency.
    expect(r.executions.succeeded).toBe(3);
    expect(r.latency.provider.n).toBe(2);
    expect(r.latency.provider.p50).toBeGreaterThan(0);
  });

  it('separates the three latency measurements', async () => {
    const r = await report(asSuper());
    expect(r.latency.provider.n).not.toBe(r.latency.queue_delay.n);
    // Wall clock spans creation to completion and is therefore not the provider
    // time; the fixtures make that difference explicit.
    expect(r.latency.wall_clock.n).toBe(4);
  });

  it('maps failure codes to categories and keeps the raw code', async () => {
    const r = await report(asSuper());
    expect(r.failures.n).toBe(1);
    expect(r.failures.rows[0]?.error_code).toBe('invalid_ai_output');
    expect(r.failures.rows[0]?.category).toBe('output_rejected_by_iris');
    expect(r.failures.rows[0]?.label).toBe('Output rejected by IRIS');
  });

  it('⚠️ reports fallback as a count, never a rate', async () => {
    const r = await report(asSuper());
    expect(r.fallback.occurrences).toBe(1);
    expect(Object.keys(r.fallback)).not.toContain('rate');
  });

  it('renders every confidence bucket, including empty ones', async () => {
    const r = await report(asSuper());
    expect(r.confidence.buckets).toHaveLength(10);
    expect(r.confidence.signal).toBe('uncalibrated');
    // 0.82 and 0.55 are the two headline confidences; 0.91 belongs to the replay
    // and must not appear.
    expect(r.confidence.n).toBe(2);
    expect(r.confidence.buckets.find((b) => b.bucket === 8)?.n).toBe(1);
    expect(r.confidence.buckets.find((b) => b.bucket === 5)?.n).toBe(1);
    expect(r.confidence.buckets.find((b) => b.bucket === 9)?.n).toBe(0);
  });

  it('⚠️ says which feature produces no confidence instead of scoring it zero', async () => {
    const r = await report(asSuper());
    expect(r.confidence.features_without_confidence).toContain('summary');
  });

  it('⚠️ attributes routing to IRIS, not to the model', async () => {
    const r = await report(asSuper());
    expect(r.routing.decided_by).toBe('iris_core');
    expect(r.routing.n).toBe(1);
    expect(r.routing.rows[0]?.key).toBe('soft_route_ai_uncertain');
  });

  it('carries the governance version', async () => {
    const r = await report(asSuper());
    expect(r.meta.governance_version).toBe(AI_GOVERNANCE_VERSION);
  });

  it('⚠️ states what it cannot measure rather than leaving it implied', async () => {
    const r = await report(asSuper());
    for (const term of ['cost', 'token_usage', 'accuracy', 'human_correction_rate']) {
      expect(r.unmeasurable as readonly string[]).toContain(term);
    }
    expect(r.caveats.join(' ')).toMatch(/no ground truth/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Security
// ═════════════════════════════════════════════════════════════════════════

describe('SEC-1..6 — access and isolation', () => {
  it('SEC-3: an agent is refused', async () => {
    const res = await get(W1, asAgent());
    expect(res.statusCode).toBe(403);
  });

  it('SEC-4: an unauthenticated caller is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/ai/governance?from=${W1_FROM}&to=${W1_TO}`,
      headers: { 'x-internal-key': config.INTERNAL_API_KEY },
    });
    expect(res.statusCode).toBe(401);
  });

  it('SEC-2: manager and product_admin are both served, within their scope', async () => {
    for (const h of [asManagerA(), asProductAdminA()]) {
      const r = await report(h);
      expect(r.population.headline).toBeGreaterThan(0);
      expect(r.by_product.rows.map((p) => p.product_id)).toEqual([PRODUCT_A]);
    }
  });

  it('⚠️ SEC-1: cross-product isolation, with a positive control on BOTH products', async () => {
    /**
     * The anti-vacuity rule. `prod_ideal` and `prod_ifile` have zero governance
     * rows, so an isolation test written against them passes without measuring
     * anything. These two are the products that actually hold data, and the
     * first two assertions prove it before the isolation claim is made.
     */
    const a = await report(asManagerA(), { ...W1 });
    const b = await report(asManagerB(), { ...W1 });

    expect(a.population.headline, 'A must be non-empty or this proves nothing').toBeGreaterThan(0);
    expect(b.population.headline, 'B must be non-empty or this proves nothing').toBeGreaterThan(0);

    expect(a.by_product.rows.map((r) => r.product_id)).toContain(PRODUCT_A);
    expect(a.by_product.rows.map((r) => r.product_id)).not.toContain(PRODUCT_B);
    expect(b.by_product.rows.map((r) => r.product_id)).toContain(PRODUCT_B);
    expect(b.by_product.rows.map((r) => r.product_id)).not.toContain(PRODUCT_A);

    // And the totals differ, so neither is quietly seeing the whole platform.
    const platform = await report(asSuper());
    expect(platform.population.headline).toBeGreaterThan(a.population.headline);
    expect(platform.population.headline).toBeGreaterThan(b.population.headline);
  });

  it('⚠️ SEC-5: the super-admin platform view is NON-EMPTY', async () => {
    /**
     * `app_scope()` is EMPTY for a super_admin — RLS carries them on the
     * `app_role() = 'super_admin'` branch instead. An aggregate written as
     * `product_id = ANY(app_scope())` therefore returns nothing at all for the
     * platform administrator, and looks exactly like "no data" rather than a
     * defect. This is the test that catches it.
     */
    const r = await report(asSuper(), {});
    expect(r.population.headline).toBeGreaterThan(0);
    expect(r.by_product.rows.length).toBeGreaterThan(1);
  });

  it('SEC-6: an out-of-scope product filter is indistinguishable from a missing one', async () => {
    const foreign = await get({ ...W1, product_id: PRODUCT_B }, asManagerA());
    const nonexistent = await get({ ...W1, product_id: 'prod_does_not_exist' }, asManagerA());
    expect(foreign.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(nonexistent.json().error.code);
  });

  it('a feature outside the corpus is a 400 with an explanation, not an empty page', async () => {
    const res = await get({ ...W1, feature: 'noop' }, asSuper());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/outside the governance corpus/);
  });

  it('an oversized window is refused', async () => {
    const res = await get(
      { from: '2019-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
      asSuper(),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('SEC-7..11 — nothing but metadata leaves the endpoint', () => {
  it('⚠️ exposes no ticket content, rationale, error message or tenant identity', async () => {
    const r = await report(asSuper(), {});
    const body = JSON.stringify(r);

    for (const forbidden of [
      'error_message',
      'rationale',
      'product_tenant_id',
      'raised_by',
      'subject',
      'description',
      'kb_article',
      'similar_resolution',
    ]) {
      expect(body, `${forbidden} must not appear anywhere in the response`).not.toContain(forbidden);
    }

    /**
     * ⚠️ "draft" is checked as a FIELD, not as a substring.
     *
     * The Copilot outcome enum contains the value `drafted` — the name of an
     * outcome, carrying no draft. A substring scan flags it and would push
     * someone to rename a truthful enum in order to pass, which weakens the
     * response instead of the leak. What must be absent is the draft itself.
     */
    const keys = collectKeys(r);
    for (const field of ['draft', 'draft_text', 'draft_chars', 'body', 'text', 'content']) {
      expect(keys, `no field may carry draft or ticket content (${field})`).not.toContain(field);
    }
  });

  it('⚠️ returns no `result` payload, wholesale or in part', async () => {
    const r = await report(asSuper(), {});
    const keys = collectKeys(r);
    expect(keys).not.toContain('result');
    expect(keys).not.toContain('score_breakdown');
    expect(keys).not.toContain('composite_confidence');
  });

  it('the real ticket text never appears, checked against the actual ticket', async () => {
    // A positive control on the leak test itself: read the real subject, prove
    // it is a non-trivial string, then prove it is absent.
    const { rows } = await admin.query<{ subject: string | null; description: string }>(
      `SELECT subject, description FROM ticket WHERE id = $1`,
      [ticketA],
    );
    const t = rows[0]!;
    const sample = (t.subject ?? t.description).slice(0, 24);
    expect(sample.length, 'the control string must be substantial').toBeGreaterThan(8);
    const body = JSON.stringify(await report(asSuper(), {}));
    expect(body).not.toContain(sample);
  });
});

describe('SEC-12..14 — the endpoint writes nothing and interpolates nothing', () => {
  it('⚠️ SEC-12: no row changes as a result of a governance request', async () => {
    const digest = async () => {
      const { rows } = await admin.query<{ h: string }>(
        `SELECT md5(COALESCE(string_agg(id || status || COALESCE(error_code,''), ',' ORDER BY id), ''))
                || ':' || (SELECT count(*) FROM audit_event)::text AS h
           FROM ai_execution`,
      );
      return rows[0]!.h;
    };

    const before = await digest();
    await report(asSuper(), {});
    await report(asManagerA());
    const after = await digest();
    expect(after).toBe(before);
  });

  it('⚠️ SEC-14: a hostile product filter is a bind parameter, not string concatenation', async () => {
    /**
     * A super_admin passes the tenant check, so this value reaches the query.
     * If it were interpolated, `OR '1'='1' --` would widen the predicate and
     * return the whole platform. Parameterised, it is simply a product id that
     * matches nothing.
     */
    const injection = "prod_carbon' OR '1'='1";
    const res = await get({ ...W1, product_id: injection }, asSuper());
    expect(res.statusCode).toBe(200);
    const r = res.json() as GovernanceResponse;
    expect(r.population.scoped).toBe(0);
    expect(r.population.headline).toBe(0);

    // Positive control: the same request without the injection is non-empty, so
    // the zero above is the filter working rather than the window being empty.
    const control = await report(asSuper(), { ...W1, product_id: PRODUCT_A });
    expect(control.population.scoped).toBeGreaterThan(0);
  });

  it('SEC-13: isolation lives in the query, not in a filter applied afterwards', () => {
    // The pipeline reads `ai_execution` exactly once, inside the scoped CTE.
    // Every metric then reads a CTE, so no code path can hold an unscoped row.
    const occurrences = GOVERNANCE_METRICS_SQL.match(/FROM ai_execution/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(GOVERNANCE_METRICS_SQL).toContain('FROM headline_population');
  });

  it('SEC-14: every request-derived value is a placeholder', () => {
    for (const p of ['$1', '$2', '$3', '$4', '$5', '$6', '$7']) {
      expect(GOVERNANCE_METRICS_SQL).toContain(p);
    }
  });
});

describe('⚠️ SEC-18 — the response asserts no claim the data cannot support', () => {
  it('no response key or enum value names a property IRIS cannot measure', async () => {
    const r = await report(asSuper(), {});

    const suspects = [
      ...collectKeys(r),
      // The enum-shaped values, which are labels in all but name.
      r.confidence.signal,
      r.routing.decided_by,
      r.copilot.source,
      r.copilot.population,
      r.executions.population,
      r.failures.population,
      r.latency.provider.population,
      r.latency.wall_clock.population,
      r.latency.queue_delay.population,
      r.replays.population,
      ...r.failures.rows.flatMap((f) => [f.category, f.label]),
      ...r.confidence.buckets.map((b) => b.label),
      ...r.routing.rows.map((x) => x.key),
      ...r.copilot.outcomes.map((x) => x.key),
    ];

    // ⚠️ The shared predicate, not a local substring scan — the policy has to
    // have exactly one definition, or the API and the UI drift apart on it.
    for (const s of suspects) {
      expect(assertsProhibitedClaim(String(s)), `"${s}" asserts a prohibited claim`).toBe(false);
    }

    // Positive control on the check itself: it must actually reject something.
    expect(assertsProhibitedClaim('accuracy')).toBe(true);
    expect(PROHIBITED_CLAIM_TERMS.length).toBeGreaterThan(5);
  });

  it('⚠️ and the DENIALS are present, which a blanket string scan would have forbidden', async () => {
    /**
     * The positive control for the rule itself. `unmeasurable` lists the things
     * that do not exist — its values include "accuracy" precisely because the
     * response is disclosing an absence. A test that banned the characters
     * everywhere would force this disclosure to be deleted, which is the
     * opposite of governance.
     */
    const r = await report(asSuper(), {});
    expect(r.unmeasurable as readonly string[]).toContain('accuracy');
    expect(r.caveats.some((c) => /not measure whether the AI was right/i.test(c))).toBe(true);
    expect(r.caveats.some((c) => /uncalibrated/i.test(c))).toBe(true);
  });
});

describe('⚠️ Copilot stays a separate denominator', () => {
  it('is counted from the audit trail and never merged with executions', async () => {
    const r = await report(asSuper(), {});
    expect(r.copilot.source).toBe('audit_event');
    // Positive control: there is real Copilot activity to be wrong about.
    expect(r.copilot.invocations).toBeGreaterThan(0);
    // Its own denominator, unrelated to the execution population.
    expect(r.copilot.invocations).not.toBe(r.population.headline);
    // No key here promises to know what the agent did with a draft.
    const keys = collectKeys(r.copilot as unknown as Record<string, unknown>);
    for (const absent of ['edit_rate', 'send_rate', 'acceptance', 'accepted', 'edited']) {
      expect(keys).not.toContain(absent);
    }
  });

  it('publishes its own n for timings, which pre-date full instrumentation', async () => {
    const r = await report(asSuper(), {});
    expect(r.copilot.total_ms.n).toBeLessThanOrEqual(r.copilot.invocations);
    expect(r.copilot.total_ms.population).toContain('copilot');
  });
});

describe('⚠️ the operational list endpoint keeps its own semantics', () => {
  const list = (qs: string, hdrs: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/admin/api/ai/executions?${qs}`, headers: hdrs });

  it('gained the provenance columns Phase 17 needs', async () => {
    const res = await list('limit=5', asSuper());
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<Record<string, unknown>>;
    expect(rows.length, 'there must be rows or this proves nothing').toBeGreaterThan(0);
    for (const key of [
      'provider',
      'model',
      'model_version',
      'prompt_version',
      'latency_ms',
      'confidence',
      'fallback_used',
    ]) {
      expect(Object.keys(rows[0]!), key).toContain(key);
    }
  });

  it('⚠️ still excludes the validated result and the provider error message', async () => {
    const res = await list('limit=20', asSuper());
    const rows = res.json().data as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('result');
      expect(Object.keys(row)).not.toContain('error_message');
    }
  });

  it('confidence comes back as a number, not the numeric string pg returns', async () => {
    const res = await list('feature=classification&status=succeeded&limit=50', asSuper());
    const rows = res.json().data as Array<{ confidence: unknown }>;
    const withConfidence = rows.filter((r) => r.confidence !== null);
    expect(withConfidence.length, 'need at least one confidence to check the type').toBeGreaterThan(0);
    for (const r of withConfidence) expect(typeof r.confidence).toBe('number');
  });

  it('⚠️ does NOT apply the governance corpus rule — it is a diagnostic tool', async () => {
    /**
     * The deliberate asymmetry. Governance refuses `noop` because measuring the
     * stub would corrupt every rate. An operator debugging that stub still has
     * to be able to find its executions, so the operational listing keeps its
     * unrestricted filter.
     */
    const res = await list('feature=noop&limit=5', asSuper());
    expect(res.statusCode).toBe(200);
    expect((res.json().data as unknown[]).length).toBeGreaterThan(0);

    // And the governance endpoint refuses the same filter, on purpose.
    expect((await get({ ...W1, feature: 'noop' }, asSuper())).statusCode).toBe(400);
  });
});

describe('sparse and empty behaviour', () => {
  it('⚠️ an empty window returns zeroed structures, not a 404 and not a 0%', async () => {
    const r = await report(asSuper(), {
      from: '2018-01-01T00:00:00.000Z',
      to: '2018-01-02T00:00:00.000Z',
    });
    expect(r.population.scoped).toBe(0);
    expect(r.population.headline).toBe(0);
    expect(r.population.identity_holds).toBe(true);
    expect(r.executions.success_rate).toBeNull();
    expect(r.latency.provider.p50).toBeNull();
    expect(r.confidence.buckets).toHaveLength(10);
    expect(r.caveats.join(' ')).toMatch(/No AI executions in this window/);
  });
});

// ─────────────────────────────────────────────────────────────────────────

/** Every key name in a nested response, for allow-list assertions. */
function collectKeys(value: unknown, out: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return [...out];
}

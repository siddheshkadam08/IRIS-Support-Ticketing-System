import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { newId, type AIJob } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool, pool } from '../db/pool.js';
import { withScope, withSystemScope } from '../db/with-scope.js';
import { runReaperCycle } from '../events/ai-reaper.js';

/**
 * Phase 3 Step 7 — reliability hardening.
 *
 * This suite is a deliberate attempt to BREAK the reliability architecture.
 * Every test drives a real failure against the real Postgres and asserts the
 * four properties that actually matter when a dependency dies:
 *
 *   1. exactly one state transition per execution
 *   2. exactly one audit row per transition
 *   3. no resurrection of a terminal execution
 *   4. no cross-tenant effect, ever
 *
 * The scenarios here are the ones the Step 7 audit found UNCOVERED. Cases
 * already proven elsewhere (retry curve, timeouts, DB timeouts, drain,
 * job-id race, delayed-job protection) are deliberately not repeated —
 * duplicating them would add runtime without adding evidence.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/internal/ai.reliability.test.ts
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

let app: Awaited<ReturnType<typeof buildServer>>;

const productHeaders = (productId: string) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-product-id': productId,
  'x-iris-role': 'product',
  'x-iris-tenant-id': 'tenant_reliability',
});

function signed(path: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  return {
    'content-type': 'application/json',
    'x-iris-service-id': 'worker',
    'x-iris-timestamp': String(timestamp),
    'x-iris-nonce': nonce,
    'x-iris-signature': requestSignatureHeader(config.AI_WORKER_HMAC_SECRET, {
      method: 'POST',
      path,
      timestamp,
      nonce,
      body,
    }),
  };
}

const postSigned = (eventId: string, kind: 'input' | 'result', body: unknown) => {
  const path = `/internal/ai/jobs/${eventId}/${kind}`;
  const serialised = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: path,
    headers: signed(path, serialised),
    payload: serialised,
  });
};

interface Created {
  ticketId: string;
  eventId: string;
  productId: string;
}

async function createTicket(productId = PRODUCT_A): Promise<Created> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: productHeaders(productId),
    payload: { subject: 'Reliability probe', description: 'A ticket for Step 7 scenarios.' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const ticketId = res.json().id as string;
  const eventId = await withSystemScope('rel', async (tx) => {
    const { rows } = await tx.query<{ event_id: string }>(
      `SELECT event_id FROM event_outbox
        WHERE aggregate_id = $1 AND event_type = 'ticket.created'`,
      [ticketId],
    );
    return rows[0]!.event_id;
  });
  return { ticketId, eventId, productId };
}

const claims = (c: Created, over: Record<string, unknown> = {}) => ({
  job_id: newId('aij'),
  feature: 'noop',
  attempt: 1,
  correlation_id: `req_rel_${Date.now()}`,
  claimed_product_id: c.productId,
  claimed_ticket_id: c.ticketId,
  ...over,
});

const failedResult = (code = 'retries_exhausted') => ({
  feature: 'noop',
  status: 'failed',
  data: {},
  error: { kind: 'temporary', code, message: `6 attempts exhausted: ${code}` },
});

const okResult = (chars = 40) => ({
  feature: 'noop',
  status: 'succeeded',
  data: { ok: true, received_chars: chars },
  provider: 'stub',
  model: 'stub-noop',
  model_version: '1',
  latency_ms: 2,
  fallback_used: false,
});

const execFor = (eventId: string) =>
  withSystemScope('rel', async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      error_code: string | null;
      job_id: string | null;
      attempt: number;
      result: unknown;
      completed_at: Date | null;
      product_id: string;
      ticket_id: string;
    }>(`SELECT id, status, error_code, job_id, attempt, result, completed_at,
               product_id, ticket_id
          FROM ai_execution WHERE event_id = $1 AND feature = 'noop'`, [eventId]);
    return rows[0] ?? null;
  });

const auditRows = (executionId: string) =>
  withSystemScope('rel', async (tx) => {
    const { rows } = await tx.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM audit_event
        WHERE action LIKE 'ai.%' AND after->>'execution_id' = $1
        ORDER BY occurred_at`,
      [executionId],
    );
    return rows;
  });

/** Make an execution look stale without waiting 45 minutes. */
const backdate = (executionId: string, minutes = 90) =>
  withScope({ productScope: [PRODUCT_A], role: 'none', requestId: 'rel' }, (tx) =>
    tx.query(
      `UPDATE ai_execution SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [executionId, String(minutes)],
    ),
  );

/** A queue that answers only for the job ids a test names. Never mutates Redis. */
const stubQueue = (states: Record<string, string>) =>
  ({
    getJobState: async (jobId: string) => states[jobId] ?? 'active',
  }) as unknown as Queue<AIJob>;

/** Rows a test deliberately leaves `running`, retired in afterAll. */
const leftRunning: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  if (leftRunning.length > 0) {
    await withScope({ productScope: [PRODUCT_A], role: 'none', requestId: 'rel-cleanup' }, (tx) =>
      tx.query(
        `UPDATE ai_execution SET status='failed', error_code='test_cleanup', completed_at=now()
          WHERE id = ANY($1) AND status='running'`,
        [leftRunning],
      ),
    );
  }
  await app.close();
  await closePool();
});

// ═════════════════════════════════════════════════════════════════════════
// A — worker crash / stall: the execution must not stay running forever
// ═════════════════════════════════════════════════════════════════════════

describe('A. worker crash before the result is reported', () => {
  it('leaves a claimed execution running, and the reaper closes it', async () => {
    /**
     * The full crash path, end to end: /input claims the row, the worker dies
     * before /result, BullMQ eventually dead-letters the job, and nothing ever
     * reports. Step 4 cannot help — the process that would report is gone.
     * The reaper is the only mechanism that can close this, and this asserts
     * the handoff rather than each half separately.
     */
    const t = await createTicket();
    const c = claims(t);
    expect((await postSigned(t.eventId, 'input', c)).statusCode).toBe(200);

    const claimed = (await execFor(t.eventId))!;
    expect(claimed.status, 'the crash window is exactly this state').toBe('running');

    // Time passes; BullMQ gave up on the job the dead worker held.
    await backdate(claimed.id);
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);

    const after = (await execFor(t.eventId))!;
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('abandoned');
    expect(after.completed_at).not.toBeNull();
  });

  it('does not mutate the ticket — a crash cannot corrupt business state', async () => {
    const t = await createTicket();
    const before = await withSystemScope('rel', async (tx) =>
      (await tx.query(`SELECT * FROM ticket WHERE id = $1`, [t.ticketId])).rows[0],
    );

    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const claimed = (await execFor(t.eventId))!;
    await backdate(claimed.id);
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);

    const after = await withSystemScope('rel', async (tx) =>
      (await tx.query(`SELECT * FROM ticket WHERE id = $1`, [t.ticketId])).rows[0],
    );
    expect(after, 'AI failure must leave the ticket untouched').toEqual(before);
  });

  it('produces exactly ONE terminal audit row, not one per mechanism', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const claimed = (await execFor(t.eventId))!;
    await backdate(claimed.id);

    // Two cycles: the second must find nothing left to do.
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);

    const audit = await auditRows(claimed.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('ai.execution_failed');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F — the terminal report never reached Core
// ═════════════════════════════════════════════════════════════════════════

describe('F. terminal report unavailable, then the reaper reconciles', () => {
  it('an unreported exhaustion is closed by the reaper, not left forever', async () => {
    /**
     * Step 4 deliberately does not retry its report: a second delay authority
     * beside BullMQ is what the architecture forbids. That decision is only
     * safe because this handoff works, so the handoff is asserted here.
     */
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);

    // The worker exhausted its attempts and tried to report; Core was down.
    // Nothing was written, so the row is still exactly as /input left it.
    const stuck = (await execFor(t.eventId))!;
    expect(stuck.status).toBe('running');

    await backdate(stuck.id);
    const stats = await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);
    expect(stats.reaped).toBeGreaterThanOrEqual(1);

    const closed = (await execFor(t.eventId))!;
    expect(closed.status).toBe('failed');
    expect(closed.error_code).toBe('abandoned');
  });

  it('a report that arrives LATE, after reaping, changes nothing', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;
    await backdate(row.id);
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);

    // Core came back; the worker's report finally lands.
    const late = await postSigned(t.eventId, 'result', { ...c, result: failedResult() });
    expect(late.statusCode).toBe(200);
    expect(late.json().applied, 'the execution was already terminal').toBe(false);

    const after = (await execFor(t.eventId))!;
    expect(after.error_code, 'abandoned must not be overwritten').toBe('abandoned');
    expect(await auditRows(row.id), 'no second audit row').toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// G — late SUCCESS after the reaper gave up
// ═════════════════════════════════════════════════════════════════════════

describe('G. late success cannot resurrect an abandoned execution', () => {
  it('keeps status failed and refuses to write the result', async () => {
    /**
     * The most dangerous ordering in the whole design: a job the reaper wrote
     * off finally succeeds. Applying it would mean a ticket mutated by work
     * the system already declared dead — and the audit trail would show a
     * failure followed by a silent success.
     */
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;
    await backdate(row.id);
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);

    const late = await postSigned(t.eventId, 'result', { ...c, result: okResult() });

    expect(late.statusCode).toBe(200);
    expect(late.json().applied).toBe(false);
    expect(late.json().ticket_updated).toBe(false);

    const after = (await execFor(t.eventId))!;
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('abandoned');
    expect(after.result, 'no model output may be written after abandonment').toBeNull();
    expect(await auditRows(row.id)).toHaveLength(1);
  });

  it('a subsequent /input reports already_applied rather than re-claiming', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;
    await backdate(row.id);
    await runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45);

    const again = await postSigned(t.eventId, 'input', claims(t));
    expect(again.statusCode).toBe(200);
    expect(again.json().status, 'a terminal execution is not re-opened').toBe('already_applied');

    expect((await execFor(t.eventId))!.error_code).toBe('abandoned');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// H — reaper and terminal report, genuinely concurrent
// ═════════════════════════════════════════════════════════════════════════

describe('H. reaper vs terminal report race', () => {
  it('exactly one transition and one audit row, whichever wins', async () => {
    /**
     * Fired together rather than in sequence, so the arbitration is Postgres's
     * `WHERE status = 'running'` and not test ordering. Either winner is
     * correct; both winning is not.
     */
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;
    await backdate(row.id);

    const [reap, report] = await Promise.all([
      runReaperCycle(stubQueue({ [c.job_id]: 'failed' }), 45),
      postSigned(t.eventId, 'result', { ...c, result: failedResult() }),
    ]);

    const after = (await execFor(t.eventId))!;
    expect(after.status).toBe('failed');
    expect(
      ['abandoned', 'retries_exhausted'],
      'the winner may be either mechanism',
    ).toContain(after.error_code);

    // The decisive assertion: one transition, one audit row.
    expect(await auditRows(row.id)).toHaveLength(1);
    expect(reap.reaped + (report.json().applied ? 1 : 0), 'exactly one writer applied').toBe(1);
  });

  it('two concurrent reapers reap it once between them', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;
    await backdate(row.id);

    const q = stubQueue({ [c.job_id]: 'failed' });
    const [a, b] = await Promise.all([runReaperCycle(q, 45), runReaperCycle(q, 45)]);

    // Whichever loses records a race, not a second transition.
    const mine = (s: { reaped: number }) => s.reaped;
    expect(mine(a) + mine(b)).toBeGreaterThanOrEqual(1);
    expect(await auditRows(row.id), 'one audit row however many reapers ran').toHaveLength(1);
    expect((await execFor(t.eventId))!.error_code).toBe('abandoned');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// M — duplicate delivery
// ═════════════════════════════════════════════════════════════════════════

describe('M. duplicate delivery of the same event', () => {
  it('five concurrent claims produce ONE execution row', async () => {
    /**
     * BullMQ delivery is at-least-once and a re-dispatched outbox row keeps
     * its event_id. UNIQUE(event_id, feature) is the database's answer, and
     * this drives it concurrently rather than trusting the constraint by
     * inspection.
     */
    const t = await createTicket();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postSigned(t.eventId, 'input', claims(t))),
    );
    for (const r of responses) expect(r.statusCode, r.body).toBe(200);

    const count = await withSystemScope('rel', async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ai_execution WHERE event_id = $1`,
        [t.eventId],
      );
      return Number(rows[0]!.n);
    });
    expect(count, 'the unique constraint is the arbitrator').toBe(1);
    leftRunning.push((await execFor(t.eventId))!.id);
  });

  it('five concurrent terminal reports produce ONE transition and ONE audit row', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        postSigned(t.eventId, 'result', { ...c, result: failedResult() }),
      ),
    );

    const applied = results.filter((r) => r.json().applied === true);
    expect(applied, 'exactly one writer may apply').toHaveLength(1);
    expect(await auditRows(row.id)).toHaveLength(1);
  });

  it('a success and a failure racing produce one outcome, not a merge', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;

    const [ok, bad] = await Promise.all([
      postSigned(t.eventId, 'result', { ...c, result: okResult() }),
      postSigned(t.eventId, 'result', { ...c, result: failedResult() }),
    ]);

    const appliedCount = [ok, bad].filter((r) => r.json().applied === true).length;
    expect(appliedCount).toBe(1);

    const after = (await execFor(t.eventId))!;
    expect(['succeeded', 'failed']).toContain(after.status);
    expect(await auditRows(row.id)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B — Redis outage cannot cause a business effect
// ═════════════════════════════════════════════════════════════════════════

describe('B. Redis outage', () => {
  it('reaps nothing and raises no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const t = await createTicket();
      const c = claims(t);
      await postSigned(t.eventId, 'input', c);
      const row = (await execFor(t.eventId))!;
      leftRunning.push(row.id);
      await backdate(row.id);

      const dead = {
        getJobState: async (jobId: string) => {
          if (jobId === c.job_id) throw new Error('Connection is closed.');
          return 'active';
        },
      } as unknown as Queue<AIJob>;

      const stats = await runReaperCycle(dead, 45);

      expect(stats.reaped, 'an outage must never reap').toBe(0);
      expect(stats.skipped_redis).toBeGreaterThanOrEqual(1);
      expect((await execFor(t.eventId))!.status).toBe('running');
      expect(await auditRows(row.id), 'no state change, no audit row').toHaveLength(0);

      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not create or mutate any ticket', async () => {
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const row = (await execFor(t.eventId))!;
    leftRunning.push(row.id);
    await backdate(row.id);

    const beforeCount = await withSystemScope('rel', async (tx) =>
      Number(
        (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ticket`)).rows[0]!.n,
      ),
    );

    await runReaperCycle(
      {
        getJobState: async () => {
          throw new Error('Connection is closed.');
        },
      } as unknown as Queue<AIJob>,
      45,
    );

    const afterCount = await withSystemScope('rel', async (tx) =>
      Number(
        (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ticket`)).rows[0]!.n,
      ),
    );
    expect(afterCount).toBe(beforeCount);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C — Core restart
// ═════════════════════════════════════════════════════════════════════════

describe('C. Core restart mid-pipeline', () => {
  it('a claimed execution survives a Core restart and stays resumable', async () => {
    /**
     * Restart is modelled the way it actually behaves: the process goes away
     * and a NEW server instance serves the next request. Everything about the
     * execution lives in Postgres, so nothing should be lost — this asserts
     * that rather than assuming it.
     */
    const t = await createTicket();
    const c = claims(t);
    await postSigned(t.eventId, 'input', c);
    const before = (await execFor(t.eventId))!;

    await app.close();
    app = await buildServer();
    await app.ready();

    const after = (await execFor(t.eventId))!;
    expect(after.id).toBe(before.id);
    expect(after.status).toBe('running');
    expect(after.job_id).toBe(before.job_id);

    // The worker retries after the restart and the work completes normally.
    const done = await postSigned(t.eventId, 'result', { ...c, result: okResult() });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().applied).toBe(true);
    expect((await execFor(t.eventId))!.status).toBe('succeeded');
  });

  it('leaves the outbox row and its ticket intact across the restart', async () => {
    const t = await createTicket();
    const outboxBefore = await withSystemScope('rel', async (tx) =>
      (
        await tx.query(`SELECT event_id, product_id, aggregate_id, event_type, payload
                          FROM event_outbox WHERE event_id = $1`, [t.eventId])
      ).rows[0],
    );

    await app.close();
    app = await buildServer();
    await app.ready();

    const outboxAfter = await withSystemScope('rel', async (tx) =>
      (
        await tx.query(`SELECT event_id, product_id, aggregate_id, event_type, payload
                          FROM event_outbox WHERE event_id = $1`, [t.eventId])
      ).rows[0],
    );
    expect(outboxAfter).toEqual(outboxBefore);

    // And the pipeline still works against the fresh instance.
    const res = await postSigned(t.eventId, 'input', claims(t));
    expect(res.statusCode, res.body).toBe(200);
    leftRunning.push((await execFor(t.eventId))!.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Security under failure
// ═════════════════════════════════════════════════════════════════════════

describe('tenant isolation holds during failure handling', () => {
  it('the reaper writes only into the row own product scope', async () => {
    const a = await createTicket(PRODUCT_A);
    const b = await createTicket(PRODUCT_B);
    const ca = claims(a);
    const cb = claims(b);
    await postSigned(a.eventId, 'input', ca);
    await postSigned(b.eventId, 'input', cb);

    const rowA = (await execFor(a.eventId))!;
    const rowB = (await execFor(b.eventId))!;
    await backdate(rowA.id);

    // Only A is stale; B must be untouched even though the scan is global.
    await runReaperCycle(stubQueue({ [ca.job_id]: 'failed', [cb.job_id]: 'failed' }), 45);

    expect((await execFor(a.eventId))!.status).toBe('failed');
    expect((await execFor(b.eventId))!.status, 'another tenant is not collateral').toBe('running');
    leftRunning.push(rowB.id);

    const audit = await auditRows(rowA.id);
    expect(audit).toHaveLength(1);
    const productOfAudit = await withSystemScope('rel', async (tx) =>
      (
        await tx.query<{ product_id: string }>(
          `SELECT product_id FROM audit_event WHERE after->>'execution_id' = $1`,
          [rowA.id],
        )
      ).rows[0]!.product_id,
    );
    expect(productOfAudit).toBe(PRODUCT_A);
  });

  it('a reaped row is invisible to the other tenant scope', async () => {
    const a = await createTicket(PRODUCT_A);
    const ca = claims(a);
    await postSigned(a.eventId, 'input', ca);
    const row = (await execFor(a.eventId))!;
    await backdate(row.id);
    await runReaperCycle(stubQueue({ [ca.job_id]: 'failed' }), 45);

    const seenByB = await withScope(
      { productScope: [PRODUCT_B], role: 'product', requestId: 'rel' },
      async (tx) =>
        (await tx.query(`SELECT id FROM ai_execution WHERE id = $1`, [row.id])).rowCount,
    );
    expect(seenByB, 'RLS is the enforcement, not the query').toBe(0);
  });

  it('an unsigned reconciliation-shaped request is still rejected', async () => {
    // Failure handling adds no bypass: /internal still demands a signature.
    const t = await createTicket();
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/result`,
      headers: { 'content-type': 'application/json', 'x-internal-key': config.INTERNAL_API_KEY },
      payload: JSON.stringify({ ...claims(t), result: failedResult() }),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Pool health after the whole battering
// ═════════════════════════════════════════════════════════════════════════

describe('the connection pool survives the whole suite', () => {
  it('has idle clients and nothing queued', async () => {
    // A leak anywhere above would show up here as an exhausted pool.
    expect(pool.waitingCount).toBe(0);
    const { rows } = await pool.query<{ n: number }>(`SELECT 1 AS n`);
    expect(rows[0]!.n).toBe(1);
  });
});

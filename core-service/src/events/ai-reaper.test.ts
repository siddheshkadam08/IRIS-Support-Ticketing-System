import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import type { AIJob } from '@iris/shared/types';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope } from '../db/with-scope.js';
import {
  LOOKUP_TIMEOUT_MS,
  abandonedMessage,
  decideForCandidate,
  decideForJobState,
  runReaperCycle,
  startAIReaper,
  stopAIReaper,
} from './ai-reaper.js';
import { findStaleRunningExecutions } from '../internal/ai.repo.js';

/**
 * The abandoned-execution reaper.
 *
 * Two halves, deliberately separated:
 *
 *   UNIT        the decision matrix, which is pure. Every BullMQ job state is
 *               asserted explicitly, because the cost of a wrong entry is
 *               asymmetric: retaining a dead row is a stuck row, but reaping a
 *               live one destroys work that was about to succeed.
 *
 *   INTEGRATION the full cycle against the REAL Postgres, with RLS enforcing.
 *               The BullMQ queue is stubbed — not to avoid Redis, but because
 *               the whole point is to drive each state deterministically,
 *               including the Redis-unreachable path, which cannot be produced
 *               on demand against a healthy server.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/events/ai-reaper.test.ts
 */

const PRODUCT_A = 'prod_carbon';

/** Old enough to sort ahead of any pre-existing stale row in the batch. */
const ANCIENT = '10 days';

type StubState = Parameters<typeof decideForJobState>[0];

/**
 * Answers only for job ids this test created. Everything else reports 'active',
 * so a shared development database full of genuinely abandoned rows is never
 * mutated by a test run.
 */
function stubQueue(states: Map<string, StubState | 'THROW'>) {
  const asked: string[] = [];
  const q = {
    getJobState: async (jobId: string) => {
      asked.push(jobId);
      const state = states.get(jobId);
      if (state === 'THROW') throw new Error('Connection is closed.');
      return state ?? 'active';
    },
  };
  return { asked, queue: q as unknown as Queue<AIJob> };
}

let app: Awaited<ReturnType<typeof buildServer>>;
let ticketId: string;
/** Every execution row this file inserts, so afterAll can retire them. */
const created: string[] = [];

/** Insert a `running` execution directly — the state a crash leaves behind. */
async function seedRunning(opts: {
  jobId: string | null;
  age?: string;
  attempt?: number;
}): Promise<{ id: string; eventId: string; jobId: string | null }> {
  const id = newId('aix');
  const eventId = `evt_reaper_${id}`;
  await withScope(
    { productScope: [PRODUCT_A], role: 'none', requestId: 'reaper-test' },
    async (tx) => {
      await tx.query(
        `INSERT INTO ai_execution
           (id, product_id, ticket_id, feature, event_id, job_id, correlation_id,
            status, attempt, created_at)
         VALUES ($1,$2,$3,'noop',$4,$5,'req_reaper_test','running',$6,
                 now() - ($7)::interval)`,
        [id, PRODUCT_A, ticketId, eventId, opts.jobId, opts.attempt ?? 6, opts.age ?? ANCIENT],
      );
    },
  );
  created.push(id);
  return { id, eventId, jobId: opts.jobId };
}

const readRow = (id: string) =>
  withSystemScope('reaper-test', async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      completed_at: Date | null;
      job_id: string | null;
    }>(`SELECT status, error_code, error_message, completed_at, job_id
          FROM ai_execution WHERE id = $1`, [id]);
    return rows[0]!;
  });

const auditFor = (executionId: string) =>
  withSystemScope('reaper-test', async (tx) => {
    const { rows } = await tx.query<{
      action: string;
      actor_type: string;
      entity_type: string;
      entity_id: string;
      product_id: string;
      after: Record<string, unknown>;
    }>(
      `SELECT action, actor_type, entity_type, entity_id, product_id, after
         FROM audit_event
        WHERE action LIKE 'ai.%' AND after->>'execution_id' = $1`,
      [executionId],
    );
    return rows;
  });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: {
      'x-internal-key': config.INTERNAL_API_KEY,
      'content-type': 'application/json',
      'x-iris-product-id': PRODUCT_A,
      'x-iris-role': 'product',
      'x-iris-tenant-id': 'tenant_reaper_test',
    },
    payload: { subject: 'Reaper fixture', description: 'A ticket to hang executions from.' },
  });
  expect(res.statusCode, res.body).toBe(201);
  ticketId = res.json().id as string;
});

afterAll(async () => {
  /**
   * Retire anything the tests deliberately left `running`, so a later run does
   * not inherit them as candidates. DELETE is revoked from iris_app by design
   * (013_ai_execution.sql), so this closes them rather than erasing them.
   */
  if (created.length > 0) {
    await withScope(
      { productScope: [PRODUCT_A], role: 'none', requestId: 'reaper-test-cleanup' },
      async (tx) => {
        await tx.query(
          `UPDATE ai_execution
              SET status = 'failed', error_code = 'test_cleanup', completed_at = now()
            WHERE id = ANY($1) AND status = 'running'`,
          [created],
        );
      },
    );
  }
  await stopAIReaper();
  await app.close();
  await closePool();
});

// ═════════════════════════════════════════════════════════════════════════
// UNIT — the decision matrix
// ═════════════════════════════════════════════════════════════════════════

describe('states that must NEVER be reaped', () => {
  it.each([
    ['active', 'a worker is executing it right now'],
    ['waiting', 'queued, will be picked up'],
    ['delayed', 'the 600s retry tail sits here for ten minutes'],
    ['waiting-children', 'flow dependency'],
    ['prioritized', 'prioritised wait'],
  ] as const)('%s is retained (%s)', (state, _why) => {
    expect(decideForJobState(state)).toEqual({
      action: 'retain',
      reason: 'live_job',
      jobState: state,
    });
  });

  it('delayed is the single most important entry', () => {
    /**
     * The 751s retry window ends with a 600s delay. A job waiting out that
     * delay is `delayed`, not `failed`, and reaping it would abandon an
     * execution that BullMQ was about to retry — silently, with no error
     * anywhere. This is the specific mistake the stale threshold and this
     * branch both exist to prevent.
     */
    expect(decideForJobState('delayed').action).toBe('retain');
  });
});

describe('states that ARE reapable', () => {
  it.each([
    ['failed', 'dead-lettered; BullMQ will never run it again'],
    ['completed', 'the job finished but Core never recorded a result'],
    ['unknown', 'evicted, flushed, or never enqueued'],
  ] as const)('%s is reaped (%s)', (state, _why) => {
    expect(decideForJobState(state)).toEqual({ action: 'reap', jobState: state });
  });
});

describe('the matrix is exhaustive', () => {
  it('covers every state BullMQ can return, with no default-reap', () => {
    const all = [
      'active',
      'waiting',
      'waiting-children',
      'prioritized',
      'delayed',
      'completed',
      'failed',
      'unknown',
    ] as const;
    // Every entry decided; nothing falls through.
    for (const s of all) expect(['reap', 'retain']).toContain(decideForJobState(s).action);
    // 5 protected vs 3 reapable — asserted so a silent reclassification shows up.
    expect(all.filter((s) => decideForJobState(s).action === 'retain')).toHaveLength(5);
    expect(all.filter((s) => decideForJobState(s).action === 'reap')).toHaveLength(3);
  });
});

describe('candidate-level decisions', () => {
  it('a NULL job_id is reapable — no worker can ever resolve it', () => {
    // The dispatcher crashed between claiming the row and enqueueing, so there
    // is no job to ask about and nothing will ever complete it.
    expect(decideForCandidate({ job_id: null }, null)).toEqual({
      action: 'reap',
      jobState: 'unknown',
    });
  });

  it('a NULL job_id does not consult BullMQ at all', () => {
    // Even a state that would normally protect the row is irrelevant.
    expect(decideForCandidate({ job_id: null }, 'active').action).toBe('reap');
  });

  it('a Redis lookup failure RETAINS — it is not evidence the job is gone', () => {
    /**
     * The critical safety rule. During a Redis outage every lookup fails; if
     * that were read as "job missing" the reaper would mass-abandon the entire
     * live pipeline, turning a recoverable blip into permanent data loss.
     */
    expect(decideForCandidate({ job_id: 'aij_X' }, null)).toEqual({
      action: 'retain',
      reason: 'redis_unreachable',
    });
  });

  it('defers to the state matrix when Redis answered', () => {
    expect(decideForCandidate({ job_id: 'aij_X' }, 'failed').action).toBe('reap');
    expect(decideForCandidate({ job_id: 'aij_X' }, 'delayed').action).toBe('retain');
  });
});

describe('the persisted message', () => {
  it('states the threshold and the job state, and nothing else', () => {
    expect(abandonedMessage(45, 'failed')).toBe(
      'AI execution abandoned after 45 minutes; BullMQ job state: failed',
    );
  });

  it('carries no ticket content and stays inside the column bound', () => {
    const msg = abandonedMessage(45, 'unknown');
    expect(msg.length).toBeLessThan(500);
    expect(msg).not.toMatch(/description|subject/i);
  });
});

describe('start-up refuses safely', () => {
  it('start and stop are safe and idempotent whatever the flag says', async () => {
    /**
     * Deliberately independent of AI_REAPER_ENABLED: this suite runs against
     * the developer's real .env, where the flag may be either way, and a test
     * that asserts one value simply breaks when someone switches the pipeline
     * on. What must hold in BOTH configurations is that starting is safe,
     * starting twice does not create a second timer, and stopping always
     * releases whatever was created.
     */
    expect(() => startAIReaper()).not.toThrow();
    expect(() => startAIReaper(), 'a second start must be a no-op').not.toThrow();
    await expect(stopAIReaper()).resolves.toBeUndefined();
    await expect(stopAIReaper(), 'stopping twice is safe').resolves.toBeUndefined();
  });

  it('a cycle with no queue is a no-op, not a crash', async () => {
    // The disabled path: runReaperCycle is reachable with a null queue and must
    // never touch the database in that state.
    expect(await runReaperCycle(null, 45)).toEqual({
      candidates: 0,
      reaped: 0,
      retained: 0,
      skipped_redis: 0,
      races: 0,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// INTEGRATION — real Postgres, real RLS
// ═════════════════════════════════════════════════════════════════════════

describe('candidate selection', () => {
  it('finds a stale running row', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const found = await withSystemScope('t', (tx) => findStaleRunningExecutions(tx, 45, 200));
    expect(found.map((r) => r.id)).toContain(row.id);
  });

  it('does NOT select a row younger than the threshold', async () => {
    const fresh = await seedRunning({ jobId: newId('aij'), age: '1 minute' });
    const found = await withSystemScope('t', (tx) => findStaleRunningExecutions(tx, 45, 200));
    expect(found.map((r) => r.id)).not.toContain(fresh.id);
  });

  it('does NOT select rows that are already terminal', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'failed']]));
    await runReaperCycle(queue, 45);

    const found = await withSystemScope('t', (tx) => findStaleRunningExecutions(tx, 45, 200));
    expect(found.map((r) => r.id)).not.toContain(row.id);
  });
});

describe('reaping a genuinely abandoned execution', () => {
  it('transitions running -> failed with error_code abandoned', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue, asked } = stubQueue(new Map([[row.jobId!, 'failed']]));

    await runReaperCycle(queue, 45);

    expect(asked).toContain(row.jobId);
    const after = await readRow(row.id);
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('abandoned');
    expect(after.completed_at).not.toBeNull();
    expect(after.error_message).toContain('BullMQ job state: failed');
  });

  it('reaps a job BullMQ has forgotten entirely', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'unknown']]));
    await runReaperCycle(queue, 45);
    expect((await readRow(row.id)).error_code).toBe('abandoned');
  });

  it('reaps a completed job whose result never reached Core', async () => {
    // The worker finished, Core was down when it reported. The job is over.
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'completed']]));
    await runReaperCycle(queue, 45);
    expect((await readRow(row.id)).status).toBe('failed');
  });

  it('reaps a row with no job_id without asking BullMQ', async () => {
    const row = await seedRunning({ jobId: null });
    const { queue, asked } = stubQueue(new Map());
    await runReaperCycle(queue, 45);

    expect(asked, 'there is no job id to ask about').not.toContain(null);
    const after = await readRow(row.id);
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('abandoned');
  });
});

describe('rows that must survive a cycle', () => {
  it('leaves a delayed job alone — it is waiting out the 600s tail', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'delayed']]));

    await runReaperCycle(queue, 45);

    const after = await readRow(row.id);
    expect(after.status, 'a delayed job is live work').toBe('running');
    expect(after.completed_at).toBeNull();
  });

  it.each(['active', 'waiting', 'prioritized', 'waiting-children'] as const)(
    'leaves a %s job alone',
    async (state) => {
      const row = await seedRunning({ jobId: newId('aij') });
      const { queue } = stubQueue(new Map([[row.jobId!, state]]));
      await runReaperCycle(queue, 45);
      expect((await readRow(row.id)).status).toBe('running');
    },
  );

  it('leaves a young row alone even when its job is dead', async () => {
    // Threshold, not job state, is what makes a row a candidate at all.
    const row = await seedRunning({ jobId: newId('aij'), age: '2 minutes' });
    const { queue } = stubQueue(new Map([[row.jobId!, 'failed']]));
    await runReaperCycle(queue, 45);
    expect((await readRow(row.id)).status).toBe('running');
  });
});

describe('Redis unavailability', () => {
  it('RETAINS every candidate when the lookup throws', async () => {
    const a = await seedRunning({ jobId: newId('aij') });
    const b = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(
      new Map([
        [a.jobId!, 'THROW' as const],
        [b.jobId!, 'THROW' as const],
      ]),
    );

    const stats = await runReaperCycle(queue, 45);

    expect((await readRow(a.id)).status).toBe('running');
    expect((await readRow(b.id)).status).toBe('running');
    expect(stats.skipped_redis).toBeGreaterThanOrEqual(2);
    expect(stats.reaped, 'a Redis outage must never reap anything').toBe(0);
  });

  it('bounds a lookup that never answers, and still retains', async () => {
    /**
     * The real outage shape, and the one a throwing stub does NOT reproduce:
     * BullMQ's getJobState awaits waitUntilReady(), which never settles while
     * Redis is unreachable. Verified live against a dead port. Without the
     * timeout the cycle hangs on its first candidate forever and the
     * retain-on-outage rule never actually executes.
     */
    const row = await seedRunning({ jobId: newId('aij') });
    const q = {
      getJobState: (jobId: string) =>
        jobId === row.jobId ? new Promise<string>(() => {}) : Promise.resolve('active'),
    } as unknown as Queue<AIJob>;

    const started = Date.now();
    const stats = await runReaperCycle(q, 45);

    expect(Date.now() - started, 'must not hang').toBeLessThan(15_000);
    expect((await readRow(row.id)).status).toBe('running');
    expect(stats.reaped).toBe(0);
    expect(stats.skipped_redis).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('stops asking after the first failure instead of timing out per row', async () => {
    // Redis is up or down for the whole batch. Waiting out the timeout once
    // per candidate would make an outage cycle take minutes.
    const rows = await Promise.all([
      seedRunning({ jobId: newId('aij') }),
      seedRunning({ jobId: newId('aij') }),
      seedRunning({ jobId: newId('aij') }),
    ]);
    const asked: string[] = [];
    const q = {
      getJobState: async (jobId: string) => {
        asked.push(jobId);
        if (rows.some((r) => r.jobId === jobId)) throw new Error('Connection is closed.');
        return 'active';
      },
    } as unknown as Queue<AIJob>;

    const stats = await runReaperCycle(q, 45);

    const mine = asked.filter((id) => rows.some((r) => r.jobId === id));
    expect(mine, 'one failure is enough to condemn the cycle').toHaveLength(1);
    for (const r of rows) expect((await readRow(r.id)).status).toBe('running');
    expect(stats.reaped).toBe(0);
  });

  it('still reaps a NULL job_id row during an outage — BullMQ is not consulted', async () => {
    const dead = await seedRunning({ jobId: newId('aij') });
    const orphan = await seedRunning({ jobId: null });
    const q = {
      getJobState: async (jobId: string) => {
        if (jobId === dead.jobId) throw new Error('Connection is closed.');
        return 'active';
      },
    } as unknown as Queue<AIJob>;

    await runReaperCycle(q, 45);

    expect((await readRow(dead.id)).status).toBe('running');
    expect(
      (await readRow(orphan.id)).status,
      'no job id means no lookup, so the outage is irrelevant',
    ).toBe('failed');
  });

  it('the lookup bound is 5s — Phase 3 Step 6 regression guard', () => {
    /**
     * Step 6 audits every boundary that can wait forever, and this is the
     * reaper's. It must stay well under the 60s cycle interval so a full
     * outage batch cannot overrun into the next cycle, and well over a healthy
     * lookup (single-digit ms) so a slow-but-alive Redis is not misread as
     * down.
     */
    expect(LOOKUP_TIMEOUT_MS).toBe(5_000);
    expect(LOOKUP_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('does not throw out of the cycle', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'THROW' as const]]));
    await expect(runReaperCycle(queue, 45)).resolves.toBeDefined();
  });
});

describe('the job_id guard closes the re-claim race', () => {
  it('does NOT reap a row that was re-claimed under a new job id', async () => {
    /**
     * The sequence: the reaper selects a candidate and asks BullMQ about job
     * A, which is dead. Meanwhile the outbox re-dispatches and claimExecution
     * sets job_id = B, leaving status 'running'. Without the job_id guard the
     * UPDATE would match and abandon a job that is about to run.
     */
    const row = await seedRunning({ jobId: newId('aij') });
    const oldJobId = row.jobId!;

    const reclaimed = newId('aij');
    const q = {
      getJobState: async (jobId: string) => {
        if (jobId === oldJobId) {
          // Simulate the re-claim landing between the scan and the UPDATE.
          await withScope(
            { productScope: [PRODUCT_A], role: 'none', requestId: 'reclaim' },
            (tx) =>
              tx.query(`UPDATE ai_execution SET job_id = $2, attempt = attempt + 1 WHERE id = $1`, [
                row.id,
                reclaimed,
              ]),
          );
          return 'failed';
        }
        return 'active';
      },
    } as unknown as Queue<AIJob>;

    const stats = await runReaperCycle(q, 45);

    const after = await readRow(row.id);
    expect(after.status, 'the re-claimed job is live work').toBe('running');
    expect(after.job_id).toBe(reclaimed);
    expect(stats.races).toBeGreaterThanOrEqual(1);
  });

  it('a row that turned terminal mid-cycle is left exactly as it was', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const q = {
      getJobState: async (jobId: string) => {
        if (jobId === row.jobId) {
          // A worker's terminal report (Step 4) commits first.
          await withScope(
            { productScope: [PRODUCT_A], role: 'none', requestId: 'reported' },
            (tx) =>
              tx.query(
                `UPDATE ai_execution
                    SET status='failed', error_code='retries_exhausted', completed_at=now()
                  WHERE id = $1`,
                [row.id],
              ),
          );
          return 'failed';
        }
        return 'active';
      },
    } as unknown as Queue<AIJob>;

    await runReaperCycle(q, 45);

    const after = await readRow(row.id);
    expect(after.error_code, 'the reporter won; the reaper must not overwrite').toBe(
      'retries_exhausted',
    );
  });
});

describe('audit', () => {
  it('writes exactly one audit row, in the same transaction', async () => {
    const row = await seedRunning({ jobId: newId('aij'), attempt: 4 });
    const { queue } = stubQueue(new Map([[row.jobId!, 'failed']]));
    await runReaperCycle(queue, 45);

    const entries = await auditFor(row.id);
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.action).toBe('ai.execution_failed');
    expect(entry.actor_type, 'a background reconciler is a system actor').toBe('system');
    expect(entry.entity_type).toBe('ticket');
    expect(entry.entity_id, 'so it appears in ticket history unchanged').toBe(ticketId);
    expect(entry.product_id).toBe(PRODUCT_A);
    expect(entry.after.error_code).toBe('abandoned');
    expect(entry.after.reaped).toBe(true);
    expect(entry.after.job_state).toBe('failed');
    expect(entry.after.attempt).toBe(4);
  });

  it('writes NO audit row when the reaper loses the race', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const q = {
      getJobState: async (jobId: string) => {
        if (jobId === row.jobId) {
          await withScope(
            { productScope: [PRODUCT_A], role: 'none', requestId: 'raced' },
            (tx) =>
              tx.query(
                `UPDATE ai_execution SET status='succeeded', completed_at=now() WHERE id=$1`,
                [row.id],
              ),
          );
          return 'failed';
        }
        return 'active';
      },
    } as unknown as Queue<AIJob>;

    await runReaperCycle(q, 45);
    expect(await auditFor(row.id), 'no state change, no audit row').toHaveLength(0);
  });

  it('carries no ticket text', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'unknown']]));
    await runReaperCycle(queue, 45);

    const serialised = JSON.stringify((await auditFor(row.id))[0]!.after);
    expect(serialised).not.toContain('A ticket to hang executions from');
    expect(serialised).not.toContain('Reaper fixture');
  });
});

describe('the reaper never re-enqueues', () => {
  it('only ever reads job state — no add, no retry, no promote', async () => {
    /**
     * BullMQ is the sole retry owner. A reaper that re-enqueued would be a
     * second, uncoordinated delay authority, which is exactly what the
     * architecture forbids. Asserted by giving it a queue that has no other
     * method: any write call would be a TypeError.
     */
    const row = await seedRunning({ jobId: newId('aij') });
    // Scoped to this row's job id like every other stub here: a blanket
    // 'failed' would reap every genuinely-abandoned row in a shared
    // development database, which is not this test's business.
    const q = {
      getJobState: async (jobId: string) => (jobId === row.jobId ? 'failed' : 'active'),
    } as unknown as Queue<AIJob>;
    await expect(runReaperCycle(q, 45)).resolves.toBeDefined();
    expect((await readRow(row.id)).status).toBe('failed');
  });
});

describe('batching and idempotence', () => {
  it('a second cycle over the same rows changes nothing', async () => {
    const row = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(new Map([[row.jobId!, 'failed']]));

    await runReaperCycle(queue, 45);
    const first = await readRow(row.id);
    const second = await runReaperCycle(queue, 45);

    expect(second.candidates >= 0).toBe(true);
    const now = await readRow(row.id);
    // The status filter alone makes the row invisible to the second pass.
    expect(now.completed_at?.toISOString()).toBe(first.completed_at?.toISOString());
    expect(now.error_code).toBe('abandoned');
  });

  it('reaps several rows in one cycle', async () => {
    const rows = await Promise.all([
      seedRunning({ jobId: newId('aij') }),
      seedRunning({ jobId: newId('aij') }),
      seedRunning({ jobId: newId('aij') }),
    ]);
    const { queue } = stubQueue(new Map(rows.map((r) => [r.jobId!, 'failed' as const])));

    await runReaperCycle(queue, 45);

    for (const r of rows) expect((await readRow(r.id)).status).toBe('failed');
  });

  it('mixes reap and retain decisions correctly in one pass', async () => {
    const dead = await seedRunning({ jobId: newId('aij') });
    const live = await seedRunning({ jobId: newId('aij') });
    const blind = await seedRunning({ jobId: newId('aij') });
    const { queue } = stubQueue(
      new Map([
        [dead.jobId!, 'failed' as const],
        [live.jobId!, 'delayed' as const],
        [blind.jobId!, 'THROW' as const],
      ]),
    );

    await runReaperCycle(queue, 45);

    expect((await readRow(dead.id)).status).toBe('failed');
    expect((await readRow(live.id)).status).toBe('running');
    expect((await readRow(blind.id)).status).toBe('running');
  });
});

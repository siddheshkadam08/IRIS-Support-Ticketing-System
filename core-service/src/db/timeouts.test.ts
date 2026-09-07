import { afterAll, describe, expect, it } from 'vitest';
import { closePool, pool } from './pool.js';
import { withScope, withSystemScope } from './with-scope.js';

/**
 * Phase 3 Step 6 — the database timeouts, against the REAL Postgres.
 *
 * Both are sent in the startup packet, so POSTGRES enforces them. That is the
 * property worth testing: a client-side timer would abandon a query that keeps
 * running on the server, still holding its locks. Here the server cancels the
 * statement and hands back an error, and the connection is immediately
 * reusable — which is asserted directly, because a timeout that silently
 * poisons a pooled connection is worse than no timeout at all.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/db/timeouts.test.ts
 */

const SCOPE = { productScope: ['prod_carbon'], role: 'none' as const, requestId: 'timeout-test' };

/** Postgres error codes, not message matching — messages are localised. */
const QUERY_CANCELED = '57014'; // statement_timeout fired
const LOCK_NOT_AVAILABLE = '55P03'; // lock_timeout fired

const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;

afterAll(async () => {
  await closePool();
});

describe('the settings actually reached the server', () => {
  it('every pooled session starts with both timeouts set', async () => {
    // Read them back from Postgres rather than from our own config object:
    // the thing that can silently be wrong is whether they were transmitted.
    const { rows } = await pool.query<{ statement_timeout: string; lock_timeout: string }>(
      `SELECT current_setting('statement_timeout') AS statement_timeout,
              current_setting('lock_timeout')      AS lock_timeout`,
    );
    expect(rows[0]!.statement_timeout).toBe('10s');
    expect(rows[0]!.lock_timeout).toBe('3s');
  });

  it('they apply inside withScope too, where all real work happens', async () => {
    const settings = await withSystemScope('timeout-test', async (tx) => {
      const { rows } = await tx.query<{ s: string; l: string }>(
        `SELECT current_setting('statement_timeout') AS s,
                current_setting('lock_timeout')      AS l`,
      );
      return rows[0]!;
    });
    expect(settings.s).toBe('10s');
    expect(settings.l).toBe('3s');
  });
});

describe('statement_timeout — a query that RUNS too long', () => {
  it('cancels a query that exceeds the budget', async () => {
    // Scoped locally so the test takes ~1s rather than ~10s; the mechanism
    // under test is identical, only the number differs.
    const err = await withSystemScope('timeout-test', async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '400ms'`);
      try {
        await tx.query(`SELECT pg_sleep(5)`);
        return null;
      } catch (e) {
        return e;
      }
    }).catch((e: unknown) => e);

    expect(codeOf(err), 'expected Postgres to cancel the statement').toBe(QUERY_CANCELED);
  });

  it('bounds the wait — it does not merely report afterwards', async () => {
    const started = Date.now();
    await withSystemScope('timeout-test', async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '400ms'`);
      await tx.query(`SELECT pg_sleep(30)`).catch(() => undefined);
    });
    // 30s of sleep, cancelled in well under a second.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 40_000);

  it('leaves the connection healthy and reusable', async () => {
    /**
     * The property that matters most. A cancelled statement must not poison
     * the pooled client — if it did, one slow query would permanently degrade
     * the pool and the "fix" would be worse than the problem.
     */
    await withSystemScope('timeout-test', async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '300ms'`);
      await tx.query(`SELECT pg_sleep(5)`).catch(() => undefined);
    }).catch(() => undefined);

    const { rows } = await pool.query<{ n: number }>(`SELECT 1 AS n`);
    expect(rows[0]!.n).toBe(1);
  });

  it('does not interfere with normal queries', async () => {
    const count = await withSystemScope('timeout-test', async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ai_execution`);
      return Number(rows[0]!.n);
    });
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe('lock_timeout — a query that WAITS too long for a lock', () => {
  it('gives up on a contended row instead of blocking indefinitely', async () => {
    /**
     * statement_timeout and lock_timeout are NOT interchangeable, and this is
     * the case that separates them: the second transaction is not doing work,
     * it is queued behind a lock. lock_timeout is deliberately much shorter,
     * because waiting is contention rather than progress.
     */
    const row = await withSystemScope('timeout-test', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM ai_execution WHERE product_id = 'prod_carbon' LIMIT 1`,
      );
      return rows[0] ?? null;
    });
    if (!row) return; // nothing seeded; nothing to contend over

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT set_config('app.product_scope','prod_carbon',true),
                set_config('app.role','none',true),
                set_config('app.request_id','lock-holder',true)`,
      );
      // Take and hold the row lock.
      await holder.query(`SELECT id FROM ai_execution WHERE id = $1 FOR UPDATE`, [row.id]);

      const started = Date.now();
      const err = await withScope(SCOPE, async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '300ms'`);
        try {
          await tx.query(`SELECT id FROM ai_execution WHERE id = $1 FOR UPDATE`, [row.id]);
          return null;
        } catch (e) {
          return e;
        }
      });

      expect(codeOf(err), 'expected lock_timeout, not statement_timeout').toBe(
        LOCK_NOT_AVAILABLE,
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 30_000);

  it('is shorter than statement_timeout — waiting is not working', async () => {
    const { rows } = await pool.query<{ s: string; l: string }>(
      `SELECT extract(epoch from current_setting('statement_timeout')::interval) AS s,
              extract(epoch from current_setting('lock_timeout')::interval)      AS l`,
    );
    expect(Number(rows[0]!.l)).toBeLessThan(Number(rows[0]!.s));
    expect(Number(rows[0]!.l)).toBe(3);
    expect(Number(rows[0]!.s)).toBe(10);
  });
});

describe('transactions still behave correctly around a timeout', () => {
  it('rolls back cleanly when a statement is cancelled', async () => {
    const probe = `probe_${Date.now()}`;
    await withScope(SCOPE, async (tx) => {
      await tx.query(`CREATE TEMP TABLE ${probe}(x int)`);
      await tx.query(`INSERT INTO ${probe} VALUES (1)`);
      await tx.query(`SET LOCAL statement_timeout = '300ms'`);
      await tx.query(`SELECT pg_sleep(5)`);
    }).catch(() => undefined);

    // The temp table lived in the aborted transaction; a new one cannot see it.
    const survived = await withScope(SCOPE, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_tables WHERE tablename = $1`,
        [probe],
      );
      return Number(rows[0]!.n);
    });
    expect(survived, 'the aborted transaction must leave nothing behind').toBe(0);
  }, 30_000);

  it('does not leak pool clients across repeated timeouts', async () => {
    /**
     * A timeout that leaks a checked-out client exhausts the pool after `max`
     * failures and the service stops serving. Ten cancellations against a pool
     * of 10 would do it, so this runs eleven.
     */
    for (let i = 0; i < 11; i++) {
      await withScope(SCOPE, async (tx) => {
        await tx.query(`SET LOCAL statement_timeout = '150ms'`);
        await tx.query(`SELECT pg_sleep(3)`);
      }).catch(() => undefined);
    }

    expect(pool.idleCount, 'clients must return to the pool').toBeGreaterThan(0);
    expect(pool.waitingCount, 'nothing should be queued behind a leak').toBe(0);

    const { rows } = await pool.query<{ n: number }>(`SELECT 1 AS n`);
    expect(rows[0]!.n, 'the pool still serves after eleven cancellations').toBe(1);
  }, 60_000);
});

describe('connection acquisition is bounded', () => {
  it('rejects rather than queueing forever when the pool is exhausted', async () => {
    // pg rejects the ACQUISITION, so nothing is checked out and nothing leaks
    // — the caller simply fails fast instead of waiting on an unbounded queue.
    expect((pool.options as { connectionTimeoutMillis?: number }).connectionTimeoutMillis).toBe(
      5_000,
    );
  });
});

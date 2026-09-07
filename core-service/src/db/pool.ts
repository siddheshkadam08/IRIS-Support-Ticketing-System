import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * The one and only connection pool in the entire platform.
 *
 * Nothing outside src/db/ may import this. Everything goes through
 * withScope() so that RLS session state is always set — see with-scope.ts.
 */
export const pool = new pg.Pool({
  connectionString: config.CORE_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  /**
   * How long `pool.connect()` waits for a free client before rejecting.
   *
   * With max: 10, a burst that outlasts the pool queues rather than fails —
   * this is what stops that queue being unbounded. pg rejects the acquisition
   * itself, so nothing is checked out and nothing leaks; the request surfaces
   * as a normal 500 and the caller retries.
   */
  connectionTimeoutMillis: 5_000,

  /**
   * ── Phase 3 Step 6: the two database timeouts ──────────────────────────
   *
   * Both are sent in the startup packet (`[CODE]` pg client.js:549-554), so
   * POSTGRES enforces them server-side on every session this pool opens. That
   * matters: a client-side timer would abandon a query that keeps running on
   * the server, holding its locks and its backend — the opposite of what a
   * timeout is for. Here the server cancels the statement, the client gets a
   * real error, and the connection returns to the pool healthy and reusable.
   *
   * They are deliberately set at the POOL rather than per-call. `withScope()`
   * is documented as the only way to reach Postgres, so this is the one place
   * that covers every query — including the AI execution path — without
   * scattering the same rule across call sites where it would be forgotten.
   * Migrations and seeds are unaffected: they open their own `pg.Client` on
   * ADMIN_DATABASE_URL and legitimately run long.
   *
   * The two protect DIFFERENT things and are not interchangeable:
   */

  /** A query that RUNS too long. 10s is far above any query this app issues. */
  statement_timeout: 10_000,

  /**
   * A query that WAITS too long for a row lock. Deliberately much shorter:
   * blocking on a lock is contention, not work, and the AI result path takes
   * row locks on ai_execution that the reaper can also be holding. Failing
   * fast turns a pile-up into one retryable error instead of ten backends
   * queued behind a single slow writer.
   */
  lock_timeout: 3_000,

  application_name: 'iris-core-service',
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

export async function assertNotOwner(): Promise<void> {
  const { rows } = await pool.query<{ usename: string; superuser: boolean; bypassrls: boolean }>(
    `SELECT current_user AS usename,
            (SELECT rolsuper    FROM pg_roles WHERE rolname = current_user) AS superuser,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
  );
  const me = rows[0];
  if (!me) throw new Error('could not determine current database role');

  // A superuser or BYPASSRLS role silently disables every isolation policy.
  // Refuse to start rather than serve traffic with a false security claim.
  if (me.superuser || me.bypassrls) {
    throw new Error(
      `core-service is connected as '${me.usename}', which is SUPERUSER/BYPASSRLS. ` +
        `RLS would be silently bypassed. Connect as the non-owner iris_app role. ` +
        `See docs/adr/004-isolation-row-level-security.md`,
    );
  }
  logger.info({ role: me.usename }, 'database role verified — RLS applies');
}

export async function closePool(): Promise<void> {
  await pool.end();
}

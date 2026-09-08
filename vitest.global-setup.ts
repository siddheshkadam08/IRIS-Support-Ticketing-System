import pg from 'pg';
import { loadRootEnv } from './shared/types/env.js';

/**
 * Test-suite cleanup — Phase 5 hardening, GAP 3.
 *
 * THE PROBLEM THIS SOLVES. The integration suites create real tickets through
 * the real route, which writes real `event_outbox` rows. Those rows are
 * indistinguishable from production work, so a running dev stack's dispatcher
 * picks them up, enqueues real BullMQ jobs and makes real provider calls. A
 * suite run therefore used to leave behind hundreds of queued jobs and
 * `running` executions, and the next run inherited that backlog — which is how
 * `test:ai` came to need a manual queue drain before it would pass.
 *
 * Tests that need dispatch drive it explicitly; none of them rely on the
 * ambient dispatcher. So the debris is pure side effect, and clearing it is
 * cleanup rather than a behaviour change.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not create an isolated queue, a
 * second database or a parallel dispatcher. The suites genuinely exercise the
 * real schema, real RLS and real constraints, and that is most of their value.
 *
 * ⚠️ IT ALSO CANNOT PREVENT MID-RUN INTERFERENCE. While a dev stack is running,
 * its dispatcher and reaper act on test rows *as the suite runs*. This teardown
 * removes the debris a run leaves; it cannot stop a concurrent process from
 * competing during one. Run the suite without a live stack — as CI does.
 */

/**
 * TWO separate statements, not one.
 *
 * pg rejects multiple commands in a single PARAMETERISED query
 * ("cannot insert multiple commands into a prepared statement"), and the
 * original combined version failed on exactly that — silently, because the
 * catch below swallowed it. That silence is how the debris accumulated in the
 * first place, which is why the catch now logs.
 */
const PUBLISH_TEST_EVENTS = `
  -- Neutralise events the suite created so no dispatcher picks them up later.
  UPDATE event_outbox
     SET published_at = now()
   WHERE created_at >= $1
     AND published_at IS NULL
     AND event_type = 'ticket.created'
`;

const CLOSE_TEST_EXECUTIONS = `
  -- Close executions the suite left mid-flight. Without this they age past the
  -- 45-minute threshold and a live reaper later reports them as abandoned
  -- production work, which they are not.
  UPDATE ai_execution
     SET status = 'failed',
         error_code = 'test_cleanup',
         completed_at = now()
   WHERE created_at >= $1
     AND status = 'running'
`;

let startedAt: Date;

export async function setup(): Promise<void> {
  // The suites get their config through loadRootEnv(); this runs before any of
  // them, so process.env is otherwise empty here and the teardown below would
  // silently find no database and clean nothing.
  loadRootEnv();
  startedAt = new Date();
}

export async function teardown(): Promise<void> {
  const url = process.env.CORE_DATABASE_URL;
  if (!url) {
    console.warn('[test-cleanup] CORE_DATABASE_URL unset — skipping cleanup');
    return;
  }

  const client = new pg.Client({ connectionString: url, application_name: 'iris-test-cleanup' });
  try {
    await client.connect();
    const since = startedAt ?? new Date(Date.now() - 3_600_000);

    /**
     * RLS APPLIES HERE TOO, and silently.
     *
     * This connects as `iris_app`, a non-owner role with FORCE ROW LEVEL
     * SECURITY on both tables. With no scope GUCs set, `app_role()` is 'none'
     * and `app_scope()` is NULL, so every row is invisible and both UPDATEs
     * match zero rows — no error, just nothing cleaned. That is exactly what
     * happened, and it is RLS working correctly rather than a policy bug.
     *
     * SET LOCAL inside a transaction, mirroring withSystemScope(): the scope
     * dies with the transaction and cannot leak into a pooled connection.
     */
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.role', 'super_admin', true),
              set_config('app.product_scope', '', true),
              set_config('app.request_id', 'test-cleanup', true)`,
    );
    const events = await client.query(PUBLISH_TEST_EVENTS, [since]);
    const execs = await client.query(CLOSE_TEST_EXECUTIONS, [since]);
    await client.query('COMMIT');
    console.log(
      `[test-cleanup] events neutralised=${events.rowCount ?? 0} executions closed=${execs.rowCount ?? 0}`,
    );
  } catch (err) {
    // Cleanup must never fail a run that otherwise passed. Leftover rows are
    // untidy; a teardown crash that masks a green suite is worse. It is still
    // reported, because silent cleanup is how the debris accumulated before.
    console.warn('[test-cleanup] failed:', err instanceof Error ? err.message : err);
  } finally {
    await client.end().catch(() => undefined);
  }
}

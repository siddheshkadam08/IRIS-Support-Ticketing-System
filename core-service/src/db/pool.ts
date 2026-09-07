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
  connectionTimeoutMillis: 5_000,
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

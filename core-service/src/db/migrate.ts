/**
 * Forward-only migration runner.
 *
 * Runs as the ADMIN role (superuser) because 001 creates roles and extensions.
 * The application itself never uses this connection — it uses the non-owner
 * iris_app role via src/db/pool.ts.
 *
 *   npm run migrate --workspace=core-service
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../../infra/migrations');

const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

async function run(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'iris-migrate' });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migration');
    const applied = new Set(rows.map((r) => r.filename));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  · ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ✓ ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${file}`);
        throw err;
      }
    }
    console.log(count === 0 ? '\nSchema already up to date.' : `\nApplied ${count} migration(s).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

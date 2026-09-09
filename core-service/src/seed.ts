/**
 * Seed a demo-ready database. Idempotent and re-runnable.
 *
 * Runs as the ADMIN role because it writes reference data (product,
 * support_user, kb_article) that iris_app deliberately cannot INSERT.
 *
 *   npm run seed
 */
import pg from 'pg';
import { encryptSecret, hashPassword, hashSecret, newId } from '@iris/shared/types';
import { loadRootEnv } from '@iris/shared/types';

loadRootEnv();

const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

const MOCK_PRODUCT_CALLBACK = 'http://localhost:6001/iris/access-callback';
const DEMO_PASSWORD = 'Abc@1234';

// ─────────────────────────────────────────────────────────────────────────
// Tenants
//
// A tenant here is an integrating product. All four share one generic
// category set — no invented domain content ships in a demo. What differs is
// branding and access mechanism, which is exactly what proves "one widget,
// many products".
// ─────────────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { value: 'login_access', label: 'Login / Access' },
  { value: 'reports', label: 'Reports & Exports' },
  { value: 'data_mismatch', label: 'Data Mismatch' },
  { value: 'performance', label: 'Performance' },
  { value: 'billing', label: 'Billing' },
  { value: 'other', label: 'Something else' },
];

const SUGGESTIONS = [
  'How do I reset my password?',
  'Why is my invoice not showing?',
  "I'm getting an error while exporting data",
];

interface TenantSpec {
  id: string;
  slug: string;
  name: string;
  ref_prefix: string;
  colour: string;
  accent: string;
  mechanism: 'callback' | 'preauth';
  clientSecret: string;
  /** Fixed, not generated — the docs and the demo page reference these. */
  publishableKey: string;
}

const TENANTS: TenantSpec[] = [
  {
    id: 'prod_carbon', slug: 'carbon', name: 'Carbon', ref_prefix: 'CARB',
    colour: '#1D4ED8', accent: '#1E40AF', mechanism: 'callback',
    // Published in docs/api-contract.md §3.3 as the worked example — keep it.
    clientSecret: 'sk_test_51H9xQmKvB2nRtYwLpZaCdEfG',
    publishableKey: 'pub_live_carbon_8f2a',
  },
  {
    id: 'prod_esg', slug: 'esg', name: 'ESG', ref_prefix: 'ESG',
    colour: '#047857', accent: '#059669', mechanism: 'preauth',
    clientSecret: 'sk_test_esg_4Rt7YuIoPaSdFgHj',
    publishableKey: 'pub_live_esg_5b1c',
  },
  {
    id: 'prod_ifile', slug: 'ifile', name: 'iFile', ref_prefix: 'IFIL',
    colour: '#6D28D9', accent: '#7C3AED', mechanism: 'callback',
    clientSecret: 'sk_test_ifile_9KlZxCvBnMqWeRty',
    publishableKey: 'pub_live_ifile_3c7b',
  },
  {
    id: 'prod_ideal', slug: 'ideal', name: 'iDeal', ref_prefix: 'IDEA',
    colour: '#B45309', accent: '#D97706', mechanism: 'preauth',
    clientSecret: 'sk_test_ideal_2QaZwSxEdCrFvTgb',
    publishableKey: 'pub_live_ideal_6d9e',
  },
];

/**
 * The categories where a total outage is a business emergency rather than an
 * inconvenience — Phase 4's `core_category_system_down_bonus` (+15).
 *
 * ⚠️ MUST BE A SUBSET OF `CATEGORIES[].value`. `invalidCoreCategories` in
 * products/product.repo.ts enforces that against the MERGED config inside the
 * write transaction; this list is only the seeded starting point, and a typo
 * here fails that check loudly rather than silently disabling the bonus.
 *
 * `billing` is deliberately absent: a billing page being down is urgent, but it
 * does not stop the customer doing their job the way login or reporting does.
 * `other` is absent because a catch-all cannot be a core workflow.
 */
const CORE_CATEGORIES = ['login_access', 'reports', 'data_mismatch'];

/**
 * ⚠️ THE AUTO-ROUTING KILL SWITCH, AND WHY IT LIVES IN THE SEED.
 *
 * `auto_route_p1 = 1.01` is unreachable: the model's `category_confidence` is
 * bounded at 1.0, so `determineRouting` can never return `auto_route` and every
 * classification lands as `ai_uncertain` for human review. The whole pipeline
 * still runs — this disables the DECISION, not the capability.
 *
 * It is here because it was previously applied by hand to the live database
 * only, and this seed replaces `product.config` wholesale on conflict. A single
 * `npm run seed` therefore silently restored the 0.8 default and re-enabled
 * unattended routing on a confidence signal Phase 4 measured as uncalibrated
 * (self-reported >=0.95 on nearly every ticket, which put 21 of 23 into
 * AUTO_ROUTE). A safety control that a routine rebuild removes is not a
 * control. `products/seed-safety.integration.test.ts` asserts it stays above
 * 1.0 against the DEPLOYED database — a unit test over this constant would only
 * prove the seed intends the right thing, not that the running system has it.
 *
 * ⚠️ DO NOT LOWER THIS to make auto-routing "work". Lower it only when accept/
 * reject data from the ai_uncertain queue shows the confidence signal actually
 * separates correct classifications from incorrect ones.
 */
const AI_THRESHOLDS = {
  auto_route_p1: 1.01,
  auto_route_margin: 0.25,
  triage_floor: 0.5,
};

const tenantConfig = (t: TenantSpec) => ({
  categories: CATEGORIES,
  core_categories: CORE_CATEGORIES,
  ai_thresholds: AI_THRESHOLDS,
  default_severity: 'medium',
  widget: {
    title: `${t.name} Support`,
    subtitle: 'Your smart support assistant',
    greeting: 'How can I help you today?',
    primary_color: t.colour,
    accent_color: t.accent,
    suggestions: SUGGESTIONS,
    allow_anonymous: true,
    fields: { subject: true, category: true, severity: true, attachments: true },
  },
  knowledge_base: { enabled: true },
  deflection: { enabled: true, min_score: 0.05, max_suggestions: 4 },
  access: { max_ttl_seconds: 86400, scope_kind: 'ticket' },
  auto_close_days: 3,
});

// ─────────────────────────────────────────────────────────────────────────
// Support users
//
// admin@irisregtech.com is the PLATFORM super admin — no scope rows, which
// means all tenants. Everyone else is scoped tenant-wise.
// ops.manager holds two tenants deliberately: it makes multi-tenant scoping
// something you can see rather than infer.
// ─────────────────────────────────────────────────────────────────────────
interface UserSpec {
  email: string;
  name: string;
  role: 'super_admin' | 'product_admin' | 'manager' | 'agent';
  scopes: string[];
  skills: string[];
}

const USERS: UserSpec[] = [
  { email: 'admin@irisregtech.com', name: 'IRIS Platform Admin', role: 'super_admin', scopes: [], skills: ['platform'] },

  { email: 'ops.manager@irisregtech.com', name: 'Aman Kumar', role: 'manager',
    scopes: ['prod_carbon', 'prod_esg'], skills: ['performance', 'infra'] },

  { email: 'carbon.admin@irisregtech.com', name: 'Priya Nair', role: 'product_admin', scopes: ['prod_carbon'], skills: ['access', 'users'] },
  { email: 'carbon.agent@irisregtech.com', name: 'Rahul Verma', role: 'agent', scopes: ['prod_carbon'], skills: ['reports', 'data'] },

  { email: 'esg.admin@irisregtech.com', name: 'Sneha Das', role: 'product_admin', scopes: ['prod_esg'], skills: ['reports'] },
  { email: 'esg.agent@irisregtech.com', name: 'Vikram Rao', role: 'agent', scopes: ['prod_esg'], skills: ['data'] },

  { email: 'ifile.admin@irisregtech.com', name: 'Neha Iyer', role: 'product_admin', scopes: ['prod_ifile'], skills: ['filing'] },
  { email: 'ifile.agent@irisregtech.com', name: 'Amit Singh', role: 'agent', scopes: ['prod_ifile'], skills: ['reports'] },

  { email: 'ideal.admin@irisregtech.com', name: 'Rohit Sharma', role: 'product_admin', scopes: ['prod_ideal'], skills: ['billing'] },
  { email: 'ideal.agent@irisregtech.com', name: 'Kavya Menon', role: 'agent', scopes: ['prod_ideal'], skills: ['access'] },
];

// Generic KB — applies to any product, so nothing invented ships.
const KB: Array<[string, string, string]> = [
  ['login_access', 'How to reset your password',
    'If you cannot sign in, use the "Forgot password" link on the login screen. Enter the email address registered to your account and we will send a reset link that stays valid for 30 minutes. The link can only be used once. If the email does not arrive within five minutes, check your spam folder, then confirm with your administrator that the address on file is correct. Passwords must be at least 12 characters and cannot reuse any of your last five.'],
  ['login_access', 'Account locked after failed sign-in attempts',
    'Accounts lock automatically after ten consecutive failed sign-in attempts, as a protection against credential stuffing. The lock clears by itself after 15 minutes. If you need access sooner, an administrator can clear the lock immediately from Settings, Access and Roles. Repeated locks usually mean a saved password in a browser or mobile app is out of date.'],
  ['login_access', 'Adding a new user to your organisation',
    'Administrators add users from Settings, Users. Enter the email address and choose a role; the new user receives an invitation and sets their own password. Roles can be changed later without recreating the account.'],
  ['reports', 'Fixing failed report exports',
    'Report exports run as a background job. Exports larger than 50 MB time out and return an error rather than a file. Narrow the date range, or deselect columns you do not need, and run the export again. If a scheduled export keeps failing, clear the cached report definition from Reports, Manage, Rebuild cache. A 500 error on the download button almost always means the underlying job expired before the file was fetched — regenerate rather than retrying the download.'],
  ['reports', 'Scheduling a recurring report',
    'Open the report you want to schedule, choose Schedule from the toolbar, and pick a frequency. Recipients must be existing users; external email addresses are rejected. Scheduled reports run at 02:00 in your organisation timezone and are retained for 30 days.'],
  ['reports', 'Why my export is missing recent rows',
    'Exports read from the reporting replica, which lags the primary by up to five minutes. Rows created in the last few minutes will not appear. For a real-time view use the on-screen grid rather than an export.'],
  ['data_mismatch', 'Totals do not match the dashboard',
    'The dashboard aggregates on the reporting replica and refreshes every 15 minutes; detail views read the primary directly. A difference immediately after a large import is expected and resolves at the next refresh. If a difference persists for more than an hour, it usually indicates a partially-completed import — check Imports, History for a run with status "partial" and re-run it.'],
  ['data_mismatch', 'Duplicate records after an import',
    'Imports match on the external reference column. Rows without a reference are always inserted as new, which is the usual cause of duplicates. Re-run the import with the reference column mapped, then use Data, Merge duplicates to consolidate.'],
  ['performance', 'The application is slow to load',
    'Slowness is most often caused by a very large saved filter loading on the landing page. Reset your default view from Settings, Preferences. If several people are affected at once, check the Announcements panel — planned maintenance and incidents are posted there first.'],
  ['performance', 'Timeouts when saving large forms',
    'Forms with more than 500 line items can exceed the request timeout. Save in batches, or use the bulk import template. We are raising this limit in a future release.'],
  ['billing', 'Why my invoice is not showing',
    'Invoices appear once the billing period closes, which is the first working day of the following month. If an invoice is missing after that date, confirm the billing contact on your account is correct — invoices are only visible to the billing contact and administrators. Draft invoices are never shown.'],
  ['other', 'Getting help and raising a ticket',
    'You can raise a support ticket from the help widget in any screen. Include what you expected to happen, what actually happened, and the time it occurred. Screenshots help a great deal. You will receive an email with a reference number and can track progress from My Tickets.'],
];

const TICKET_SUBJECTS: Array<[string, string, string]> = [
  ['Cannot sign in to the portal', 'login_access', 'high'],
  ['Export failing with a 500', 'reports', 'high'],
  ['Report not showing data', 'reports', 'medium'],
  ['Totals do not match the dashboard', 'data_mismatch', 'medium'],
  ['Page loading slowly', 'performance', 'low'],
  ['Invoice missing for last month', 'billing', 'medium'],
  ['Scheduled report never arrived', 'reports', 'high'],
  ['Duplicate rows after import', 'data_mismatch', 'low'],
  ['Password reset email never arrives', 'login_access', 'medium'],
  ['Timeout saving a large form', 'performance', 'high'],
];

const RESOLUTIONS = [
  'Cleared the cached report definition and regenerated the export — this completed successfully. The original job had expired before the download was fetched.',
  'The account was locked after repeated failed sign-ins from a stale saved password. Cleared the lock and confirmed the browser password was updated.',
  'This was replica lag after a bulk import. Totals matched at the next refresh; no data was lost.',
  'Narrowed the export date range to bring it under the 50 MB job limit, and the export completed in under a minute.',
  'The billing contact on the account was out of date, so invoices were not visible. Updated the contact and the invoice appeared.',
];

const ANNOUNCEMENTS: Array<[string, string, string]> = [
  ['Scheduled maintenance this Sunday', 'The service will be unavailable between 02:00 and 04:00 IST on Sunday while we upgrade the reporting database. Exports queued during this window will run afterwards.', 'maintenance'],
  ['Faster exports are rolling out', 'Report exports now stream directly rather than staging a temporary file. Large exports should complete roughly 40% faster. No action is needed.', 'release'],
  ['Resolved: intermittent dashboard timeouts', 'Between 09:10 and 10:45 IST some users saw timeouts loading the dashboard. The cause was a slow query on the reporting replica, now fixed. No data was affected.', 'incident'],
];

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'iris-seed' });
  await client.connect();

  try {
    await client.query('BEGIN');

    // ── tenants ───────────────────────────────────────────────────────
    for (const t of TENANTS) {
      const webhookSecret = `whsec_${t.slug}_7Kp2mXqR8vNtJdLwEaZb`;
      await client.query(
        `INSERT INTO product
           (id, slug, name, ref_prefix, client_id, client_secret_hash, client_secret_enc,
            publishable_key, webhook_secret_hash, webhook_secret_enc,
            allowed_origins, config, access_mechanism, access_callback_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE
           SET config = EXCLUDED.config,
               name = EXCLUDED.name,
               ref_prefix = EXCLUDED.ref_prefix,
               -- Credentials are part of the seed contract: docs and the demo
               -- page reference them, so a re-seed must converge on them
               -- rather than leaving whatever a previous run wrote.
               publishable_key = EXCLUDED.publishable_key,
               client_id = EXCLUDED.client_id,
               client_secret_hash = EXCLUDED.client_secret_hash,
               client_secret_enc = EXCLUDED.client_secret_enc,
               webhook_secret_hash = EXCLUDED.webhook_secret_hash,
               webhook_secret_enc = EXCLUDED.webhook_secret_enc,
               access_mechanism = EXCLUDED.access_mechanism,
               access_callback_url = EXCLUDED.access_callback_url,
               allowed_origins = EXCLUDED.allowed_origins`,
        [
          t.id, t.slug, t.name, t.ref_prefix,
          `iris_${t.slug}_client`,
          hashSecret(t.clientSecret), encryptSecret(t.clientSecret),
          t.publishableKey,
          hashSecret(webhookSecret), encryptSecret(webhookSecret),
          ['*'],                                   // local dev only; production uses an explicit list
          JSON.stringify(tenantConfig(t)),
          t.mechanism,
          // Only the callback tenants point at the mock product receiver.
          t.mechanism === 'callback' ? MOCK_PRODUCT_CALLBACK : null,
        ],
      );
    }

    // ── support users ─────────────────────────────────────────────────
    const passwordHash = hashPassword(DEMO_PASSWORD);
    const userIdByEmail = new Map<string, string>();

    for (const u of USERS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO support_user (id, email, display_name, role, password_hash, must_change_password)
         VALUES ($1,$2,$3,$4,$5,false)
         ON CONFLICT (email) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               role = EXCLUDED.role,
               password_hash = EXCLUDED.password_hash,
               is_active = true,
               failed_login_count = 0,
               locked_until = NULL
         RETURNING id`,
        [newId('su'), u.email, u.name, u.role, passwordHash],
      );
      const id = rows[0]!.id;
      userIdByEmail.set(u.email, id);

      // Tenant-wise scoping. A super_admin gets none — that absence is what
      // means "all tenants".
      await client.query(`DELETE FROM support_user_scope WHERE support_user_id = $1`, [id]);
      for (const productId of u.scopes) {
        await client.query(
          `INSERT INTO support_user_scope (support_user_id, product_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [id, productId],
        );
      }
      for (const skill of u.skills) {
        await client.query(
          `INSERT INTO support_user_skill (support_user_id, skill) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [id, skill],
        );
      }
    }

    // ── per-tenant content ────────────────────────────────────────────
    for (const t of TENANTS) {
      const agents = USERS.filter((u) => u.scopes.includes(t.id)).map((u) => userIdByEmail.get(u.email)!);
      const assignable = agents.length ? agents : [userIdByEmail.get('admin@irisregtech.com')!];

      const { rows: kbCount } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM kb_article WHERE product_id = $1`, [t.id],
      );
      if (Number(kbCount[0]!.n) === 0) {
        for (const [category, title, body] of KB) {
          await client.query(
            `INSERT INTO kb_article (id, product_id, title, body, category, status, is_public, views, helpful_yes, helpful_no)
             VALUES ($1,$2,$3,$4,$5,'published',true,$6,$7,$8)`,
            [newId('kb'), t.id, title, body, category,
             50 + Math.floor(Math.random() * 1200),
             20 + Math.floor(Math.random() * 200),
             Math.floor(Math.random() * 25)],
          );
        }
      }

      const { rows: annCount } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM announcement WHERE product_id = $1`, [t.id],
      );
      if (Number(annCount[0]!.n) === 0) {
        for (const [title, body, kind] of ANNOUNCEMENTS) {
          await client.query(
            `INSERT INTO announcement (id, product_id, title, body, kind) VALUES ($1,$2,$3,$4,$5)`,
            [newId('evt'), t.id, title, body, kind],
          );
        }
      }

      const { rows: tCount } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ticket WHERE product_id = $1`, [t.id],
      );
      if (Number(tCount[0]!.n) === 0) {
        const statuses = ['open', 'assigned', 'in_progress', 'waiting_on_raiser', 'resolved', 'closed'] as const;
        for (let i = 0; i < 40; i++) {
          const [subject, category, severity] = TICKET_SUBJECTS[i % TICKET_SUBJECTS.length]!;
          const status = statuses[i % statuses.length]!;
          const daysAgo = 1 + (i % 30);
          const raisedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
          const resolved = status === 'resolved' || status === 'closed';
          // Leave 'open' tickets unassigned so the triage queue is non-empty
          // and the zero-standing-access demo has something to assign.
          const assignee = status === 'open' ? null : assignable[i % assignable.length]!;
          const ticketId = newId('tkt');

          const { rows: seqRow } = await client.query<{ ticket_seq: number }>(
            `UPDATE product SET ticket_seq = ticket_seq + 1 WHERE id = $1 RETURNING ticket_seq`,
            [t.id],
          );

          await client.query(
            `INSERT INTO ticket
               (id, product_id, reference, product_tenant_id, raised_by_ref, raiser_identity,
                identity_assurance, subject, description, category, severity, status,
                classification_source, assignee_id, raised_at, first_response_at, resolved_at, closed_at, rating)
             VALUES ($1,$2,$3,$4,$5,$6,'sso',$7,$8,$9,$10,$11,'ai_auto',$12,$13,$14,$15,$16,$17)`,
            [
              ticketId, t.id, `${t.ref_prefix}-${seqRow[0]!.ticket_seq}`, 'acme-corp',
              `usr_seed_${i % 7}`,
              JSON.stringify({ name: `Demo User ${i % 7}`, email: `user${i % 7}@acme.example`, product_tenant_id: 'acme-corp' }),
              subject,
              `${subject}. Started around ${daysAgo} day(s) ago and is blocking our monthly close.`,
              category, severity, status,
              assignee,
              raisedAt,
              status === 'open' ? null : new Date(Date.now() - daysAgo * 86_400_000 + 3_600_000).toISOString(),
              resolved ? new Date(Date.now() - (daysAgo - 1) * 86_400_000).toISOString() : null,
              status === 'closed' ? new Date(Date.now() - (daysAgo - 1) * 86_400_000 + 7_200_000).toISOString() : null,
              resolved ? 3 + (i % 3) : null,
            ],
          );

          if (resolved) {
            // The resolution comment is what makes a ticket retrievable as an
            // answer by the widget's deflection search.
            await client.query(
              `INSERT INTO comment (id, product_id, ticket_id, author_type, author_ref, author_name, body, is_internal)
               VALUES ($1,$2,$3,'assignee',$4,$5,$6,false)`,
              [newId('cmt'), t.id, ticketId, assignee,
               USERS.find((u) => userIdByEmail.get(u.email) === assignee)?.name ?? 'Support',
               RESOLUTIONS[i % RESOLUTIONS.length]!],
            );
          }
        }
      }
    }

    await client.query('COMMIT');

    console.log('\nSeed complete.\n');
    console.log('  Tenants');
    for (const t of TENANTS) {
      console.log(
        `    ${t.name.padEnd(7)} ${t.ref_prefix.padEnd(5)} ${t.mechanism.padEnd(8)} publishable_key=${t.publishableKey}`,
      );
    }
    console.log('\n  Admin portal — http://localhost:4000/admin');
    console.log(`    admin@irisregtech.com          ${DEMO_PASSWORD}   super_admin   all tenants`);
    console.log(`    ops.manager@irisregtech.com    ${DEMO_PASSWORD}   manager       Carbon + ESG`);
    console.log(`    carbon.agent@irisregtech.com   ${DEMO_PASSWORD}   agent         Carbon only`);
    console.log(`    (also <tenant>.admin@ and <tenant>.agent@ for esg, ifile, ideal)\n`);
    console.log(`  ${TENANTS.length} tenants x 40 tickets, ${KB.length} KB articles each.\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nSeed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

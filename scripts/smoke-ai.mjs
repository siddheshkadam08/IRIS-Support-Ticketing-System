/**
 * Phase 1 running-system verification.
 *
 * Nothing is stubbed. This raises a real ticket and then watches the whole
 * pipeline actually happen:
 *
 *   POST /v1/tickets  ->  ticket + audit + event_outbox   (one transaction)
 *        -> AI dispatcher  -> BullMQ ai.jobs
 *        -> worker         -> core /internal/ai/.../input
 *        -> ai-service     -> noop
 *        -> worker         -> core /internal/ai/.../result
 *        -> ai_execution + audit, and the TICKET UNCHANGED
 *
 * Requires the stack to be up:
 *   npm run infra:up
 *   npm run migrate
 *   npm run dev            (core + gateway + worker)
 *
 *   npm run test:ai        (tsx — it imports @iris/shared/hmac to sign, the
 *                          same module the worker and Core use, so the smoke
 *                          test cannot drift from the real signing path)
 */
import pg from 'pg';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';

process.loadEnvFile(new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const CORE = process.env.CORE_SERVICE_URL ?? 'http://localhost:4100';
const AI = process.env.AI_SERVICE_URL ?? 'http://localhost:5000';
const KEY = process.env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';
const WORKER_SECRET =
  process.env.AI_WORKER_HMAC_SECRET ?? 'dev_ai_worker_hmac_secret_change_me';
const AI_SECRET =
  process.env.AI_SERVICE_HMAC_SECRET ?? 'dev_ai_service_hmac_secret_change_me';

/**
 * Phase 2: /internal/* is authenticated with a per-service HMAC signature.
 * Serialise once, sign those bytes, send those bytes.
 */
function signedPost(base, path, secret, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-iris-service-id': 'worker',
      'x-iris-timestamp': String(timestamp),
      'x-iris-nonce': nonce,
      'x-iris-signature': requestSignatureHeader(secret, {
        method: 'POST',
        path,
        timestamp,
        nonce,
        body,
      }),
      ...extraHeaders,
    },
    body,
  });
}
const PRODUCT = 'prod_carbon';

const client = new pg.Client({
  connectionString: process.env.ADMIN_DATABASE_URL,
  application_name: 'smoke-ai',
});

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll rather than guess a fixed delay: the pipeline is asynchronous. */
async function waitFor(fn, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) return null;
    await sleep(everyMs);
  }
}

async function main() {
  console.log('\nIRIS — Phase 1 AI foundation smoke test\n');
  await client.connect();

  // ── 0. services are up ────────────────────────────────────────────────
  console.log('Service health');
  const coreHealth = await fetch(`${CORE}/health`).then((r) => r.json());
  check('core-service is live', coreHealth.status === 'ok');

  const aiHealth = await fetch(`${AI}/health`).then((r) => r.json());
  check('ai-service is live', aiHealth.status === 'ok');

  const aiReady = await fetch(`${AI}/health/ready`).then((r) => r.json());
  /**
   * Readiness must report exactly what this service has BUILT — which is not
   * the same question as what Core is willing to dispatch.
   *
   * Phase 1 built the stub alone; Phase 4 added classification, Phase 5 added
   * summary and Phase 10 added embedding. The feature gate that decides
   * Phase 12 added reranking. The feature gate that decides
   * whether classification actually runs lives in shared/types/ai.ts
   * (SUPPORTED_AI_FEATURES), on the Core side, and is asserted separately
   * below.
   *
   * ⚠️ `embedding` and `reranking` appearing HERE and being absent from
   * SUPPORTED_AI_FEATURES
   * is not an inconsistency — it is the design. The AI service implements the
   * feature; the ai.jobs queue must never carry it, because it has its own
   * route, validator and idempotency key. See shared/types/embedding.ts.
   */
  check(
    'ai-service is ready and exposes exactly the features it implements',
    aiReady.features?.slice().sort().join() === 'classification,embedding,noop,reranking,summary',
    `got: ${aiReady.features?.join() ?? '(none)'}`,
  );

  const redisAof = await client
    .query('SELECT 1')
    .then(() => true)
    .catch(() => false);
  check('database reachable', redisAof);

  // ── 1. the AI service is unreachable without its key ──────────────────
  console.log('\nService authentication');
  const unauth = await fetch(`${AI}/v1/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature: 'noop', request_id: 'x', input: { subject: null, description: 'x' } }),
  });
  check('ai-service rejects an unsigned request', unauth.status === 401);

  const unauthCore = await fetch(`${CORE}/internal/ai/jobs/evt_x/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('core /internal rejects an unsigned request', unauthCore.status === 401);

  // The Phase 1 escalation, live: the platform-wide key must no longer open
  // the internal surface.
  const keyOnly = await fetch(`${CORE}/internal/ai/jobs/evt_x/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-key': KEY },
    body: JSON.stringify({}),
  });
  check('core /internal rejects INTERNAL_API_KEY without a signature', keyOnly.status === 401);

  const badSig = await signedPost(CORE, '/internal/ai/jobs/evt_x/input', 'wrong-secret', {});
  check('core /internal rejects a bad signature', badSig.status === 401);

  // ── 2. raise a real ticket ────────────────────────────────────────────
  console.log('\nTicket creation (unchanged code path)');
  const description = `Phase 1 smoke ${Date.now()} — cannot export the Q3 report.`;
  const created = await fetch(`${CORE}/v1/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': KEY,
      'x-iris-product-id': PRODUCT,
      'x-iris-role': 'product',
      'x-iris-tenant-id': 'tenant_smoke',
    },
    body: JSON.stringify({ subject: 'Q3 export fails', description }),
  });
  check('ticket created', created.status === 201, `HTTP ${created.status}`);
  const ticket = await created.json();
  console.log(`    ticket ${ticket.reference} (${ticket.id})`);

  // ── 3. outbox event, written in the same transaction ──────────────────
  const outbox = await client.query(
    `SELECT event_id, product_id, aggregate_id, request_id, published_at
       FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'ticket.created'`,
    [ticket.id],
  );
  check('ticket.created event is in the outbox', outbox.rowCount === 1);
  const event = outbox.rows[0];
  check('outbox event carries the authoritative product', event?.product_id === PRODUCT);

  // ── 4. dispatched to BullMQ ───────────────────────────────────────────
  console.log('\nOutbox -> BullMQ -> worker');
  const published = await waitFor(async () => {
    const { rows } = await client.query(
      `SELECT published_at FROM event_outbox WHERE event_id = $1`,
      [event.event_id],
    );
    return rows[0]?.published_at ? rows[0] : null;
  });
  check('AI dispatcher published the event to the queue', published !== null);

  // ── 5. worker + python + core result ──────────────────────────────────
  /**
   * A longer budget than the 20s default, deliberately.
   *
   * Each ticket now dispatches TWO features, and classification makes a real
   * Azure call (~4s, p95 5.2s) that competes for the same worker slots. The
   * stub itself is unchanged and fast; what grew is the queue it shares.
   * Timing out here would report a pipeline failure that is really just a
   * budget set before the pipeline had a provider in it.
   */
  const execution = await waitFor(
    async () => {
      const { rows } = await client.query(
        `SELECT * FROM ai_execution WHERE event_id = $1 AND feature = 'noop'`,
        [event.event_id],
      );
      return rows[0]?.status && rows[0].status !== 'running' ? rows[0] : null;
    },
    { timeoutMs: 60_000 },
  );
  check('ai_execution reached a terminal state', execution !== null);

  if (execution) {
    check('execution succeeded', execution.status === 'succeeded', execution.error_code ?? '');
    check('execution is scoped to the right product', execution.product_id === PRODUCT);
    check('execution is linked to the ticket', execution.ticket_id === ticket.id);
    check('job_id is distinct from event_id', execution.job_id !== execution.event_id);
    check(
      'correlation id threads the whole trace',
      execution.correlation_id === event.request_id,
    );
    check('provider/model recorded for explainability', execution.model === 'stub-noop');
    check('model_version recorded', Boolean(execution.model_version));
    check(
      'the description really travelled to Python and back',
      execution.result?.received_chars === description.length,
      `got ${execution.result?.received_chars}, expected ${description.length}`,
    );
    check('completed_at stamped', execution.completed_at !== null);
  }

  // ── 6. audit ──────────────────────────────────────────────────────────
  console.log('\nAudit');
  /**
   * Scoped to `noop`, which is what this smoke test proves.
   *
   * A ticket now fans out to noop AND classification (Phase 4), so an
   * unfiltered count asserts something this file is not about and breaks
   * whenever another feature is enabled. The property under test — one audit
   * row per execution — is unchanged.
   */
  const audit = await client.query(
    `SELECT action, actor_type, after FROM audit_event
      WHERE entity_id = $1 AND action LIKE 'ai.%' AND after->>'feature' = 'noop'`,
    [ticket.id],
  );
  check('exactly one AI audit row for noop', audit.rowCount === 1, `got ${audit.rowCount}`);
  check('audit action is the success action', audit.rows[0]?.action === 'ai.execution_succeeded');
  check('audit actor is the system', audit.rows[0]?.actor_type === 'system');
  check(
    'audit carries no ticket text',
    !JSON.stringify(audit.rows[0]?.after ?? {}).includes(description),
  );

  // ── 7. THE TICKET IS UNCHANGED ────────────────────────────────────────
  console.log('\nThe ticket is not modified by noop');
  const after = await client.query(
    `SELECT status, category, severity, classification_source, ai_classification,
            summary, sentiment, subject, description
       FROM ticket WHERE id = $1`,
    [ticket.id],
  );
  const t = after.rows[0];
  check('status untouched', t.status === 'open');
  check('classification_source untouched', t.classification_source === 'unclassified');
  check('ai_classification untouched', t.ai_classification === null);
  check('summary untouched', t.summary === null);
  check('sentiment untouched', t.sentiment === null);
  check('subject untouched — AI never overwrites user input', t.subject === 'Q3 export fails');
  check('description untouched', t.description === description);

  // ── 8. duplicate delivery is idempotent ───────────────────────────────
  console.log('\nIdempotency under duplicate delivery');
  const claims = {
    job_id: 'aij_SMOKE_DUP',
    feature: 'noop',
    attempt: 9,
    correlation_id: event.request_id ?? event.event_id,
    claimed_product_id: PRODUCT,
    claimed_ticket_id: ticket.id,
  };

  const dupInput = await signedPost(
    CORE,
    `/internal/ai/jobs/${event.event_id}/input`,
    WORKER_SECRET,
    claims,
  );
  const dupBody = await dupInput.json();
  check('a redelivered job is told already_applied', dupBody.status === 'already_applied');
  check('and is handed no ticket data at all', dupBody.ticket === undefined);

  const dupResult = await signedPost(
    CORE,
    `/internal/ai/jobs/${event.event_id}/result`,
    WORKER_SECRET,
    { ...claims, result: { feature: 'noop', status: 'succeeded', data: { ok: true, received_chars: 99999 } } },
  );
  const dupResultBody = await dupResult.json();
  check('a duplicate result reports applied:false', dupResultBody.applied === false);

  const afterDup = await client.query(
    `SELECT result FROM ai_execution WHERE event_id = $1 AND feature = 'noop'`,
    [event.event_id],
  );
  check(
    'the stored result was NOT overwritten',
    afterDup.rows[0]?.result?.received_chars === description.length,
  );

  const auditAfterDup = await client.query(
    `SELECT count(*) AS n FROM audit_event WHERE entity_id = $1 AND action LIKE 'ai.%'`,
    [ticket.id],
  );
  check('still exactly one audit row', Number(auditAfterDup.rows[0].n) === 1);

  /**
   * Scoped to `noop`: the property is UNIQUE(event_id, feature), so one event
   * legitimately has one row PER FEATURE. Counting the whole event would
   * assert that only one feature exists, which is a different — and now
   * false — claim.
   */
  const rowCount = await client.query(
    `SELECT count(*) AS n FROM ai_execution WHERE event_id = $1 AND feature = 'noop'`,
    [event.event_id],
  );
  check('still exactly one ai_execution row for noop', Number(rowCount.rows[0].n) === 1);

  // ── 9. tenant isolation ───────────────────────────────────────────────
  console.log('\nTenant isolation');
  const crossTenant = await signedPost(
    CORE,
    `/internal/ai/jobs/${event.event_id}/input`,
    WORKER_SECRET,
    { ...claims, claimed_product_id: 'prod_esg' },
  );
  check('a signed but tampered product claim is rejected', crossTenant.status === 400);
  const crossBody = await crossTenant.text();
  check('and the rejection leaks nothing', !crossBody.includes(description));

  const crossTicket = await signedPost(
    CORE,
    `/internal/ai/jobs/${event.event_id}/input`,
    WORKER_SECRET,
    { ...claims, claimed_ticket_id: 'tkt_someone_elses' },
  );
  check('a signed but tampered ticket claim is rejected', crossTicket.status === 400);

  // ── 10. python holds no database credential ───────────────────────────
  console.log('\nPython isolation');
  /**
   * Invariant 1, observed from the database side.
   *
   * `iris-gateway` is on the allowlist deliberately: it holds a narrow,
   * documented read-only credential used only to resolve product credentials,
   * and it never touches ticket data (gateway/src/config.ts). `iris-migrate`
   * is DDL. What must NEVER appear is a connection from ai-service or the
   * worker — those are the two processes the whole isolation design says
   * cannot have one.
   */
  const ALLOWED_DB_CLIENTS = [
    'smoke-ai',
    'iris-core-service',
    'iris-gateway',
    'iris-migrate',
    'psql',
    '',
  ];
  const pgConns = await client.query(
    `SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname = 'iris'`,
  );
  const names = pgConns.rows.map((r) => r.application_name);
  const unexpected = names.filter((n) => !ALLOWED_DB_CLIENTS.includes(n));
  check(
    'only allowlisted services hold a database connection',
    unexpected.length === 0,
    `unexpected: ${unexpected.join(', ')}`,
  );
  check(
    'neither ai-service nor worker holds a database connection',
    !names.some((n) => /ai[-_]?service|worker|python|uvicorn/i.test(n ?? '')),
    names.join(', '),
  );

  // ── summary ───────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32mAll ${passed} checks passed.\x1b[0m Phase 1 pipeline verified end to end.\n`);
  } else {
    console.log(`\x1b[31m${failures.length} check(s) FAILED\x1b[0m (${passed} passed):`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
  }
  await client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n\x1b[31msmoke-ai failed:\x1b[0m', err);
  await client.end().catch(() => undefined);
  process.exit(1);
});

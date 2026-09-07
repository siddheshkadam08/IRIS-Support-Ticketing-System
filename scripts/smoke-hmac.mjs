/**
 * Phase 2 — live security verification of the two HMAC boundaries.
 *
 * Unit tests prove the logic; this proves the RUNNING SYSTEM. It is a separate
 * script from smoke-ai.mjs because that one verifies the AI pipeline works and
 * this one verifies it cannot be abused — different questions, different
 * failure meanings.
 *
 * It signs with @iris/shared/hmac, the same module the worker and Core use, so
 * the check cannot drift from the real signing path.
 *
 * Requires the stack up:
 *   npm run infra:up && npm run dev
 *   npm run test:hmac
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { requestSignatureHeader } from '@iris/shared/hmac';

process.loadEnvFile(new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const CORE = process.env.CORE_SERVICE_URL ?? 'http://localhost:4100';
const AI = process.env.AI_SERVICE_URL ?? 'http://localhost:5000';
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';
const WORKER_SECRET = process.env.AI_WORKER_HMAC_SECRET ?? 'dev_ai_worker_hmac_secret_change_me';
const AI_SECRET = process.env.AI_SERVICE_HMAC_SECRET ?? 'dev_ai_service_hmac_secret_change_me';

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Fixed timestamp/nonce so a caller can deliberately replay them. */
function headers(secret, method, path, body, ts = Math.floor(Date.now() / 1000), nonce = randomUUID()) {
  return {
    'content-type': 'application/json',
    'x-iris-service-id': 'worker',
    'x-iris-timestamp': String(ts),
    'x-iris-nonce': nonce,
    'x-iris-signature': requestSignatureHeader(secret, { method, path, timestamp: ts, nonce, body }),
  };
}

const INTERNAL_PATH = '/internal/ai/jobs/evt_probe_nonexistent/input';
const INTERNAL_BODY = JSON.stringify({
  job_id: 'aij_probe',
  feature: 'noop',
  attempt: 1,
  correlation_id: 'req_probe',
  claimed_product_id: 'prod_carbon',
  claimed_ticket_id: 'tkt_probe',
});
const AI_BODY = JSON.stringify({
  feature: 'noop',
  request_id: 'req_probe',
  input: { subject: null, description: 'live security probe' },
});

const postCore = (h, body = INTERNAL_BODY, path = INTERNAL_PATH) =>
  fetch(`${CORE}${path}`, { method: 'POST', headers: h, body });
const postAI = (h, body = AI_BODY) =>
  fetch(`${AI}/v1/execute`, { method: 'POST', headers: h, body });

async function main() {
  console.log('\nPhase 2 — live HMAC security verification\n');

  console.log('Authentication succeeds where it should');
  // 404 means the signature was ACCEPTED and Phase 1 logic ran: the event id
  // is deliberately nonexistent. A 401 would mean auth failed.
  let r = await postCore(headers(WORKER_SECRET, 'POST', INTERNAL_PATH, INTERNAL_BODY));
  check('worker signature authenticates to Core', r.status === 404, `HTTP ${r.status}`);

  r = await postAI(headers(AI_SECRET, 'POST', '/v1/execute', AI_BODY));
  check('worker signature authenticates to Python', r.status === 200, `HTTP ${r.status}`);

  console.log('\nThe worker credential is confined to /internal/ai/*');
  r = await fetch(`${CORE}/v1/tickets?limit=2`, {
    method: 'GET',
    headers: {
      ...headers(WORKER_SECRET, 'GET', '/v1/tickets?limit=2', ''),
      'x-iris-product-id': 'prod_ifile',
      'x-iris-role': 'product',
    },
  });
  check('cannot read /v1/tickets with a forged product header', r.status === 401, `HTTP ${r.status}`);

  r = await fetch(`${CORE}/admin/api/tenants`, {
    method: 'GET',
    headers: {
      ...headers(WORKER_SECRET, 'GET', '/admin/api/tenants', ''),
      'x-iris-support-user-id': 'su_forged',
      'x-iris-role': 'super_admin',
    },
  });
  check('cannot reach /admin/api/tenants as a forged super_admin', r.status === 401, `HTTP ${r.status}`);

  console.log('\nThe Phase 1 hole is closed');
  r = await postCore({ 'content-type': 'application/json' });
  check('unsigned /internal is 401', r.status === 401, `HTTP ${r.status}`);

  r = await postCore({ 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY });
  check('/internal with only INTERNAL_API_KEY is 401', r.status === 401, `HTTP ${r.status}`);

  console.log('\nIntegrity and replay');
  r = await postCore(
    headers(WORKER_SECRET, 'POST', INTERNAL_PATH, INTERNAL_BODY),
    INTERNAL_BODY.replace('noop', 'summ'),
  );
  check('Core rejects a tampered body', r.status === 401, `HTTP ${r.status}`);

  r = await postAI(
    headers(AI_SECRET, 'POST', '/v1/execute', AI_BODY),
    AI_BODY.replace('live security probe', 'LIVE security probe'),
  );
  check('Python rejects a tampered body', r.status === 401, `HTTP ${r.status}`);

  r = await postCore(
    headers(WORKER_SECRET, 'POST', INTERNAL_PATH, INTERNAL_BODY, Math.floor(Date.now() / 1000) - 400),
  );
  check('Core rejects a stale timestamp', r.status === 401, `HTTP ${r.status}`);

  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const fixed = headers(WORKER_SECRET, 'POST', INTERNAL_PATH, INTERNAL_BODY, ts, nonce);
  const first = await postCore(fixed);
  const replay = await postCore(fixed);
  check('a nonce is accepted once', first.status === 404, `HTTP ${first.status}`);
  check('and the byte-identical replay is rejected', replay.status === 401, `HTTP ${replay.status}`);
  check('with code nonce_replayed', (await replay.json()).error?.code === 'nonce_replayed');

  console.log('\nPython is stateless, by design');
  const ats = Math.floor(Date.now() / 1000);
  const anonce = randomUUID();
  const aiFixed = headers(AI_SECRET, 'POST', '/v1/execute', AI_BODY, ats, anonce);
  const a1 = await postAI(aiFixed);
  const a2 = await postAI(aiFixed);
  // Deliberate: /v1/execute is a pure function, so a replay recomputes an
  // answer it already gave. A nonce cache here would break horizontal scaling
  // to prevent nothing. Core owns replay protection.
  check('the same nonce is accepted twice', a1.status === 200 && a2.status === 200, `${a1.status}/${a2.status}`);

  console.log('\nKey separation');
  r = await postAI(headers(WORKER_SECRET, 'POST', '/v1/execute', AI_BODY));
  check('the Core secret does NOT work against Python', r.status === 401, `HTTP ${r.status}`);

  r = await postCore(headers(AI_SECRET, 'POST', INTERNAL_PATH, INTERNAL_BODY));
  check('the Python secret does NOT work against Core', r.status === 401, `HTTP ${r.status}`);

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32mAll ${passed} live security checks passed.\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m${failures.length} check(s) FAILED\x1b[0m (${passed} passed):`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31msmoke-hmac failed:\x1b[0m', err);
  process.exit(1);
});

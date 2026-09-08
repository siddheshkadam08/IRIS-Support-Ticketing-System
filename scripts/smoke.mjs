/**
 * End-to-end smoke test through the gateway, against real Postgres.
 * Exercises the exact paths the widget uses, plus the negative security cases.
 *
 *   node scripts/smoke.mjs
 */
const GW = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const CARBON = 'pub_live_carbon_8f2a';
const IFILE = 'pub_live_ifile_3c7b';

const SMOKE_SUB = 'usr_smoke_' + Date.now().toString(36);

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', key = CARBON, token, body, origin } = {}) {
  const headers = { 'X-IRIS-Publishable-Key': key };
  if (token) headers['X-IRIS-Identity'] = token;
  if (origin) headers.Origin = origin;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GW}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

console.log('\nIRIS widget — end-to-end smoke test\n');

// ── infrastructure ──────────────────────────────────────────────────────
console.log('Infrastructure');
{
  const health = await fetch(`${GW}/health`).then((r) => r.json());
  ok('gateway /health', health.status === 'ok');

  const widget = await fetch(`${GW}/widget.js`);
  ok('gateway serves widget.js', widget.ok, `status ${widget.status}`);
  const js = await widget.text();
  ok('widget.js is the loader bundle', js.includes('iris-support'), `${js.length} bytes`);
}

// ── identity ────────────────────────────────────────────────────────────
console.log('\nIdentity (SSO handoff)');
let token = null;
{
  const res = await fetch(`${GW}/dev/identity-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishable_key: CARBON,
      // Unique per run: the /v1/widget/ask rate-limit bucket is keyed on
      // (product, sub), and the flood test at the end exhausts it. A fixed sub
      // would make a second run within the minute fail on 429s.
      sub: SMOKE_SUB,
      product_tenant_id: 'acme-corp',
      name: 'Siddhesh',
      email: 'siddhesh@acme.example',
    }),
  });
  const data = await res.json();
  token = data.identity_token;
  ok('dev endpoint mints an identity JWT', Boolean(token));

  const cfg = await call('/v1/widget/config', { token });
  ok('config resolves the signed-in user', cfg.json?.identity?.authenticated === true);
  ok('config carries the name from the token', cfg.json?.identity?.name === 'Siddhesh');
  ok('config exposes the brand footer', cfg.json?.footer === 'Powered by Elevate - X.');
  ok('config lists all 8 capabilities', cfg.json?.capabilities?.length === 8,
     `got ${cfg.json?.capabilities?.length}`);
  ok('config carries product categories', (cfg.json?.categories?.length ?? 0) > 0);
}

// ── branding is per-product, from server config ──────────────────────────
console.log('\nMulti-product branding (one widget, many products)');
{
  const carbon = await call('/v1/widget/config');
  const edu = await call('/v1/widget/config', { key: IFILE });
  ok('Carbon and iFile return different titles',
     carbon.json?.branding?.title !== edu.json?.branding?.title,
     `${carbon.json?.branding?.title} vs ${edu.json?.branding?.title}`);
  ok('…different primary colours',
     carbon.json?.branding?.primary_color !== edu.json?.branding?.primary_color);
  // Categories are deliberately IDENTICAL across tenants — a generic set, so
  // no invented domain content ships. Branding is what differs, and that is
  // what proves one bundle serves many products.
  ok('…share the generic category set by design',
     JSON.stringify(carbon.json?.categories) === JSON.stringify(edu.json?.categories),
     `${carbon.json?.categories?.length} categories each`);
}

// ── deflection ──────────────────────────────────────────────────────────
console.log('\nAsk a Question (deflection)');
let conversationId = null;
{
  const res = await call('/v1/widget/ask', {
    method: 'POST',
    token,
    body: { question: 'How do I reset my password?' },
  });
  ok('POST /v1/widget/ask returns 200', res.status === 200, `status ${res.status}`);
  ok('returns a conversation id', Boolean(res.json?.conversation_id));
  ok('finds real answers from the knowledge base', (res.json?.answers?.length ?? 0) > 0,
     `${res.json?.answers?.length ?? 0} answers`);
  ok('top answer is the password reset article',
     /password/i.test(res.json?.answers?.[0]?.title ?? ''),
     res.json?.answers?.[0]?.title);
  ok('suggests answering rather than filing', res.json?.suggested_action === 'answer');
  ok('creates NO ticket (deflection ≠ auto-resolution)', res.json?.ticket_id === undefined);
  conversationId = res.json?.conversation_id;

  const weak = await call('/v1/widget/ask', {
    method: 'POST',
    token,
    body: { question: 'zzzz qqqq unmatchable gibberish xyzzy' },
  });
  ok('a no-match question routes to ticket creation',
     weak.json?.suggested_action === 'create_ticket', weak.json?.suggested_action);
}

// ── knowledge base ──────────────────────────────────────────────────────
console.log('\nSearch Docs');
{
  const list = await call('/v1/kb/articles', { token });
  ok('lists articles', (list.json?.data?.length ?? 0) > 0, `${list.json?.data?.length} articles`);

  const search = await call('/v1/kb/articles?q=export%20failing', { token });
  ok('search ranks the export article first',
     /export/i.test(search.json?.data?.[0]?.title ?? ''), search.json?.data?.[0]?.title);

  const id = search.json?.data?.[0]?.id;
  const article = await call(`/v1/kb/articles/${id}`, { token });
  ok('opens a single article with a body', Boolean(article.json?.body));

  const vote = await call(`/v1/kb/articles/${id}/helpful`, {
    method: 'POST', token, body: { helpful: true },
  });
  ok('records a helpful vote', vote.json?.ok === true);
}

// ── ticket lifecycle ────────────────────────────────────────────────────
console.log('\nCreate a Ticket / My Tickets');
let ticketId = null;
{
  const created = await call('/v1/tickets', {
    method: 'POST',
    token,
    body: {
      product_tenant_id: 'acme-corp',
      subject: 'Smoke test — export fails',
      description: 'The Q3 emissions export returns a 500 when I click download.',
      category: 'reports',
      severity: 'high',
      conversation_id: conversationId,
    },
  });
  ok('POST /v1/tickets returns 201', created.status === 201, `status ${created.status}`);
  ok('returns a per-product reference', /^CARB-\d+$/.test(created.json?.reference ?? ''),
     created.json?.reference);
  ok('starts in status open', created.json?.status === 'open');
  ok('records the SSO identity', created.json?.identity_assurance === 'sso');
  ok('carries the raiser name from the token', created.json?.raised_by?.name === 'Siddhesh');
  ticketId = created.json?.id;

  const mine = await call('/v1/tickets', { token });
  ok('My Tickets lists the new ticket',
     mine.json?.data?.some((t) => t.id === ticketId));
  ok('My Tickets returns ONLY this raiser’s tickets',
     mine.json?.data?.every((t) => t.raised_by?.ref === SMOKE_SUB),
     `${mine.json?.data?.length} rows`);

  const comment = await call(`/v1/tickets/${ticketId}/comments`, {
    method: 'POST', token, body: { body: 'Adding the request id: req_abc123.' },
  });
  ok('adds a comment', comment.status === 201);

  const detail = await call(`/v1/tickets/${ticketId}`, { token });
  ok('ticket detail includes the comment', (detail.json?.comments?.length ?? 0) > 0);
}

// ── Live Chat stub (ADR-011) ────────────────────────────────────────────
console.log('\nLive Chat (stubbed as ticket conversion — ADR-011)');
{
  const res = await call('/v1/tickets', {
    method: 'POST', token,
    body: {
      product_tenant_id: 'acme-corp',
      description: 'I would like to talk to an agent.',
      conversation_id: conversationId,
      from_live_chat: true,
    },
  });
  ok('converts the conversation into a ticket', res.status === 201);
  ok('folds the transcript into the description',
     /Conversation before requesting an agent/.test(res.json?.description ?? ''));
}

// ── security ────────────────────────────────────────────────────────────
console.log('\nSecurity (negative tests)');
{
  const cross = await call(`/v1/tickets/${ticketId}`, { key: IFILE, token });
  ok('iFile key cannot read a Carbon ticket → 404 not 403',
     cross.status === 404, `got ${cross.status} ${cross.json?.error?.code}`);
  ok('…and the code does not confirm existence',
     cross.json?.error?.code === 'ticket_not_found', cross.json?.error?.code);

  const other = await fetch(`${GW}/v1/tickets`, {
    headers: {
      'X-IRIS-Publishable-Key': CARBON,
      'X-IRIS-Identity': (
        await fetch(`${GW}/dev/identity-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publishable_key: CARBON, sub: 'usr_other_person', product_tenant_id: 'acme-corp' }),
        }).then((r) => r.json())
      ).identity_token,
    },
  }).then((r) => r.json());
  ok('a different user cannot see the first user’s tickets',
     !other.data?.some((t) => t.id === ticketId), `${other.data?.length ?? 0} rows`);

  const scope = await call('/v1/tickets/' + ticketId + '/status', {
    method: 'PATCH', token, body: { status: 'resolved' },
  });
  ok('a raiser cannot mark their own ticket resolved',
     scope.status === 403, `got ${scope.status} ${scope.json?.error?.code}`);

  const noCred = await fetch(`${GW}/v1/tickets`).then((r) => r.status);
  ok('no credential → 401', noCred === 401, `got ${noCred}`);

  const badKey = await call('/v1/tickets', { key: 'pub_live_not_real' });
  ok('unknown publishable key → 401', badKey.status === 401, `got ${badKey.status}`);

  const internal = await fetch('http://localhost:4100/v1/tickets').then((r) => r.status);
  ok('core-service rejects direct calls without the internal key',
     internal === 401, `got ${internal}`);
}

// ── rate limiting ───────────────────────────────────────────────────────
console.log('\nRate limiting');
{
  const res = await call('/v1/kb/articles', { token });
  ok('responses carry rate-limit headers',
     res.headers.get('x-ratelimit-limit') !== null,
     `limit=${res.headers.get('x-ratelimit-limit')} remaining=${res.headers.get('x-ratelimit-remaining')}`);

  let limited = false;
  for (let i = 0; i < 14; i++) {
    const r = await call('/v1/widget/ask', { method: 'POST', token, body: { question: `flood ${i}` } });
    if (r.status === 429) { limited = true; break; }
  }
  ok('the /v1/widget/ask bucket throttles (10/min)', limited);
}

await cleanup();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Remove the tickets this run created.
 *
 * WHY THIS EXISTS. This suite raises REAL tickets through the real route.
 * Without cleanup they accumulate run after run - and because Phase 10 embeds
 * every resolved ticket, they end up in the SIMILAR-TICKETS corpus. By the time
 * Phase 14 audited it, 30 of prod_carbon's 43 historical tickets were smoke
 * artifacts, each having also consumed a real embedding call.
 *
 * They are indistinguishable from production tickets to every query in the
 * platform, which is exactly why the suite has to clean up after itself rather
 * than every consumer learning to ignore them. Same lesson as the Phase 5 queue
 * debris, and the same fix: delete what you made.
 *
 * Scoped to THIS run's SMOKE_SUB, so a concurrent run is untouched.
 *
 * RLS applies here too: connecting as `iris_app` with no scope GUCs makes every
 * row invisible and the DELETE matches nothing, silently. SET LOCAL inside a
 * transaction, mirroring withSystemScope().
 */
async function cleanup() {
  const env = await readEnvFile();
  const url = process.env.CORE_DATABASE_URL ?? env.CORE_DATABASE_URL;
  if (!url) {
    console.warn('  [smoke-cleanup] no CORE_DATABASE_URL - skipping');
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    console.warn('  [smoke-cleanup] pg unavailable - skipping');
    return;
  }
  const client = new pg.Client({ connectionString: url, application_name: 'iris-smoke-cleanup' });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.role','super_admin',true),
              set_config('app.product_scope','',true),
              set_config('app.request_id','smoke-cleanup',true)`,
    );
    // comment and attachment rows cascade from ticket.
    const r = await client.query(`DELETE FROM ticket WHERE raised_by_ref = $1`, [SMOKE_SUB]);
    await client.query('COMMIT');
    console.log(`  [smoke-cleanup] removed ${r.rowCount ?? 0} ticket(s) created by this run`);
  } catch (err) {
    // Cleanup must never fail a run that otherwise passed - but it IS reported,
    // because silent cleanup is how the debris accumulated in the first place.
    console.warn('  [smoke-cleanup] failed:', err instanceof Error ? err.message : err);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Minimal .env reader - this script otherwise needs no configuration.
 *
 * `await import`, not `require`: this is an ES module, so `require` is not
 * defined and the call threw straight into the catch below - which reported
 * "no CORE_DATABASE_URL" and skipped cleanup silently. Exactly the failure
 * mode the Phase 5 teardown warned about, so the catch now says which.
 */
async function readEnvFile() {
  try {
    const fs = await import('node:fs');
    return Object.fromEntries(
      fs
        .readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } catch (err) {
    console.warn('  [smoke-cleanup] could not read .env:', err instanceof Error ? err.message : err);
    return {};
  }
}

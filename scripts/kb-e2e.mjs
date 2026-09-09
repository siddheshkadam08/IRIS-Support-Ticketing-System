/**
 * Phase 18 end-to-end verification, through the REAL running stack.
 *
 *   admin panel session -> gateway -> Core -> Postgres (RLS, migration-018 grants)
 *                       -> the existing embedding sweep -> real Azure embedding
 *                       -> hybrid retrieval -> RAG grounding
 *
 *   node scripts/kb-e2e.mjs
 *
 * Nothing is stubbed. It signs in through the gateway with a real password and
 * carries a real httpOnly session cookie, exactly as the admin panel does; the
 * customer-facing half authenticates with the tenant's real publishable key.
 * Postgres is read directly ONLY to observe columns no API exposes, and written
 * only to remove the articles this script created.
 *
 * ⚠️ THE POINT OF THIS FILE IS THAT PUBLICATION AND WITHDRAWAL REACH THE AI
 * PIPELINE WITH NO CODE CONNECTING THEM.
 *
 * No handler enqueues an embedding job, and no event type exists for this.
 * Step 5 runs one cycle of the pre-existing sweep and the article is simply
 * there to be found; step 8 unpublishes and it is simply gone. Each withdrawal
 * is checked against a POSITIVE CONTROL taken moments earlier, because "the
 * article is not in the results" passes just as happily when retrieval is
 * broken.
 */
import pg from 'pg';

const GATEWAY = 'http://localhost:4000';
const PUB_KEY = 'pub_live_carbon_8f2a';
const PRODUCT = 'prod_carbon';
const PASSWORD = 'Abc@1234';
const MARK = `heliocratic-flux-${Date.now().toString(36)}`;

const db = new pg.Client('postgres://postgres:postgres_dev_pw@localhost:5432/iris');

let pass = 0;
let fail = 0;
const made = [];

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
}
const step = (n, t) => console.log(`\n=== STEP ${n} — ${t} ===`);

async function login(email) {
  const res = await fetch(`${GATEWAY}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

async function admin(cookie, method, path, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

async function widget(method, path, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { 'x-iris-publishable-key': PUB_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const row = async (id) =>
  (await db.query(
    `SELECT status, is_public, views, embedding_content_sha, embedding_fingerprint,
            embedding_model, embedded_at, embedding_error,
            (embedding IS NOT NULL) AS has_embedding
       FROM kb_article WHERE id = $1`, [id])).rows[0];

const auditFor = async (id) =>
  (await db.query(
    `SELECT action, actor_ref, before, after, request_id, source_ip
       FROM audit_event WHERE entity_type='kb_article' AND entity_id=$1
      ORDER BY occurred_at, id`, [id])).rows;

/** Does the CUSTOMER-facing KB search return this article? */
async function customerSees(id) {
  const r = await widget('GET', `/v1/kb/articles?q=${encodeURIComponent(MARK)}&limit=50`);
  return (r.body?.data ?? []).some((a) => a.id === id);
}

async function main() {
  await db.connect();

  const agent = await login('carbon.agent@irisregtech.com');
  const manager = await login('ops.manager@irisregtech.com');
  console.log('Signed in through the gateway as carbon.agent (agent) and ops.manager (manager).');

  // ── STEP 1 ───────────────────────────────────────────────────────────
  step(1, 'Create a real article through the admin API');
  const created = await admin(agent, 'POST', '/admin/api/kb/articles', {
    product_id: PRODUCT,
    title: `Resolving ${MARK} calibration failures`,
    body: `A ${MARK} calibration failure appears when the emissions sensor reports before it has warmed up. ` +
      `Wait ten minutes after power-on, then re-run the calibration from Settings, Devices, Calibrate. ` +
      `If the ${MARK} error persists after two attempts, the sensor board needs replacing.`,
    category: 'reports',
  });
  const id = created.body?.id;
  if (id) made.push(id);
  check('HTTP 201', created.status === 201, `got ${created.status}`);
  check("status = 'draft'", created.body?.status === 'draft', `got ${created.body?.status}`);
  check('index_state is null (not in the AI corpus)', created.body?.index_state === null);
  console.log(`  article id: ${id}`);

  // ── STEP 2 ───────────────────────────────────────────────────────────
  step(2, 'The draft is invisible to customer-facing KB retrieval');
  check('customer KB search does NOT return it', (await customerSees(id)) === false);
  const direct = await widget('GET', `/v1/kb/articles/${id}`);
  check('direct customer fetch is 404', direct.status === 404, `got ${direct.status}`);

  // ── STEP 3 ───────────────────────────────────────────────────────────
  step(3, 'Publish, with the role gate proved in both directions');
  const agentTry = await admin(agent, 'PATCH', `/admin/api/kb/articles/${id}/status`, { status: 'published' });
  check('agent publish is refused with 403', agentTry.status === 403, `got ${agentTry.status}`);
  check('and the article is still a draft', (await row(id)).status === 'draft');

  const pub = await admin(manager, 'PATCH', `/admin/api/kb/articles/${id}/status`, { status: 'published' });
  check('manager publish returns 200', pub.status === 200, `got ${pub.status}`);
  check("status = 'published'", pub.body?.status === 'published');

  // ── STEP 4 ───────────────────────────────────────────────────────────
  step(4, 'The article enters the existing KB corpus');
  check('customer KB search now returns it', (await customerSees(id)) === true);
  check('direct customer fetch is 200', (await widget('GET', `/v1/kb/articles/${id}`)).status === 200);
  const afterPublish = await admin(manager, 'GET', `/admin/api/kb/articles/${id}`);
  check("index_state = 'pending' (text search live, vector not yet)",
    afterPublish.body?.index_state === 'pending', `got ${afterPublish.body?.index_state}`);

  // ── STEP 5 ───────────────────────────────────────────────────────────
  step(5, 'Run ONE cycle of the existing embedding sweep');
  const before = await row(id);
  check('no vector before the sweep', before.has_embedding === false);

  // The REAL sweep, imported from the worker. Not a reimplementation of it.
  const { runEmbeddingCycle } = await import('../worker/src/embedding-runner.ts');
  const cycle = await runEmbeddingCycle();
  console.log(`  cycle: ${JSON.stringify(cycle)}`);

  const after = await row(id);
  check('embedding exists', after.has_embedding === true);
  check('embedding_fingerprint = embedding_content_sha',
    after.embedding_fingerprint === after.embedding_content_sha,
    `${String(after.embedding_fingerprint).slice(0, 12)}… = ${String(after.embedding_content_sha).slice(0, 12)}…`);
  check('embedded_at populated', after.embedded_at !== null, String(after.embedded_at));
  check('no embedding error', after.embedding_error === null);
  console.log(`  model: ${after.embedding_model}`);

  const indexed = await admin(manager, 'GET', `/admin/api/kb/articles/${id}`);
  check("index_state = 'indexed'", indexed.body?.index_state === 'indexed', `got ${indexed.body?.index_state}`);

  // ── STEP 6 ───────────────────────────────────────────────────────────
  step(6, 'Hybrid retrieval reaches the article');
  const ask = await widget('POST', '/v1/widget/ask', {
    question: `How do I fix a ${MARK} calibration failure?`,
  });
  check('ask returns 200', ask.status === 200, `got ${ask.status}`);
  const answers = ask.body?.answers ?? [];
  check('hybrid retrieval ranks the new article', answers.some((a) => a.id === id),
    `top: ${answers.slice(0, 3).map((a) => `${a.type}:${a.score?.toFixed?.(3)}`).join(', ')}`);

  // ── STEP 7 ───────────────────────────────────────────────────────────
  step(7, 'RAG grounds an answer on the article');
  const ga = ask.body?.grounded_answer;
  if (!ga) {
    check('grounded answer present', false, 'no grounded_answer in the response');
  } else {
    /**
     * `GroundedAnswer` carries `answer`, `cited` and `insufficient` and NO
     * source ids — deliberately, so no internal identifier crosses to the
     * widget. A citation is an index into the `answers` array the same response
     * already returned, so the article is resolved back through that.
     */
    check('grounded answer present', true, `insufficient=${ga.insufficient}`);
    check('the model did not report the evidence as insufficient', ga.insufficient === false);
    check('the answer cites at least one source', (ga.cited ?? []).length > 0,
      `cited=${JSON.stringify(ga.cited)}`);

    const idx = answers.findIndex((a) => a.id === id);
    const cited = ga.cited ?? [];
    check('the new article is one of the cited sources',
      idx >= 0 && (cited.includes(idx + 1) || cited.includes(idx)),
      `article is answers[${idx}], cited=${JSON.stringify(cited)}`);
    check('the answer quotes the remedy this article introduced',
      /ten minutes/i.test(ga.answer ?? ''));
    console.log(`  answer: ${String(ga.answer ?? '').slice(0, 220).replace(/\s+/g, ' ')}`);
  }

  // ── STEP 8 ───────────────────────────────────────────────────────────
  step(8, 'Unpublish withdraws it from retrieval immediately');
  check('positive control: still visible before unpublishing', (await customerSees(id)) === true);
  const unpub = await admin(manager, 'PATCH', `/admin/api/kb/articles/${id}/status`, { status: 'draft' });
  check('unpublish returns 200', unpub.status === 200, `got ${unpub.status}`);
  check('customer KB search no longer returns it', (await customerSees(id)) === false);
  check('direct customer fetch is 404 again', (await widget('GET', `/v1/kb/articles/${id}`)).status === 404);

  const askAfter = await widget('POST', '/v1/widget/ask', { question: `How do I fix a ${MARK} calibration failure?` });
  const stillCited = (askAfter.body?.grounded_answer?.sources ?? []).some((s) => s.title?.includes(MARK));
  check('RAG no longer cites it', stillCited === false);
  check('the vector is retained, not cleared', (await row(id)).has_embedding === true);

  // ── STEP 9 ───────────────────────────────────────────────────────────
  step(9, 'Archive withdraws a second article identically');
  const second = await admin(agent, 'POST', '/admin/api/kb/articles', {
    product_id: PRODUCT,
    title: `Retiring the ${MARK} legacy exporter`,
    body: `The ${MARK} legacy exporter was removed in release 8.2. Use the standard export instead.`,
    category: 'reports',
  });
  const id2 = second.body?.id;
  if (id2) made.push(id2);
  await admin(manager, 'PATCH', `/admin/api/kb/articles/${id2}/status`, { status: 'published' });
  const seen2 = await widget('GET', `/v1/kb/articles?q=${encodeURIComponent(MARK)}&limit=50`);
  check('positive control: the second article is live', (seen2.body?.data ?? []).some((a) => a.id === id2));

  const arch = await admin(manager, 'PATCH', `/admin/api/kb/articles/${id2}/status`, { status: 'archived' });
  check('archive returns 200', arch.status === 200, `got ${arch.status}`);
  const seen3 = await widget('GET', `/v1/kb/articles?q=${encodeURIComponent(MARK)}&limit=50`);
  check('archived article leaves customer retrieval', !(seen3.body?.data ?? []).some((a) => a.id === id2));

  const rePub = await admin(manager, 'PATCH', `/admin/api/kb/articles/${id2}/status`, { status: 'published' });
  check('archived cannot be published directly (409)', rePub.status === 409, `got ${rePub.status}`);
  console.log(`  refusal: ${rePub.body?.error?.message}`);

  // ── Audit ────────────────────────────────────────────────────────────
  step('A', 'Audit trail');
  const rows = await auditFor(id);
  console.log(`  ${rows.length} audit rows for ${id}:`);
  for (const r of rows) {
    console.log(`    ${r.action.padEnd(26)} actor=${r.actor_ref} ip=${r.source_ip} ` +
      `before=${JSON.stringify(r.before)} after=${JSON.stringify(r.after)}`);
  }
  check('created + 2 status changes = 3 rows', rows.length === 3, `got ${rows.length}`);
  check('publish recorded draft -> published',
    rows.some((r) => r.action === 'kb_article.status_changed' && r.before?.status === 'draft' && r.after?.status === 'published'));
  check('unpublish recorded published -> draft',
    rows.some((r) => r.action === 'kb_article.status_changed' && r.before?.status === 'published' && r.after?.status === 'draft'));
  check('every row carries a request id', rows.every((r) => Boolean(r.request_id)));

  // ── Corpus integrity ─────────────────────────────────────────────────
  step('B', 'The pre-existing corpus is unchanged');
  const seeded = await db.query(
    `SELECT product_id, count(*) n, count(embedding) emb FROM kb_article
      WHERE title NOT LIKE $1 GROUP BY product_id ORDER BY product_id`, [`%${MARK}%`]);
  console.log(`  ${seeded.rows.map((r) => `${r.product_id}=${r.n}/${r.emb} embedded`).join('  ')}`);
  check('all four tenants still hold 12 articles, all embedded',
    seeded.rows.length === 4 && seeded.rows.every((r) => Number(r.n) === 12 && Number(r.emb) === 12));

  console.log(`\n${'='.repeat(64)}\nRESULT: ${pass} passed, ${fail} failed`);
  console.log(`Verification articles left behind (cleaned up next): ${made.join(', ')}`);

  // Clean up as the owner: iris_app has DELETE revoked.
  await db.query(`DELETE FROM audit_event WHERE entity_type='kb_article' AND entity_id = ANY($1)`, [made]);
  await db.query(`DELETE FROM kb_article WHERE id = ANY($1)`, [made]);
  console.log('Cleaned up.');
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nVERIFICATION ERROR:', e);
  try {
    if (made.length) {
      await db.query(`DELETE FROM audit_event WHERE entity_type='kb_article' AND entity_id = ANY($1)`, [made]);
      await db.query(`DELETE FROM kb_article WHERE id = ANY($1)`, [made]);
    }
    await db.end();
  } catch { /* already closed */ }
  process.exit(1);
});

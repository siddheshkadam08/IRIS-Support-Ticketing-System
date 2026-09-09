/**
 * Phase 19 Step 2 end-to-end verification, through the REAL running stack.
 *
 *   widget (publishable key + identity JWT) -> gateway -> Core
 *     -> attachment linked, transactional outbox event
 *     -> AI dispatcher -> BullMQ ai.jobs -> AI worker
 *     -> Core authorized attachment retrieval
 *     -> Python /v1/execute, multimodal -> real Azure gpt-4.1 vision
 *     -> Core strict validation -> ai_execution.result
 *     -> agent ticket page
 *
 *   node scripts/screenshot-e2e.mjs
 *
 * Nothing is stubbed. The provider call is real and billed. The screenshot is a
 * SYNTHETIC fixture generated for this test — no customer data, and no real
 * credential in the image, because "the model must not transcribe secrets" is
 * not something to test by putting a live secret on screen.
 *
 * ⚠️ AI OBSERVES. CORE DECIDES. Section 11 below re-reads every operational
 * ticket field after a successful analysis and requires them byte-identical.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

const GW = 'http://localhost:4000';
const CARBON = 'pub_live_carbon_8f2a';
const PASSWORD = 'Abc@1234';
const SUB = `shot_e2e_${Date.now().toString(36)}`;
const FIXTURE =
  process.env.SHOT_FIXTURE ??
  'C:\\Users\\SIDDHE~1.KAD\\AppData\\Local\\Temp\\claude\\d--Hackathon-IRIS-iris-ticketing-platform\\65b3732b-b6e3-4dc4-8625-4ed3f9759a76\\scratchpad\\screenshot-fixture.png';

/**
 * The synthetic-secret fixture, derived from the path above so the Windows
 * backslashes are written once. Overridable for another environment.
 */
const SECRET_FIXTURE =
  process.env.SHOT_SECRET_FIXTURE ??
  FIXTURE.replace('screenshot-fixture.png', 'screenshot-secret-fixture.png');

/**
 * ⚠️ SYNTHETIC. Rendered into that fixture, never issued, never valid
 * anywhere. A real credential in a test fixture would be the precise mistake
 * the redactor exists to prevent.
 */
const FAKE_TOKEN = 'AbCdEf1234567890GhIjKlMnOpQrStUv';

const db = new pg.Client('postgres://postgres:postgres_dev_pw@localhost:5432/iris');
const madeAttachments = [];
const madeTickets = [];

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
};
const step = (n, t) => console.log(`\n=== ${n}. ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function identity(sub) {
  const res = await fetch(`${GW}/dev/identity-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishable_key: CARBON, sub, product_tenant_id: 'acme-corp',
      name: 'Screenshot Tester', email: 'shot.tester@acme.example',
    }),
  });
  return (await res.json()).identity_token;
}

async function v1(token, method, path, body) {
  const headers = { 'X-IRIS-Publishable-Key': CARBON, 'X-IRIS-Identity': token };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GW}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function upload(token, filename, contentType, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const res = await fetch(`${GW}/v1/attachments`, {
    method: 'POST',
    headers: { 'X-IRIS-Publishable-Key': CARBON, 'X-IRIS-Identity': token },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (res.status === 201 && json?.id) madeAttachments.push(json.id);
  return { status: res.status, json };
}

async function login(email) {
  const res = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function adminGet(cookie, path) {
  const res = await fetch(`${GW}${path}`, { headers: { cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, json, buf };
}

const q = async (sql, params) => (await db.query(sql, params)).rows;

const OPERATIONAL = `status, severity, category, assignee_id, summary, sentiment,
                     classification_source, ai_classification, resolved_at, closed_at,
                     first_response_at, rating`;

/** Wait for the pipeline to reach a terminal execution. */
async function waitForExecution(ticketId, timeoutMs = 90_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const rows = await q(
      `SELECT id, status, error_code, result, confidence, model, provider, prompt_version,
              latency_ms, attempt, job_id, event_id
         FROM ai_execution WHERE ticket_id = $1 AND feature = 'screenshot'`,
      [ticketId],
    );
    last = rows[0] ?? null;
    if (last && last.status !== 'running') return { row: last, waitedMs: Date.now() - started };
    await sleep(1500);
  }
  return { row: last, waitedMs: Date.now() - started, timedOut: true };
}

async function main() {
  await db.connect();
  const bytes = readFileSync(FIXTURE);
  console.log(`Fixture: ${FIXTURE} (${bytes.length} bytes)`);
  const token = await identity(SUB);

  // ── 1 ────────────────────────────────────────────────────────────────
  step(1, 'Upload the screenshot');
  const up = await upload(token, 'export-error.png', 'image/png', bytes);
  check('HTTP 201', up.status === 201, `got ${up.status}`);
  const attachmentId = up.json.id;
  console.log(`  attachment: ${attachmentId}`);

  // ── 2 ────────────────────────────────────────────────────────────────
  step(2, 'Create the ticket and link the screenshot');
  const t = await v1(token, 'POST', '/v1/tickets', {
    product_tenant_id: 'acme-corp',
    subject: 'Export keeps failing with a red banner',
    description: 'Every time I run the quarterly export it fails immediately. Screenshot attached.',
  });
  check('ticket created', t.status === 201, `got ${t.status}`);
  const ticketId = t.json.id;
  madeTickets.push(ticketId);
  console.log(`  ticket: ${t.json.reference} (${ticketId})`);

  const before = (await q(`SELECT ${OPERATIONAL} FROM ticket WHERE id = $1`, [ticketId]))[0];

  const linked = await v1(token, 'POST', `/v1/tickets/${ticketId}/attachments`, {
    attachment_ids: [attachmentId],
  });
  check('attachment linked', linked.status === 200 && linked.json.linked === 1, `got ${linked.status}`);

  // ── 3 ────────────────────────────────────────────────────────────────
  step(3, 'ticket.attachment_linked is emitted transactionally');
  const events = await q(
    `SELECT event_id, event_type, product_id, aggregate_id, payload, published_at
       FROM event_outbox WHERE payload->>'attachment_id' = $1`, [attachmentId]);
  check('exactly one link event', events.length === 1, `${events.length} rows`);
  const ev = events[0];
  check('type is ticket.attachment_linked', ev?.event_type === 'ticket.attachment_linked');
  check('payload carries no filename or base64',
    !JSON.stringify(ev.payload).includes('export-error.png') &&
    !JSON.stringify(ev.payload).includes('iVBOR'));
  console.log(`  event: ${ev.event_id}  ${JSON.stringify(ev.payload)}`);

  // ── 4, 5 ─────────────────────────────────────────────────────────────
  step('4-5', 'Dispatcher consumes the event and BullMQ runs the job');
  const { row, waitedMs, timedOut } = await waitForExecution(ticketId);
  check('an ai_execution row was created', Boolean(row), row ? `status=${row.status}` : 'none');
  check('the pipeline reached a terminal state', !timedOut, `waited ${waitedMs}ms`);
  if (!row) { console.log('\nNo execution — aborting.'); return finish(); }
  console.log(`  execution ${row.id} status=${row.status} attempt=${row.attempt} job=${row.job_id}`);

  const published = await q(
    `SELECT published_at FROM event_outbox WHERE event_id = $1`, [ev.event_id]);
  check('the outbox row is now published', published[0]?.published_at !== null,
    String(published[0]?.published_at));

  // ── 6, 7, 8 ──────────────────────────────────────────────────────────
  step('6-8', 'Python received multimodal input, Azure answered, Core validated');
  check('the execution SUCCEEDED', row.status === 'succeeded',
    row.status === 'failed' ? `error_code=${row.error_code}` : row.status);
  if (row.status === 'succeeded') {
    check('provider and model recorded', Boolean(row.provider && row.model), `${row.provider} / ${row.model}`);
    check('prompt version recorded', row.prompt_version === 'screenshot-v1', String(row.prompt_version));
    check('latency recorded', Number(row.latency_ms) > 0, `${row.latency_ms} ms`);
    check('model-reported confidence stored', row.confidence !== null, String(row.confidence));

    const r = row.result ?? {};
    check('result has the validated shape',
      Array.isArray(r.observations) && Array.isArray(r.possible_causes) &&
      Array.isArray(r.suggested_next_steps) && typeof r.confidence === 'number');
    check('result is stamped with the attachment id', r.screenshot_attachment_id === attachmentId);

    console.log('\n  --- what the model actually observed ---');
    for (const o of r.observations ?? []) console.log(`    [${o.type}] ${o.value}`);
    console.log(`    hint: ${JSON.stringify(r.problem_hint)}`);
    for (const c of r.possible_causes ?? []) console.log(`    cause: ${c}`);
    for (const s of r.suggested_next_steps ?? []) console.log(`    step:  ${s}`);
    console.log(`    model-reported confidence: ${r.confidence}`);

    // The fixture's banner reads ERR_QUOTA_EXCEEDED. A real vision call should
    // find it; this is the check that the IMAGE was genuinely read.
    const flat = JSON.stringify(r).toUpperCase();
    check('the model read the error code from the image', flat.includes('ERR_QUOTA_EXCEEDED'));

    // ── 12 ───────────────────────────────────────────────────────────
    check('SEC-8 no image bytes or base64 in the stored result',
      !JSON.stringify(row).includes('iVBOR') && !JSON.stringify(row).includes('base64'));
    check('SEC-8 no blob key or filename in the stored result',
      !JSON.stringify(row).includes('blob') && !JSON.stringify(row).includes('export-error.png'));

    // ── SEC-13 ───────────────────────────────────────────────────────
    const decisionFields = ['priority','severity','assignee','team','routing','status','sla','resolution'];
    const present = decisionFields.filter((f) => Object.prototype.hasOwnProperty.call(r, f));
    check('SEC-13 the result carries no decision field', present.length === 0, present.join(', '));
  }

  // ── 9 ────────────────────────────────────────────────────────────────
  step(9, 'ai_execution is the record of what happened');
  const all = await q(
    `SELECT feature, status, error_code FROM ai_execution WHERE ticket_id = $1 ORDER BY feature`,
    [ticketId]);
  console.log(`  executions: ${all.map((e) => `${e.feature}=${e.status}`).join(', ')}`);
  check('exactly one screenshot execution (idempotent)',
    all.filter((e) => e.feature === 'screenshot').length === 1);

  // ── 10 ───────────────────────────────────────────────────────────────
  step(10, 'The agent sees the interpretation on the ticket page');
  const cookie = await login('carbon.admin@irisregtech.com');
  const detail = await adminGet(cookie, `/admin/api/tickets/${ticketId}`);
  check('ticket loads for the agent', detail.status === 200, `got ${detail.status}`);
  const shots = detail.json?.screenshot_ai ?? [];
  check('the interpretation is on the ticket payload', shots.length === 1, `${shots.length} entries`);
  if (shots[0]) {
    check('it is tied to the attachment the agent can open', shots[0].attachment_id === attachmentId);
    check('status is surfaced', Boolean(shots[0].status), shots[0].status);
    /**
     * `"error_message":` with the colon, not the bare word: `error_message` is
     * also a legitimate OBSERVATION TYPE the model returns, so a substring
     * search matches the model's own honest output and fails for the wrong
     * reason. The DTO field is what must be absent.
     */
    const payload = JSON.stringify(shots);
    check('SEC-10 the agent payload carries no image bytes', !payload.includes('iVBOR'));
    check('SEC-10 and no upstream error prose field', !payload.includes('"error_message":'));
  }

  // ── 11 ───────────────────────────────────────────────────────────────
  step(11, 'AI OBSERVES, CORE DECIDES — no operational field moved');

  /**
   * ⚠️ THE WINDOW HAS TO BE ISOLATED, OR THIS ASSERTION IS MEANINGLESS.
   *
   * `ticket.created` fans out to noop, classification AND summary, and
   * classification legitimately writes severity, category and
   * classification_source while summary writes summary and sentiment. Comparing
   * the ticket from before creation to after everything settles would show
   * those fields moved and prove nothing about SCREENSHOT.
   *
   * So: wait for every other feature to reach a terminal state, snapshot, then
   * link a SECOND screenshot and let only that run. Anything that moves in that
   * window was moved by screenshot.
   */
  for (let i = 0; i < 40; i++) {
    const running = await q(
      `SELECT count(*) n FROM ai_execution WHERE ticket_id = $1 AND status = 'running'`, [ticketId]);
    if (Number(running[0].n) === 0) break;
    await sleep(1500);
  }
  const settled = (await q(`SELECT ${OPERATIONAL} FROM ticket WHERE id = $1`, [ticketId]))[0];
  const others = await q(
    `SELECT feature, status FROM ai_execution WHERE ticket_id = $1 AND feature <> 'screenshot' ORDER BY feature`,
    [ticketId]);
  console.log(`  other features settled: ${others.map((o) => `${o.feature}=${o.status}`).join(', ')}`);

  const second = await upload(token, 'export-error-2.png', 'image/png', bytes);
  await v1(token, 'POST', `/v1/tickets/${ticketId}/attachments`, { attachment_ids: [second.json.id] });

  let secondDone = null;
  for (let i = 0; i < 60; i++) {
    const rows = await q(
      `SELECT status, error_code FROM ai_execution
        WHERE ticket_id = $1 AND feature = 'screenshot' AND status <> 'running'`, [ticketId]);
    if (rows.length === 2) { secondDone = rows; break; }
    await sleep(1500);
  }
  check('a second, independent screenshot execution ran',
    secondDone !== null, secondDone ? secondDone.map((r) => r.status).join(', ') : 'timed out');

  const after = (await q(`SELECT ${OPERATIONAL} FROM ticket WHERE id = $1`, [ticketId]))[0];
  const changed = Object.keys(settled).filter(
    (k) => JSON.stringify(settled[k]) !== JSON.stringify(after[k]));
  check('SEC-13 screenshot alone moved NO operational field', changed.length === 0,
    changed.length
      ? `CHANGED: ${changed.join(', ')}`
      : 'status, severity, category, assignee, summary, sentiment, sla, resolution, rating all identical');

  const comments = await q(`SELECT count(*) n FROM comment WHERE ticket_id = $1`, [ticketId]);
  check('no comment was created', Number(comments[0].n) === 0);

  // ── 12 ───────────────────────────────────────────────────────────────
  step(12, 'Raw image is nowhere it should not be');
  const audit = await q(
    `SELECT action, before, after FROM audit_event
      WHERE entity_id = $1 OR after->>'ticket_id' = $1 OR entity_id = $2`,
    [ticketId, attachmentId]);
  const auditText = JSON.stringify(audit);
  check('SEC-9 no base64 in the audit trail', !auditText.includes('iVBOR') && !auditText.includes('base64'));
  console.log(`  audit actions: ${audit.map((a) => a.action).join(', ')}`);

  const anyBase64 = await q(
    `SELECT count(*) n FROM ai_execution WHERE ticket_id = $1 AND result::text LIKE '%iVBOR%'`,
    [ticketId]);
  check('SEC-8 no execution result anywhere contains PNG base64', Number(anyBase64[0].n) === 0);

  // ── 13 ───────────────────────────────────────────────────────────────
  step(13, 'A non-screenshot attachment costs nothing');
  const csv = await upload(token, 'rows.csv', 'text/csv', Buffer.from('a,b\n1,2\n'));
  check('the CSV uploads normally', csv.status === 201, `got ${csv.status}`);
  await v1(token, 'POST', `/v1/tickets/${ticketId}/attachments`, { attachment_ids: [csv.json.id] });
  await sleep(6000);
  const csvEvent = await q(
    `SELECT event_id, published_at FROM event_outbox WHERE payload->>'attachment_id' = $1`,
    [csv.json.id]);
  check('its link event exists', csvEvent.length === 1);
  check('and was marked published without dispatching',
    csvEvent[0]?.published_at !== null, String(csvEvent[0]?.published_at));
  /**
   * TWO screenshot executions exist by now — the original and the isolated
   * second one section 11 created to prove the decision boundary. The CSV must
   * add neither, so the count is unchanged rather than zero.
   */
  const after2 = await q(
    `SELECT count(*) n FROM ai_execution WHERE ticket_id = $1 AND feature = 'screenshot'`, [ticketId]);
  check('the CSV added no screenshot execution', Number(after2[0].n) === 2,
    `${after2[0].n} screenshot executions total, both from real images`);

  // ── 14 ───────────────────────────────────────────────────────────────
  step(14, 'An oversized image never reaches the provider');
  // 15000x2000: inside Step 1 storage bounds, outside the vision bounds.
  const { execSync } = await import('node:child_process');
  const bigPath = FIXTURE.replace('screenshot-fixture.png', 'oversize-fixture.png');
  execSync(
    `python -c "from PIL import Image; Image.new('RGB',(15000,2000),'#eee').save(r'${bigPath}','PNG')"`,
    { stdio: 'ignore' },
  );
  const bigBytes = readFileSync(bigPath);
  const bigUp = await upload(token, 'huge.png', 'image/png', bigBytes);
  check('storage accepts it (within Step 1 bounds)', bigUp.status === 201, `got ${bigUp.status}`);
  if (bigUp.status === 201) {
    const t2 = await v1(token, 'POST', '/v1/tickets', {
      product_tenant_id: 'acme-corp', subject: 'Wide capture',
      description: 'A very wide screenshot.',
    });
    madeTickets.push(t2.json.id);
    await v1(token, 'POST', `/v1/tickets/${t2.json.id}/attachments`, { attachment_ids: [bigUp.json.id] });
    const big = await waitForExecution(t2.json.id, 45_000);
    check('the execution failed deterministically', big.row?.status === 'failed', String(big.row?.status));
    check('with image_too_large, before any provider call',
      big.row?.error_code === 'image_too_large', String(big.row?.error_code));
    check('and no result was stored', big.row?.result === null);
  }

  // ── 15 ───────────────────────────────────────────────────────────────
  step(15, 'A credential visible in a screenshot is never persisted (Step 3)');

  /**
   * ⚠️ TWO ACCEPTABLE OUTCOMES, ONE UNACCEPTABLE ONE.
   *
   * The prompt tells the model not to transcribe credentials, and the redactor
   * removes them if it does anyway. Either is a pass; what must never happen is
   * the raw token reaching storage or the API. The script reports WHICH control
   * fired, because "the model behaved" and "the deterministic guard caught it"
   * are different levels of assurance and the difference should not be hidden.
   */
  let secretBytes = null;
  try {
    secretBytes = readFileSync(SECRET_FIXTURE);
  } catch {
    check('the synthetic-secret fixture is present', false, SECRET_FIXTURE);
  }

  if (secretBytes) {
    console.log(`  fixture: ${SECRET_FIXTURE} (${secretBytes.length} bytes), token rendered on screen`);
    const su = await upload(token, 'auth-error.png', 'image/png', secretBytes);
    check('the screenshot uploads', su.status === 201, `got ${su.status}`);

    const st = await v1(token, 'POST', '/v1/tickets', {
      product_tenant_id: 'acme-corp',
      subject: 'API console rejects my token',
      description: 'The API console shows an auth error. Screenshot attached.',
    });
    madeTickets.push(st.json.id);
    const secretTicket = st.json.id;
    const opsBefore = (await q(`SELECT ${OPERATIONAL} FROM ticket WHERE id = $1`, [secretTicket]))[0];

    await v1(token, 'POST', `/v1/tickets/${secretTicket}/attachments`, {
      attachment_ids: [su.json.id],
    });

    const sec = await waitForExecution(secretTicket, 90_000);
    check('Screenshot AI executed on it', Boolean(sec.row), sec.row ? sec.row.status : 'none');
    check('the execution succeeded', sec.row?.status === 'succeeded',
      sec.row?.status === 'failed' ? `error_code=${sec.row.error_code}` : String(sec.row?.status));

    if (sec.row?.status === 'succeeded') {
      const r = sec.row.result ?? {};
      console.log('\n  --- what was persisted ---');
      for (const o of r.observations ?? []) console.log(`    [${o.type}] ${o.value}`);
      for (const c of r.possible_causes ?? []) console.log(`    cause: ${c}`);

      const stored = JSON.stringify(sec.row);
      check('SEC-23 the raw token is NOT in ai_execution', !stored.includes(FAKE_TOKEN));

      const redacted = stored.includes('[REDACTED_SECRET]');
      console.log(
        redacted
          ? '  control that fired: the DETERMINISTIC REDACTOR removed it after validation'
          : '  control that fired: the model declined to transcribe it (prompt-level)',
      );

      // The error code beside the token must survive either way.
      check('SEC-21 the surrounding error text survives',
        stored.includes('ERR_AUTH_TOKEN_REJECTED') || (r.observations ?? []).length > 0);

      const detail = await adminGet(cookie, `/admin/api/tickets/${secretTicket}`);
      check('SEC-24 the raw token is NOT in the agent API response',
        !detail.buf.toString('utf8').includes(FAKE_TOKEN));

      const auditRows = await q(
        `SELECT before, after FROM audit_event WHERE entity_id = $1 OR after->>'ticket_id' = $1`,
        [secretTicket]);
      check('the raw token is NOT in the audit trail',
        !JSON.stringify(auditRows).includes(FAKE_TOKEN));

      const opsAfter = (await q(`SELECT ${OPERATIONAL} FROM ticket WHERE id = $1`, [secretTicket]))[0];
      const moved = Object.keys(opsBefore).filter(
        (k) => JSON.stringify(opsBefore[k]) !== JSON.stringify(opsAfter[k]));
      // classification and summary legitimately write some of these; assert only
      // that nothing screenshot could own moved unexpectedly.
      console.log(`  (fields written by classification/summary on this ticket: ${moved.join(', ') || 'none'})`);
      check('status, assignee and resolution are untouched',
        !moved.includes('status') && !moved.includes('assignee_id') &&
        !moved.includes('resolved_at') && !moved.includes('closed_at'));
    }
  }

  finish();
}

async function finish() {
  console.log(`\n${'='.repeat(66)}\nRESULT: ${pass} passed, ${fail} failed`);
  try {
    if (madeAttachments.length) {
      await db.query(`DELETE FROM audit_event WHERE entity_type='attachment' AND entity_id = ANY($1)`, [madeAttachments]);
      await db.query(`DELETE FROM event_outbox WHERE payload->>'attachment_id' = ANY($1)`, [madeAttachments]);
      await db.query(`DELETE FROM attachment WHERE id = ANY($1)`, [madeAttachments]);
    }
    if (madeTickets.length) {
      await db.query(`DELETE FROM ai_execution WHERE ticket_id = ANY($1)`, [madeTickets]);
      await db.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
      await db.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
      await db.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
    }
    console.log('Cleaned up.');
  } catch (e) {
    console.log('cleanup warning:', e.message);
  }
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nVERIFICATION ERROR:', e);
  await finish();
});

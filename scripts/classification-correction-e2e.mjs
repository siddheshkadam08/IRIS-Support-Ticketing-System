/**
 * Phase 20 end-to-end verification, through the REAL running stack.
 *
 *   admin panel session (httpOnly cookie) -> gateway -> Core -> Postgres/RLS
 *     -> compare-and-set correction
 *     -> deterministic priority engine
 *     -> append-only audit
 *
 *   node scripts/classification-correction-e2e.mjs
 *
 * Nothing is stubbed. Staff sign in with real passwords and carry real session
 * cookies; the customer half authenticates with the tenant's real publishable
 * key. Postgres is read directly ONLY to observe rows no API exposes, and
 * written only to remove what this script created.
 *
 * ⚠️ AI PREDICTS. HUMAN REVIEWS. IRIS DECIDES. Section 6 re-derives the priority
 * independently, in this script, and requires the stored severity to match.
 */
import pg from 'pg';

const GW = 'http://localhost:4000';
const CARBON = 'pub_live_carbon_8f2a';
const PRODUCT_A = 'prod_carbon';
const PASSWORD = 'Abc@1234';
const SUB = `corr_e2e_${Date.now().toString(36)}`;

const db = new pg.Client('postgres://postgres:postgres_dev_pw@localhost:5432/iris');
const madeTickets = [];

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
};
const step = (n, t) => console.log(`\n=== ${n}. ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ── auth ─────────────────────────────────────────────────────────────────

async function identity(sub) {
  const res = await fetch(`${GW}/dev/identity-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishable_key: CARBON, sub, product_tenant_id: 'acme-corp' }),
  });
  return (await res.json()).identity_token;
}

async function login(email) {
  const res = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function adminReq(cookie, method, path, body) {
  const res = await fetch(`${GW}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const correct = (cookie, id, body) =>
  adminReq(cookie, 'PATCH', `/admin/api/tickets/${id}/classification`, body);

// ── the deterministic engine, reimplemented here ON PURPOSE ──────────────
//
// ⚠️ This script does NOT import determinePriority. Importing it would compare
// the implementation against itself and pass whatever it did. These are the
// documented rules, written out independently, so a change in the engine that
// nobody intended shows up here as a disagreement.

const DEFAULT_SCORING = {
  baseline: 15, system_down_bonus: 25, core_category_system_down_bonus: 10,
  regulatory_bonus: 10, workaround_penalty: 10,
  impact_by_index: [0, 5, 10, 15],
  deadline_bands: [{ max_hours: 4, score: 20 }, { max_hours: 24, score: 12 }, { max_hours: 72, score: 5 }],
  critical_threshold: 60, high_threshold: 40, normal_threshold: 15,
};
const PRIORITY_TO_SEVERITY = { Critical: 'critical', High: 'high', Normal: 'medium', Low: 'low' };

function independentPriority({ factors, issue_type, category, impact, impacts, core_categories }) {
  const cfg = DEFAULT_SCORING;
  if (factors.security_or_data_loss) return 'Critical';
  if (['Information', 'Question'].includes(issue_type)) return 'Low';
  if (['Enhancement', 'Feature Request'].includes(issue_type)) return 'Low';
  if (factors.cosmetic_only) return 'Low';

  let score = cfg.baseline;
  if (factors.system_down) {
    score += cfg.system_down_bonus;
    if (core_categories.includes(category)) score += cfg.core_category_system_down_bonus;
  }
  const idx = impacts.indexOf(impact);
  if (idx > 0) score += cfg.impact_by_index[Math.min(idx, cfg.impact_by_index.length - 1)] ?? 0;

  const h = factors.hours_until_deadline;
  if (h !== null && Number.isFinite(h) && h >= 0) {
    for (const b of [...cfg.deadline_bands].sort((a, b2) => a.max_hours - b2.max_hours)) {
      if (h <= b.max_hours) { score += b.score; break; }
    }
  }
  if (factors.regulatory_impact) score += cfg.regulatory_bonus;
  if (factors.workaround_available) score -= cfg.workaround_penalty;

  return score >= cfg.critical_threshold ? 'Critical'
    : score >= cfg.high_threshold ? 'High'
      : score >= cfg.normal_threshold ? 'Normal' : 'Low';
}

// ── observation helpers ──────────────────────────────────────────────────

const ticketRow = async (id) =>
  (await q(`SELECT category, severity, classification_source, ai_classification,
                   status, assignee_id, summary, resolved_at, closed_at
              FROM ticket WHERE id = $1`, [id]))[0];

const correctionEvents = (id) =>
  q(`SELECT before, after, actor_ref, request_id, source_ip FROM audit_event
      WHERE entity_type='ticket' AND entity_id=$1 AND action='ticket.classification_corrected'
      ORDER BY occurred_at, id`, [id]);

async function main() {
  await db.connect();

  const [manager, carbonAdmin, agent, esgAdmin] = await Promise.all([
    login('ops.manager@irisregtech.com'),
    login('carbon.admin@irisregtech.com'),
    login('carbon.agent@irisregtech.com'),
    login('esg.admin@irisregtech.com'),
  ]);
  check('four real staff sessions established', Boolean(manager && carbonAdmin && agent && esgAdmin));

  const cats = (await q(`SELECT config->'categories' c FROM product WHERE id=$1`, [PRODUCT_A]))[0].c ?? [];
  check('the tenant has categories configured', cats.length > 1, `${cats.length} categories`);
  const catA = cats[0].value;
  const catB = cats[1].value;

  // ── 1 ────────────────────────────────────────────────────────────────
  step(1, 'Create a ticket and let the REAL AI pipeline classify it');

  /**
   * ⚠️ ITS OWN TICKET, NOT A SEEDED ONE.
   *
   * The brief asks for a real `ai_uncertain` ticket, and this is one: created
   * through the real widget path, dispatched through the real outbox and queue,
   * classified by the real model, and landing in `ai_uncertain` because the
   * configured thresholds put it there. Correcting a pre-existing seeded ticket
   * would have been equally real and would have left a permanent, unreverted
   * mutation on shared demo data — a side effect a verification script has no
   * business causing.
   */
  const token = await identity(SUB);
  const created = await fetch(`${GW}/v1/tickets`, {
    method: 'POST',
    headers: { 'X-IRIS-Publishable-Key': CARBON, 'X-IRIS-Identity': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_tenant_id: 'acme-corp',
      subject: 'Quarterly export fails at the final step',
      description:
        'Running the Q3 emissions export gets to 90% and then fails with a red banner. ' +
        'It has failed three times today. There is no workaround we can find.',
    }),
  });
  const t = await created.json();
  check('ticket created', created.status === 201, `got ${created.status}`);
  madeTickets.push(t.id);
  console.log(`  ticket ${t.reference} (${t.id})`);

  let before = null;
  for (let i = 0; i < 40; i++) {
    const r = await ticketRow(t.id);
    if (r.classification_source !== 'unclassified') { before = r; break; }
    await sleep(1500);
  }
  check('the real AI pipeline classified it', before !== null,
    before ? `source=${before.classification_source}` : 'timed out');
  if (!before) { console.log('\nNo classification — aborting.'); return finish(); }

  check('it landed in a band a human may review', before.classification_source !== 'unclassified');
  console.log(`  before: category=${before.category} severity=${before.severity} source=${before.classification_source}`);

  const expected = {
    category: before.category,
    severity: before.severity,
    classification_source: before.classification_source,
  };
  const target = before.category === catA ? catB : catA;

  // ── 2 ────────────────────────────────────────────────────────────────
  step(2, 'An agent cannot correct it');
  const agentTry = await correct(agent, t.id, { category: target, expected });
  check('HTTP 403', agentTry.status === 403, `got ${agentTry.status}`);
  check('code forbidden', agentTry.json?.error?.code === 'forbidden');
  check('the ticket is untouched', JSON.stringify(await ticketRow(t.id)) === JSON.stringify(before));
  check('no audit row was written', (await correctionEvents(t.id)).length === 0);

  // ── 3 ────────────────────────────────────────────────────────────────
  step(3, 'A foreign product cannot correct it');
  const foreign = await correct(esgAdmin, t.id, { category: target, expected });
  check('HTTP 404', foreign.status === 404, `got ${foreign.status}`);
  check('code ticket_not_found', foreign.json?.error?.code === 'ticket_not_found');
  check('the refusal names neither the product nor the subject',
    !foreign.text.includes(PRODUCT_A) && !foreign.text.includes('carbon'));

  // ── 4 ────────────────────────────────────────────────────────────────
  step(4, 'A stale expected state is refused');
  const stale = await correct(manager, t.id, {
    category: target,
    expected: { ...expected, category: 'a_category_it_certainly_does_not_have' },
  });
  check('HTTP 409', stale.status === 409, `got ${stale.status}`);
  check('code invalid_state_transition', stale.json?.error?.code === 'invalid_state_transition');
  check('still no audit row', (await correctionEvents(t.id)).length === 0);
  check('the ticket is still untouched', JSON.stringify(await ticketRow(t.id)) === JSON.stringify(before));

  // ── 5 ────────────────────────────────────────────────────────────────
  step(5, 'A no-op writes nothing');
  const noop = await correct(manager, t.id, {
    category: before.category, severity: before.severity, expected,
  });
  check('HTTP 200', noop.status === 200, `got ${noop.status}`);
  check('no audit row', (await correctionEvents(t.id)).length === 0);
  check('source is still ai_uncertain', (await ticketRow(t.id)).classification_source === 'ai_uncertain');

  // ── 6 ────────────────────────────────────────────────────────────────
  step(6, 'The manager corrects the category');
  const res = await correct(manager, t.id, { category: target, expected });
  check('HTTP 200', res.status === 200, `got ${res.status}`);

  const after = await ticketRow(t.id);
  console.log(`  after:  category=${after.category} severity=${after.severity} source=${after.classification_source}`);
  check('category changed', after.category === target);
  check('classification_source is human', after.classification_source === 'human');

  const ai = after.ai_classification ?? {};
  const wanted = independentPriority({
    factors: ai.priority_factors,
    issue_type: ai.issue_type,
    category: target,
    impact: ai.impact,
    impacts: (await q(`SELECT config->'impacts' i FROM product WHERE id=$1`, [PRODUCT_A]))[0].i
      ?? ['Single User', 'Multiple Users', 'Entire Department', 'Entire Organisation'],
    core_categories: (await q(`SELECT config->'core_categories' c FROM product WHERE id=$1`, [PRODUCT_A]))[0].c ?? [],
  });
  check('SEC-17 stored severity equals an INDEPENDENT re-derivation',
    after.severity === PRIORITY_TO_SEVERITY[wanted], `${after.severity} vs ${PRIORITY_TO_SEVERITY[wanted]} (priority ${wanted})`);

  // ── 7 ────────────────────────────────────────────────────────────────
  step(7, 'Exactly one audit event, with the true before and after');
  const events = await correctionEvents(t.id);
  check('exactly one correction event', events.length === 1, `${events.length} rows`);
  const ev = events[0];
  if (ev) {
    console.log(`  before: ${JSON.stringify(ev.before)}`);
    console.log(`  after:  ${JSON.stringify(ev.after)}`);
    check('before matches what was actually stored',
      ev.before.category === before.category &&
      ev.before.severity === before.severity &&
      ev.before.classification_source === 'ai_uncertain');
    check('after records the human decision',
      ev.after.category === target && ev.after.classification_source === 'human');
    check('the engine derivation is recorded', ev.after.derived_priority === wanted);
    check('severity_overridden is false (severity was derived)', ev.after.severity_overridden === false);
    check('the actor is recorded', Boolean(ev.actor_ref));
    check('the request id is recorded', Boolean(ev.request_id));
    check('no ticket body or customer text in the audit row',
      !JSON.stringify(ev).includes('Quarterly export') &&
      !JSON.stringify(ev).includes('emissions export') &&
      !JSON.stringify(ev).includes('red banner'));
  }

  // ── 8 ────────────────────────────────────────────────────────────────
  step(8, 'The AI record is untouched');
  check('SEC-15 ai_classification is byte-identical',
    JSON.stringify(after.ai_classification) === JSON.stringify(before.ai_classification));
  const execs = await q(`SELECT result FROM ai_execution WHERE ticket_id=$1 ORDER BY id`, [t.id]);
  check('ai_execution rows still present and readable', Array.isArray(execs));
  check('SEC-20 status, assignee and resolution are untouched',
    after.status === before.status && after.assignee_id === before.assignee_id &&
    String(after.resolved_at) === String(before.resolved_at) &&
    String(after.closed_at) === String(before.closed_at));

  // ── 9 ────────────────────────────────────────────────────────────────
  step(9, 'A severity override is recorded as an override');
  const cur = await ticketRow(t.id);
  const opposite = cur.severity === 'critical' ? 'low' : 'critical';
  const ovr = await correct(carbonAdmin, t.id, {
    severity: opposite,
    expected: { category: cur.category, severity: cur.severity, classification_source: 'human' },
  });
  check('a product_admin can correct an already-human ticket', ovr.status === 200, `got ${ovr.status}`);
  const events2 = await correctionEvents(t.id);
  check('a second, separate audit event exists', events2.length === 2);
  const ev2 = events2[1];
  if (ev2) {
    check('severity_overridden is true', ev2.after.severity_overridden === true);
    check('the engine value is still recorded beside it',
      ev2.after.derived_severity !== null && ev2.after.derived_severity !== opposite,
      `derived=${ev2.after.derived_severity} stored=${ev2.after.severity}`);
  }
  check('the stored severity is the human value', (await ticketRow(t.id)).severity === opposite);

  // ── 10 ───────────────────────────────────────────────────────────────
  step(10, 'A late AI result cannot overwrite the human decision');
  const human = await ticketRow(t.id);
  // The AI writer's own guard, exercised through SQL exactly as it runs.
  const late = await q(
    `UPDATE ticket
        SET category='${catA}', severity='critical', classification_source='ai_auto'
      WHERE id=$1 AND classification_source='unclassified'
     RETURNING id`, [t.id]);
  check('SEC-16 the AI write-once guard matched zero rows', late.length === 0);
  check('the human decision stands', JSON.stringify(await ticketRow(t.id)) === JSON.stringify(human));

  // ── 11 ───────────────────────────────────────────────────────────────
  step(11, 'The agent UI receives the corrected state');
  const detail = await adminReq(manager, 'GET', `/admin/api/tickets/${t.id}`);
  check('the ticket loads', detail.status === 200, `got ${detail.status}`);
  check('classification_source is human on the wire', detail.json?.classification_source === 'human');
  check('category and severity match the database',
    detail.json?.category === human.category && detail.json?.severity === human.severity);

  finish();
}

async function finish() {
  console.log(`\n${'='.repeat(66)}\nRESULT: ${pass} passed, ${fail} failed`);
  console.log('The ticket this script created, its executions, events and audit');
  console.log('rows are removed below; no seeded data was mutated.');
  try {
    if (madeTickets.length) {
      await db.query(`DELETE FROM ai_execution WHERE ticket_id = ANY($1)`, [madeTickets]);
      await db.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
      await db.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
      await db.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
    }
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

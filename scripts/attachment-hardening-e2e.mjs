/**
 * Phase 19 Step 1 verification, through the REAL running stack.
 *
 *   widget (publishable key + identity JWT) -> gateway -> Core -> Postgres
 *   admin panel session (httpOnly cookie)   -> gateway -> Core -> blob store
 *
 *   node scripts/attachment-hardening-e2e.mjs
 *
 * Nothing is stubbed. The customer half authenticates exactly as the widget
 * does; the staff half signs in with a real password and carries a real session
 * cookie. Postgres is read directly ONLY to observe rows no API exposes, and
 * written only to remove what this script created.
 *
 * ⚠️ EVERY REFUSAL IS PAIRED WITH A POSITIVE CONTROL. "The foreign product got
 * a 404" passes just as well when the endpoint is broken for everyone, so each
 * one is checked against the same request succeeding for the rightful owner.
 */
import pg from 'pg';

const GW = 'http://localhost:4000';
const CARBON = 'pub_live_carbon_8f2a';
const ESG_PRODUCT = 'prod_esg';
const PASSWORD = 'Abc@1234';
const SUB = `att_hardening_${Date.now().toString(36)}`;

const db = new pg.Client('postgres://postgres:postgres_dev_pw@localhost:5432/iris');
const madeAttachments = [];
const madeTickets = [];

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
};
const step = (n, t) => console.log(`\n=== STEP ${n} — ${t} ===`);

// ── fixtures ─────────────────────────────────────────────────────────────

function png(width = 1280, height = 720) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function identity(sub) {
  const res = await fetch(`${GW}/dev/identity-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishable_key: CARBON,
      sub,
      product_tenant_id: 'acme-corp',
      name: 'Attachment Tester',
      email: 'attachment.tester@acme.example',
    }),
  });
  return (await res.json()).identity_token;
}

async function v1(token, method, path, body) {
  const headers = { 'X-IRIS-Publishable-Key': CARBON, 'X-IRIS-Identity': token };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GW}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** A real multipart upload, byte for byte what a browser sends. */
async function upload(token, filename, contentType, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const res = await fetch(`${GW}/v1/attachments`, {
    method: 'POST',
    headers: { 'X-IRIS-Publishable-Key': CARBON, 'X-IRIS-Identity': token },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 201 && json?.id) madeAttachments.push(json.id);
  return { status: res.status, json };
}

async function login(email) {
  const res = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  return { status: res.status, json, buf, headers: res.headers };
}

const row = async (id) =>
  (await db.query(
    `SELECT ticket_id, product_id, uploaded_by, content_type, blob_key FROM attachment WHERE id = $1`,
    [id],
  )).rows[0];

async function main() {
  await db.connect();
  const tokenA = await identity(SUB);
  const tokenB = await identity(`${SUB}_other`);
  check('two distinct customer identities minted', Boolean(tokenA && tokenB && tokenA !== tokenB));

  // ── STEP 1 ───────────────────────────────────────────────────────────
  step(1, 'Upload a valid image');
  const good = await upload(tokenA, 'screenshot.png', 'image/png', png(1280, 720));
  check('HTTP 201', good.status === 201, `got ${good.status}`);
  check('content type recorded as image/png', good.json?.content_type === 'image/png');
  check('stored unlinked', (await row(good.json.id)).ticket_id === null);
  console.log(`  attachment: ${good.json.id}`);

  // ── STEP 2 ───────────────────────────────────────────────────────────
  step(2, 'Upload a spoofed image — declared PNG, actually an SVG');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const spoof = await upload(tokenA, 'screenshot.png', 'image/png', svg);
  check('HTTP 415', spoof.status === 415, `got ${spoof.status}`);
  check('code attachment_type_not_allowed', spoof.json?.error?.code === 'attachment_type_not_allowed',
    spoof.json?.error?.code);
  check('the refusal does not name the detected type', !/svg/i.test(JSON.stringify(spoof.json)));

  const corrupt = await upload(tokenA, 'broken.png', 'image/png', png().subarray(0, 20));
  check('a corrupted PNG is a distinct 400', corrupt.status === 400, `got ${corrupt.status}`);
  check('code invalid_request', corrupt.json?.error?.code === 'invalid_request');

  // ── STEP 3 ───────────────────────────────────────────────────────────
  step(3, 'Upload an over-dimensioned image (a decompression bomb)');
  const bomb = await upload(tokenA, 'bomb.png', 'image/png', png(225_000, 225_000));
  check('HTTP 413', bomb.status === 413, `got ${bomb.status}`);
  check('code attachment_too_large', bomb.json?.error?.code === 'attachment_too_large');
  console.log(`  refusal: ${bomb.json?.error?.message}`);

  const pixels = await upload(tokenA, 'bomb2.png', 'image/png', png(19_000, 19_000));
  check('a pixel-count bomb whose axes both pass is still refused', pixels.status === 413,
    `got ${pixels.status}`);

  const stored = await db.query(
    `SELECT count(*) n FROM attachment WHERE filename IN ('bomb.png','bomb2.png','broken.png')
       AND created_at > now() - interval '5 minutes'`);
  check('no rejected upload was stored', Number(stored.rows[0].n) === 0, `${stored.rows[0].n} rows`);

  // ── STEP 4 ───────────────────────────────────────────────────────────
  step(4, 'Create a ticket');
  const ticket = await v1(tokenA, 'POST', '/v1/tickets', {
    product_tenant_id: 'acme-corp',
    subject: 'Export fails with a red banner',
    description: 'The export screen shows an error banner. Screenshot attached.',
  });
  check('HTTP 201', ticket.status === 201, `got ${ticket.status}`);
  const ticketId = ticket.json?.id;
  if (ticketId) madeTickets.push(ticketId);
  console.log(`  ticket: ${ticket.json?.reference} (${ticketId})`);

  // ── STEP 5 ───────────────────────────────────────────────────────────
  step(5, 'Link the attachment, and prove ownership is enforced');
  check('before linking, ticket_id IS NULL', (await row(good.json.id)).ticket_id === null);

  // A second customer's upload, used as the negative case.
  const foreignUpload = await upload(tokenB, 'not-yours.png', 'image/png', png());
  check('the other customer uploaded successfully (control)', foreignUpload.status === 201);

  const steal = await v1(tokenA, 'POST', `/v1/tickets/${ticketId}/attachments`, {
    attachment_ids: [foreignUpload.json.id],
  });
  check('linking another customer upload is refused', steal.status === 404, `got ${steal.status}`);
  check('the refusal names neither the uploader nor the file',
    !JSON.stringify(steal.json).includes('not-yours') && !JSON.stringify(steal.json).includes(`${SUB}_other`));
  check('their attachment is still unlinked', (await row(foreignUpload.json.id)).ticket_id === null);

  const linked = await v1(tokenA, 'POST', `/v1/tickets/${ticketId}/attachments`, {
    attachment_ids: [good.json.id],
  });
  check('the owner can link their own (positive control)', linked.status === 200, `got ${linked.status}`);
  check('linked = 1', linked.json?.linked === 1);
  check('after linking, ticket_id = ticket.id', (await row(good.json.id)).ticket_id === ticketId);

  const again = await v1(tokenA, 'POST', `/v1/tickets/${ticketId}/attachments`, {
    attachment_ids: [good.json.id],
  });
  check('re-linking an already-linked attachment is refused', again.status === 404, `got ${again.status}`);

  // ── STEP 6 ───────────────────────────────────────────────────────────
  step(6, 'The transactional outbox event');
  const events = await db.query(
    `SELECT event_type, product_id, aggregate_id, payload, published_at
       FROM event_outbox WHERE payload->>'attachment_id' = $1`, [good.json.id]);
  check('exactly one link event exists', events.rows.length === 1, `${events.rows.length} rows`);
  const ev = events.rows[0];
  if (ev) {
    console.log(`  ${ev.event_type}  ${JSON.stringify(ev.payload)}`);
    check('type is ticket.attachment_linked', ev.event_type === 'ticket.attachment_linked');
    check('carries the product id', ev.product_id === 'prod_carbon', ev.product_id);
    check('aggregate is the ticket', ev.aggregate_id === ticketId);
    check('payload names ticket and attachment', ev.payload.ticket_id === ticketId && ev.payload.attachment_id === good.json.id);
    check('payload leaks no filename or raiser reference',
      !JSON.stringify(ev.payload).includes('screenshot.png') && !JSON.stringify(ev.payload).includes(SUB));
    check('nothing has consumed it yet, as intended for Step 1', ev.published_at === null);
  }

  const refusedEvents = await db.query(
    `SELECT count(*) n FROM event_outbox WHERE payload->>'attachment_id' = $1`, [foreignUpload.json.id]);
  check('the refused link produced NO event', Number(refusedEvents.rows[0].n) === 0);

  const audit = await db.query(
    `SELECT action, before, after FROM audit_event
      WHERE entity_type = 'attachment' AND entity_id = $1 ORDER BY occurred_at`, [good.json.id]);
  const links = audit.rows.filter((r) => r.action === 'attachment.linked');
  check('exactly one attachment.linked audit row', links.length === 1, `${links.length} rows`);
  if (links[0]) {
    console.log(`  audit before=${JSON.stringify(links[0].before)} after=${JSON.stringify(links[0].after)}`);
    check('records the transition', links[0].before?.ticket_id === null && links[0].after?.ticket_id === ticketId);
    check('carries no filename and no bytes',
      !JSON.stringify(links[0]).includes('screenshot.png') && !JSON.stringify(links[0]).includes('iVBOR'));
  }
  const refusedAudit = await db.query(
    `SELECT count(*) n FROM audit_event WHERE entity_type='attachment' AND entity_id=$1 AND action='attachment.linked'`,
    [foreignUpload.json.id]);
  check('the refused link produced NO audit row', Number(refusedAudit.rows[0].n) === 0);

  // ── STEPS 7-9 ────────────────────────────────────────────────────────
  step('7-9', 'An agent opens the ticket, sees the attachment, and reads it');
  const carbonAdmin = await login('carbon.admin@irisregtech.com');
  const detail = await adminGet(carbonAdmin, `/admin/api/tickets/${ticketId}`);
  check('the ticket loads', detail.status === 200, `got ${detail.status}`);
  const listed = (detail.json?.attachments ?? []).find((a) => a.id === good.json.id);
  check('the attachment is listed', Boolean(listed));
  check('with filename, type and size', listed?.filename === 'screenshot.png' && listed?.content_type === 'image/png' && listed?.size_bytes > 0,
    listed ? `${listed.filename} ${listed.content_type} ${listed.size_bytes}B` : '');

  const blobKey = (await row(good.json.id)).blob_key;
  check('SEC-13 the ticket payload leaks no storage key',
    !detail.buf.toString('utf8').includes(blobKey) && !detail.buf.toString('utf8').includes('blob_key'));

  const content = await adminGet(carbonAdmin, `/admin/api/tickets/${ticketId}/attachments/${good.json.id}/content`);
  check('the agent can read the bytes', content.status === 200, `got ${content.status}`);
  check('the bytes are the PNG that was uploaded',
    content.buf.subarray(0, 8).equals(png().subarray(0, 8)));
  check('served as octet-stream', content.headers.get('content-type') === 'application/octet-stream');
  check('forced to download, never inline', String(content.headers.get('content-disposition')).includes('attachment'));
  check('nosniff set', content.headers.get('x-content-type-options') === 'nosniff');
  check('sandbox CSP set', String(content.headers.get('content-security-policy')).includes('sandbox'));

  const wrongTicket = await adminGet(carbonAdmin, `/admin/api/tickets/${ticketId}/attachments/att_not_real/content`);
  check('an unknown attachment id is a 404', wrongTicket.status === 404, `got ${wrongTicket.status}`);

  // ── STEP 10 ──────────────────────────────────────────────────────────
  step(10, 'A foreign product cannot reach it');
  const esgAdmin = await login('esg.admin@irisregtech.com');
  const foreign = await adminGet(esgAdmin, `/admin/api/tickets/${ticketId}/attachments/${good.json.id}/content`);
  check('HTTP 404 for the ESG admin', foreign.status === 404, `got ${foreign.status}`);
  check('code ticket_not_found', foreign.json?.error?.code === 'ticket_not_found');
  check('the refusal names neither the product nor the file',
    !foreign.buf.toString('utf8').includes('prod_carbon') && !foreign.buf.toString('utf8').includes('screenshot.png'));
  const foreignDetail = await adminGet(esgAdmin, `/admin/api/tickets/${ticketId}`);
  check('and the ticket itself is invisible to them', foreignDetail.status === 404);
  console.log(`  (ESG admin is scoped to ${ESG_PRODUCT})`);

  // Positive control, immediately after, on the same URL.
  const recheck = await adminGet(carbonAdmin, `/admin/api/tickets/${ticketId}/attachments/${good.json.id}/content`);
  check('positive control: the owning admin still succeeds on that exact URL', recheck.status === 200);

  console.log(`\n${'='.repeat(64)}\nRESULT: ${pass} passed, ${fail} failed`);

  await db.query(`DELETE FROM audit_event WHERE entity_type='attachment' AND entity_id = ANY($1)`, [madeAttachments]);
  await db.query(`DELETE FROM event_outbox WHERE payload->>'attachment_id' = ANY($1)`, [madeAttachments]);
  await db.query(`DELETE FROM attachment WHERE id = ANY($1)`, [madeAttachments]);
  /**
   * ⚠️ EXECUTIONS BEFORE TICKETS. Phase 19 made this necessary: a linked
   * PNG now produces a `screenshot` execution, and `ai_execution.ticket_id`
   * is a foreign key, so deleting the ticket first fails. This is the
   * ordering the schema requires, not a workaround.
   */
  await db.query(`DELETE FROM ai_execution WHERE ticket_id = ANY($1)`, [madeTickets]);
  await db.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
  await db.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
  await db.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
  console.log('Cleaned up.');
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nVERIFICATION ERROR:', e);
  try {
    await db.query(`DELETE FROM audit_event WHERE entity_type='attachment' AND entity_id = ANY($1)`, [madeAttachments]);
    await db.query(`DELETE FROM event_outbox WHERE payload->>'attachment_id' = ANY($1)`, [madeAttachments]);
    await db.query(`DELETE FROM attachment WHERE id = ANY($1)`, [madeAttachments]);
    await db.query(`DELETE FROM ai_execution WHERE ticket_id = ANY($1)`, [madeTickets]);
    await db.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
    await db.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
    await db.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
    await db.end();
  } catch { /* already closed */ }
  process.exit(1);
});

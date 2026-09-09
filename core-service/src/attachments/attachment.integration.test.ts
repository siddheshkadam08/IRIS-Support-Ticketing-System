import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withSystemScope, type Tx } from '../db/with-scope.js';
import { MAX_IMAGE_PIXELS } from '../storage/image.js';

/**
 * Attachment hardening — Phase 19 Step 1, against the REAL Postgres.
 *
 * Nothing here is mocked. RLS is enforcing, the upload path writes real bytes
 * through the real storage adapter, and every link runs in a real transaction.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/attachments
 *
 * ⚠️ EVERY ISOLATION TEST CARRIES A POSITIVE CONTROL.
 *
 * "The foreign raiser could not link it" passes just as happily when the
 * attachment was never created, when the id was wrong, or when the endpoint
 * rejects everyone. So each refusal below is paired with the SAME request
 * succeeding for the rightful owner, on the same id, in the same run.
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';
const RAISER_1 = 'kb-att-raiser-one';
const RAISER_2 = 'kb-att-raiser-two';

let app: Awaited<ReturnType<typeof buildServer>>;

const madeTickets: string[] = [];
const madeAttachments: string[] = [];

// ─────────────────────────────────────────────────────────────────────────
// Callers
// ─────────────────────────────────────────────────────────────────────────

/** Exactly the headers the gateway sets for a widget (raiser) call. */
const raiser = (productId: string, ref: string) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'x-iris-product-id': productId,
  'x-iris-role': 'raiser',
  'x-iris-raiser-ref': ref,
  'x-iris-tenant-id': 'tenant_att_test',
});

/** The headers the gateway sets for an authenticated support user. */
const admin = (role: string, scope: string, userId = 'su_att_test') => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': userId,
  'x-iris-role': role,
  'x-iris-scope': scope,
});

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** A structurally valid PNG header. Header-only is enough: nothing decodes it. */
function png(width = 800, height = 600): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const BOUNDARY = '----irisAttachmentTest';

function multipart(filename: string, contentType: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function upload(
  headers: Record<string, string>,
  filename: string,
  contentType: string,
  bytes: Buffer,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/attachments',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart(filename, contentType, bytes),
  });
  const body = res.statusCode === 201 ? res.json() : res.json();
  if (res.statusCode === 201) madeAttachments.push(body.id);
  return { status: res.statusCode, body };
}

async function createTicket(headers: Record<string, string>, subject: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({
      product_tenant_id: 'tenant_att_test',
      subject,
      description: `${subject} — created by the Phase 19 Step 1 attachment suite.`,
    }),
  });
  const body = res.json();
  if (res.statusCode === 201) madeTickets.push(body.id);
  return { status: res.statusCode, body };
}

const link = (headers: Record<string, string>, ticketId: string, ids: string[]) =>
  app.inject({
    method: 'POST',
    url: `/v1/tickets/${ticketId}/attachments`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ attachment_ids: ids }),
  });

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('att-test', fn);

const attachmentRow = (id: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{
      ticket_id: string | null;
      product_id: string;
      uploaded_by: string | null;
      content_type: string;
      blob_key: string;
    }>(
      `SELECT ticket_id, product_id, uploaded_by, content_type, blob_key
         FROM attachment WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });

const auditFor = (id: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM audit_event
        WHERE entity_type = 'attachment' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [id],
    );
    return rows;
  });

const linkEventsFor = (attachmentId: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{
      event_type: string;
      product_id: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      published_at: Date | null;
    }>(
      `SELECT event_type, product_id, aggregate_id, payload, published_at
         FROM event_outbox
        WHERE event_type = 'ticket.attachment_linked'
          AND payload->>'attachment_id' = $1`,
      [attachmentId],
    );
    return rows;
  });

/**
 * Teardown runs as the OWNER. `audit_event` has UPDATE and DELETE revoked from
 * `iris_app` by design, so the suite cannot remove its own audit rows through
 * the pool it tests with.
 */
const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  const client = new pg.Client({ connectionString: ADMIN_URL, application_name: 'iris-att-test' });
  await client.connect();
  try {
    if (madeAttachments.length) {
      await client.query(
        `DELETE FROM audit_event WHERE entity_type = 'attachment' AND entity_id = ANY($1)`,
        [madeAttachments],
      );
      await client.query(
        `DELETE FROM event_outbox WHERE event_type = 'ticket.attachment_linked'
           AND payload->>'attachment_id' = ANY($1)`,
        [madeAttachments],
      );
      await client.query(`DELETE FROM attachment WHERE id = ANY($1)`, [madeAttachments]);
    }
    if (madeTickets.length) {
      await client.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
      await client.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
      await client.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
    }
  } finally {
    await client.end();
  }
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// Upload-time content validation
// ═══════════════════════════════════════════════════════════════════════

describe('the upload endpoint now checks bytes against the declared type', () => {
  it('accepts a real PNG (the positive control)', async () => {
    const res = await upload(raiser(PRODUCT_A, RAISER_1), 'screenshot.png', 'image/png', png());
    expect(res.status).toBe(201);
    expect(res.body.content_type).toBe('image/png');
  });

  it('SEC-7 rejects arbitrary bytes declared as image/png', async () => {
    const res = await upload(
      raiser(PRODUCT_A, RAISER_1),
      'screenshot.png',
      'image/png',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    );
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('attachment_type_not_allowed');
  });

  it('SEC-8 rejects a corrupted PNG', async () => {
    const res = await upload(
      raiser(PRODUCT_A, RAISER_1),
      'broken.png',
      'image/png',
      png().subarray(0, 20),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('SEC-10 rejects an over-dimensioned image before it is stored', async () => {
    const res = await upload(raiser(PRODUCT_A, RAISER_1), 'bomb.png', 'image/png', png(225_000, 225_000));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('attachment_too_large');
  });

  it('SEC-10 rejects a pixel-count bomb whose axes each pass', async () => {
    const res = await upload(raiser(PRODUCT_A, RAISER_1), 'bomb2.png', 'image/png', png(19_000, 19_000));
    expect(19_000 * 19_000).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(res.status).toBe(413);
  });

  it('SEC-9 rejects a file over the byte limit', async () => {
    const oversized = Buffer.alloc(config.MAX_ATTACHMENT_BYTES + 1024, 0x41);
    const res = await upload(raiser(PRODUCT_A, RAISER_1), 'big.txt', 'text/plain', oversized);
    expect([413, 400]).toContain(res.status);
  });

  /**
   * Regression guard on the shared upload path. The new check must be a no-op
   * for everything that is not an image, or every PDF and CSV upload breaks.
   */
  it('a non-image attachment is unaffected', async () => {
    const res = await upload(
      raiser(PRODUCT_A, RAISER_1),
      'notes.txt',
      'text/plain',
      Buffer.from('plain text, definitely not an image'),
    );
    expect(res.status).toBe(201);
  });

  it('a rejected upload creates no attachment row', async () => {
    const before = await sys(async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) n FROM attachment`);
      return Number(rows[0]!.n);
    });
    await upload(raiser(PRODUCT_A, RAISER_1), 'x.png', 'image/png', Buffer.from('nope'));
    const after = await sys(async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) n FROM attachment`);
      return Number(rows[0]!.n);
    });
    expect(after).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Linking: ownership, audit, event
// ═══════════════════════════════════════════════════════════════════════

describe('linking enforces ownership and records what it did', () => {
  let ticketId: string;
  let ownAttachment: string;

  beforeAll(async () => {
    ticketId = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Attachment link suite')).body.id;
    ownAttachment = (await upload(raiser(PRODUCT_A, RAISER_1), 'own.png', 'image/png', png())).body.id;
  });

  it('an attachment starts unlinked', async () => {
    expect((await attachmentRow(ownAttachment))!.ticket_id).toBeNull();
  });

  it('SEC-1 the uploader can link their own attachment to their own ticket', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_1), ticketId, [ownAttachment]);
    expect(res.statusCode).toBe(200);
    expect(res.json().linked).toBe(1);
    expect((await attachmentRow(ownAttachment))!.ticket_id).toBe(ticketId);
  });

  it('SEC-5 the link wrote exactly one audit event', async () => {
    const rows = await auditFor(ownAttachment);
    const links = rows.filter((r) => r.action === 'attachment.linked');
    expect(links).toHaveLength(1);
    expect(links[0]!.before).toMatchObject({ ticket_id: null });
    expect(links[0]!.after).toMatchObject({ ticket_id: ticketId, content_type: 'image/png' });
  });

  it('SEC-14 the audit row carries no bytes, no base64 and no filename', async () => {
    const rows = await auditFor(ownAttachment);
    const text = JSON.stringify(rows.filter((r) => r.action === 'attachment.linked'));
    expect(text).not.toContain('own.png');
    expect(text).not.toContain('iVBOR'); // base64 PNG prefix
    expect(text).not.toContain('\\u0089PNG');
    expect(text.length).toBeLessThan(400);
  });

  it('the link emitted exactly one transactional outbox event', async () => {
    const events = await linkEventsFor(ownAttachment);
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_id).toBe(ticketId);
    expect(events[0]!.product_id).toBe(PRODUCT_A);
    expect(events[0]!.payload).toMatchObject({
      ticket_id: ticketId,
      attachment_id: ownAttachment,
      content_type: 'image/png',
    });
  });

  /**
   * The payload is the data boundary for a future Screenshot AI consumer. The
   * filename is customer-supplied text that routinely names an account or a
   * company; it has no place in an event a queue will carry.
   */
  it('the event payload carries no filename, raiser reference or blob key', async () => {
    const payload = JSON.stringify((await linkEventsFor(ownAttachment))[0]!.payload);
    expect(payload).not.toContain('own.png');
    expect(payload).not.toContain(RAISER_1);
    expect(payload).not.toContain('blob');
  });

  /**
   * ⚠️ NOTHING CONSUMES THIS EVENT YET, AND THAT IS THE CORRECT STATE.
   * The AI dispatcher reads AI_EVENT_FEATURES and the webhook publisher filters
   * to `access.*`. Step 1 must create the row without dispatching anything.
   */
  it('the event is not dispatched to any consumer in this step', async () => {
    expect((await linkEventsFor(ownAttachment))[0]!.published_at).toBeNull();
  });

  it('SEC-4 an already-linked attachment cannot be linked again', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_1), ticketId, [ownAttachment]);
    expect(res.statusCode).toBe(404);
    // And no second audit row or event was produced.
    expect((await auditFor(ownAttachment)).filter((r) => r.action === 'attachment.linked')).toHaveLength(1);
    expect(await linkEventsFor(ownAttachment)).toHaveLength(1);
  });

  it('SEC-4 it cannot be moved to a different ticket either', async () => {
    const other = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Second ticket')).body.id;
    const res = await link(raiser(PRODUCT_A, RAISER_1), other, [ownAttachment]);
    expect(res.statusCode).toBe(404);
    expect((await attachmentRow(ownAttachment))!.ticket_id).toBe(ticketId);
  });
});

describe('SEC-2 a raiser cannot link another raiser attachment', () => {
  let victimAttachment: string;
  let attackerTicket: string;
  let victimTicket: string;

  beforeAll(async () => {
    victimAttachment = (await upload(raiser(PRODUCT_A, RAISER_2), 'victim.png', 'image/png', png())).body.id;
    attackerTicket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Attacker ticket')).body.id;
    victimTicket = (await createTicket(raiser(PRODUCT_A, RAISER_2), 'Victim ticket')).body.id;
  });

  it('the attempt is refused as a not-found', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_1), attackerTicket, [victimAttachment]);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ticket_not_found');
  });

  it('and the attachment is still unlinked', async () => {
    expect((await attachmentRow(victimAttachment))!.ticket_id).toBeNull();
  });

  it('the refusal wrote no audit row and no event', async () => {
    expect((await auditFor(victimAttachment)).filter((r) => r.action === 'attachment.linked')).toHaveLength(0);
    expect(await linkEventsFor(victimAttachment)).toHaveLength(0);
  });

  it('the refusal does not reveal the other raiser', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_1), attackerTicket, [victimAttachment]);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain(RAISER_2);
    expect(text).not.toContain('victim.png');
  });

  /** THE POSITIVE CONTROL: the rightful owner links the very same attachment. */
  it('but the actual uploader can link it, on the same id', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_2), victimTicket, [victimAttachment]);
    expect(res.statusCode).toBe(200);
    expect((await attachmentRow(victimAttachment))!.ticket_id).toBe(victimTicket);
  });
});

describe('SEC-3 a foreign-product attachment cannot be linked', () => {
  let attachmentB: string;
  let ticketA: string;
  let ticketB: string;

  beforeAll(async () => {
    attachmentB = (await upload(raiser(PRODUCT_B, RAISER_1), 'esg.png', 'image/png', png())).body.id;
    ticketA = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Carbon ticket')).body.id;
    ticketB = (await createTicket(raiser(PRODUCT_B, RAISER_1), 'ESG ticket')).body.id;
  });

  it('product A cannot link product B attachment, even as the same raiser ref', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_1), ticketA, [attachmentB]);
    expect(res.statusCode).toBe(404);
    expect((await attachmentRow(attachmentB))!.ticket_id).toBeNull();
    expect((await attachmentRow(attachmentB))!.product_id).toBe(PRODUCT_B);
  });

  it('the refusal names neither the product nor the file', async () => {
    const res = await link(raiser(PRODUCT_A, RAISER_1), ticketA, [attachmentB]);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain(PRODUCT_B);
    expect(text).not.toContain('esg');
  });

  /** POSITIVE CONTROL: the owning product links the same attachment. */
  it('but product B can link it', async () => {
    const res = await link(raiser(PRODUCT_B, RAISER_1), ticketB, [attachmentB]);
    expect(res.statusCode).toBe(200);
    expect((await attachmentRow(attachmentB))!.ticket_id).toBe(ticketB);
  });
});

describe('SEC-6 the link, its audit and its event are one transaction', () => {
  /**
   * A batch containing one bad id must commit NOTHING — not the good link, not
   * its audit row, not its event. Before Phase 19 Step 1 the statement simply
   * skipped what it could not match and reported partial success.
   */
  it('a batch with one foreign attachment links none of them', async () => {
    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Batch rollback')).body.id;
    const good = (await upload(raiser(PRODUCT_A, RAISER_1), 'good.png', 'image/png', png())).body.id;
    const foreign = (await upload(raiser(PRODUCT_A, RAISER_2), 'foreign.png', 'image/png', png())).body.id;

    const res = await link(raiser(PRODUCT_A, RAISER_1), ticket, [good, foreign]);
    expect(res.statusCode).toBe(404);

    expect((await attachmentRow(good))!.ticket_id).toBeNull();
    expect((await attachmentRow(foreign))!.ticket_id).toBeNull();
    expect((await auditFor(good)).filter((r) => r.action === 'attachment.linked')).toHaveLength(0);
    expect(await linkEventsFor(good)).toHaveLength(0);
  });

  it('a batch of two valid attachments links both, with one event each', async () => {
    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Batch success')).body.id;
    const a = (await upload(raiser(PRODUCT_A, RAISER_1), 'a.png', 'image/png', png())).body.id;
    const b = (await upload(raiser(PRODUCT_A, RAISER_1), 'b.png', 'image/png', png())).body.id;

    const res = await link(raiser(PRODUCT_A, RAISER_1), ticket, [a, b]);
    expect(res.statusCode).toBe(200);
    expect(res.json().linked).toBe(2);

    for (const id of [a, b]) {
      expect((await attachmentRow(id))!.ticket_id).toBe(ticket);
      expect(await linkEventsFor(id)).toHaveLength(1);
      expect((await auditFor(id)).filter((r) => r.action === 'attachment.linked')).toHaveLength(1);
    }
  });

  it('an unknown attachment id links nothing', async () => {
    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Unknown id')).body.id;
    const res = await link(raiser(PRODUCT_A, RAISER_1), ticket, ['att_does_not_exist']);
    expect(res.statusCode).toBe(404);
  });

  it('a duplicated id in one request does not double-link or double-audit', async () => {
    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Duplicate id')).body.id;
    const a = (await upload(raiser(PRODUCT_A, RAISER_1), 'dupe.png', 'image/png', png())).body.id;
    const res = await link(raiser(PRODUCT_A, RAISER_1), ticket, [a, a]);
    expect(res.statusCode).toBe(200);
    expect(res.json().linked).toBe(1);
    expect(await linkEventsFor(a)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Agent attachment viewing
// ═══════════════════════════════════════════════════════════════════════

describe('an agent can open an attachment on a ticket in their scope', () => {
  let ticketA: string;
  let attachmentA: string;

  beforeAll(async () => {
    ticketA = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Agent viewing')).body.id;
    attachmentA = (await upload(raiser(PRODUCT_A, RAISER_1), 'view.png', 'image/png', png())).body.id;
    await link(raiser(PRODUCT_A, RAISER_1), ticketA, [attachmentA]);
  });

  const content = (hdrs: Record<string, string>, ticket: string, att: string) =>
    app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${ticket}/attachments/${att}/content`,
      headers: hdrs,
    });

  it('the admin ticket payload lists the attachment with its type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${ticketA}`,
      headers: admin('product_admin', PRODUCT_A),
    });
    expect(res.statusCode).toBe(200);
    const found = res.json().attachments.find((a: { id: string }) => a.id === attachmentA);
    expect(found).toBeDefined();
    expect(found.content_type).toBe('image/png');
  });

  it('an in-scope product admin receives the bytes', async () => {
    const res = await content(admin('product_admin', PRODUCT_A), ticketA, attachmentA);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 8)).toEqual(png().subarray(0, 8));
  });

  it('a manager receives them too', async () => {
    expect((await content(admin('manager', PRODUCT_A), ticketA, attachmentA)).statusCode).toBe(200);
  });

  /**
   * ⚠️ ZERO STANDING ACCESS, AND IT APPLIES TO THIS ROUTE FOR FREE.
   *
   * `attachment_isolation` (migration 008) gives an AGENT sight of a linked
   * attachment only while they hold an active platform grant on that ticket;
   * product_admin, manager and super_admin keep policy-level visibility. The
   * new endpoint inherits that because it reads through the same policy — it
   * adds no role logic of its own, and must not.
   *
   * This is asserted rather than assumed because it is the property most
   * likely to be "fixed" by someone who reads the 404 as a bug. An agent with
   * no grant seeing nothing is the design working.
   */
  it('an agent without an active grant is refused, which is the access model', async () => {
    const res = await content(admin('agent', PRODUCT_A, 'su_att_ungranted'), ticketA, attachmentA);
    expect(res.statusCode).toBe(404);
  });

  it('the response headers keep it from ever rendering inline', async () => {
    const res = await content(admin('product_admin', PRODUCT_A), ticketA, attachmentA);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain('sandbox');
  });

  it('SEC-13 no storage key or filesystem path is exposed', async () => {
    const row = (await attachmentRow(attachmentA))!;
    const detail = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${ticketA}`,
      headers: admin('product_admin', PRODUCT_A),
    });
    const text = detail.payload;
    expect(text).not.toContain(row.blob_key);
    expect(text).not.toContain('.data/attachments');
    expect(text).not.toContain('blob_key');
  });

  it('SEC-11 a foreign-product admin cannot read it', async () => {
    // Positive control first, on the same id, in the same run.
    expect((await content(admin('product_admin', PRODUCT_A), ticketA, attachmentA)).statusCode).toBe(200);
    const res = await content(admin('product_admin', PRODUCT_B), ticketA, attachmentA);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ticket_not_found');
  });

  it('SEC-11 the refusal reveals nothing about the owning product', async () => {
    const res = await content(admin('product_admin', PRODUCT_B), ticketA, attachmentA);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain(PRODUCT_A);
    expect(text).not.toContain('view.png');
  });

  it('SEC-12 an unauthenticated caller is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${ticketA}/attachments/${attachmentA}/content`,
      headers: { 'x-internal-key': config.INTERNAL_API_KEY },
    });
    expect(res.statusCode).toBe(401);
  });

  it('SEC-12 a support user with no tenant is refused', async () => {
    const res = await content(admin('product_admin', ''), ticketA, attachmentA);
    expect(res.statusCode).toBe(403);
  });

  /**
   * The attachment id alone must not be enough. Pairing it with a DIFFERENT
   * ticket the caller legitimately owns has to fail, or the nesting would be
   * decoration rather than a check.
   */
  it('the attachment id is not sufficient: it must match the ticket in the path', async () => {
    const otherTicket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Unrelated ticket')).body.id;
    const res = await content(admin('product_admin', PRODUCT_A), otherTicket, attachmentA);
    expect(res.statusCode).toBe(404);
  });

  it('an unlinked attachment is not reachable through any ticket', async () => {
    const orphan = (await upload(raiser(PRODUCT_A, RAISER_1), 'orphan.png', 'image/png', png())).body.id;
    const res = await content(admin('product_admin', PRODUCT_A), ticketA, orphan);
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Regression
// ═══════════════════════════════════════════════════════════════════════

describe('the existing flows still work', () => {
  it('A. a ticket with no attachment is created normally', async () => {
    const res = await createTicket(raiser(PRODUCT_A, RAISER_1), 'No attachment');
    expect(res.status).toBe(201);
    expect(res.body.reference).toBeTruthy();
  });

  it('F+G. upload before creation, link after — the real widget order', async () => {
    const att = (await upload(raiser(PRODUCT_A, RAISER_1), 'order.png', 'image/png', png())).body.id;
    expect((await attachmentRow(att))!.ticket_id).toBeNull();

    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Widget order')).body.id;
    expect((await link(raiser(PRODUCT_A, RAISER_1), ticket, [att])).statusCode).toBe(200);
    expect((await attachmentRow(att))!.ticket_id).toBe(ticket);
  });

  it('C+D+E. one ticket, several attachments, image and non-image together', async () => {
    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Mixed attachments')).body.id;
    const image = (await upload(raiser(PRODUCT_A, RAISER_1), 'shot.png', 'image/png', png())).body.id;
    const text = (await upload(raiser(PRODUCT_A, RAISER_1), 'log.txt', 'text/plain', Buffer.from('log line'))).body.id;

    const res = await link(raiser(PRODUCT_A, RAISER_1), ticket, [image, text]);
    expect(res.statusCode).toBe(200);
    expect(res.json().linked).toBe(2);
  });

  it('the /v1 download route still serves content with its original headers', async () => {
    const att = (await upload(raiser(PRODUCT_A, RAISER_1), 'v1.png', 'image/png', png())).body.id;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${att}/content`,
      headers: raiser(PRODUCT_A, RAISER_1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('ticket.created is still emitted, unchanged', async () => {
    const ticket = (await createTicket(raiser(PRODUCT_A, RAISER_1), 'Event regression')).body.id;
    const events = await sys(async (tx) => {
      const { rows } = await tx.query<{ event_type: string }>(
        `SELECT event_type FROM event_outbox WHERE aggregate_id = $1`,
        [ticket],
      );
      return rows.map((r) => r.event_type);
    });
    expect(events).toContain('ticket.created');
  });

  it('SEC-15 RLS is still enabled and forced on attachment', async () => {
    const row = await sys(async (tx) => {
      const { rows } = await tx.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'attachment'`,
      );
      return rows[0]!;
    });
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });
});

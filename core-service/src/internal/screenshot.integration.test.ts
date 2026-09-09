import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIJobClaims, AIResult } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withSystemScope, type Tx } from '../db/with-scope.js';
import { getAIInput, submitAIResult } from './ai.service.js';

/**
 * Screenshot AI through Core, against the REAL Postgres — Phase 19 Step 2.
 *
 * Drives Core's own internal AI service the way the worker does: `getAIInput`
 * then `submitAIResult`, against real rows, real RLS and the real attachment
 * that Step 1's linking endpoint produced. Nothing is mocked except the model
 * output, which is the one thing this file is about validating.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/internal/screenshot.integration.test.ts
 *
 * ⚠️ EVERY REFUSAL CARRIES A POSITIVE CONTROL. A foreign attachment producing
 * no execution proves nothing on its own — it passes when the fixture was never
 * created. Each one is paired with the rightful case succeeding in the same run.
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';
const RAISER = 'shot-test-raiser';

let app: Awaited<ReturnType<typeof buildServer>>;
const madeTickets: string[] = [];
const madeAttachments: string[] = [];

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const raiser = (productId: string, ref = RAISER) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'x-iris-product-id': productId,
  'x-iris-role': 'raiser',
  'x-iris-raiser-ref': ref,
  'x-iris-tenant-id': 'tenant_shot_test',
});

function png(width = 1280, height = 720): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const BOUNDARY = '----irisShotTest';

async function upload(productId: string, filename: string, type: string, bytes: Buffer, ref = RAISER) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/attachments',
    headers: { ...raiser(productId, ref), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  });
  const body = res.json();
  if (res.statusCode === 201) madeAttachments.push(body.id);
  return { status: res.statusCode, id: body.id as string };
}

async function ticket(productId: string, subject: string, ref = RAISER) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: { ...raiser(productId, ref), 'content-type': 'application/json' },
    payload: JSON.stringify({
      product_tenant_id: 'tenant_shot_test',
      subject,
      description: `${subject} — Phase 19 screenshot suite.`,
    }),
  });
  const body = res.json();
  if (res.statusCode === 201) madeTickets.push(body.id);
  return body.id as string;
}

const link = (productId: string, ticketId: string, ids: string[], ref = RAISER) =>
  app.inject({
    method: 'POST',
    url: `/v1/tickets/${ticketId}/attachments`,
    headers: { ...raiser(productId, ref), 'content-type': 'application/json' },
    payload: JSON.stringify({ attachment_ids: ids }),
  });

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('shot-test', fn);

/** The link event Step 1 emitted for this attachment. */
async function linkEvent(attachmentId: string) {
  return sys(async (tx) => {
    const { rows } = await tx.query<{ event_id: string; product_id: string; aggregate_id: string }>(
      `SELECT event_id, product_id, aggregate_id FROM event_outbox
        WHERE event_type = 'ticket.attachment_linked' AND payload->>'attachment_id' = $1`,
      [attachmentId],
    );
    return rows[0] ?? null;
  });
}

/** A full linked screenshot, ready to analyse. */
async function scenario(productId = PRODUCT_A, type = 'image/png', bytes = png()) {
  const t = await ticket(productId, 'Export shows an error banner');
  const a = await upload(productId, 'shot.png', type, bytes);
  const linked = await link(productId, t, [a.id]);
  expect(linked.statusCode).toBe(200);
  const ev = await linkEvent(a.id);
  expect(ev).not.toBeNull();
  return { ticketId: t, attachmentId: a.id, eventId: ev!.event_id, productId };
}

const claims = (s: { eventId: string; ticketId: string; productId: string }): AIJobClaims => ({
  job_id: `aij_shot_${Math.random().toString(36).slice(2, 10)}`,
  feature: 'screenshot',
  attempt: 1,
  correlation_id: `req_shot_${Math.random().toString(36).slice(2, 8)}`,
  claimed_product_id: s.productId,
  claimed_ticket_id: s.ticketId,
});

const modelOutput = (over: Record<string, unknown> = {}) => ({
  observations: [{ type: 'error_code', value: 'ERR_QUOTA_EXCEEDED' }],
  problem_hint: { domain: 'reports', category: 'export' },
  possible_causes: ['The account exceeded its export quota.'],
  suggested_next_steps: ['Check the quota on the billing screen.'],
  confidence: 0.55,
  ...over,
});

const succeeded = (data: Record<string, unknown>): AIResult => ({
  feature: 'screenshot',
  status: 'succeeded',
  data,
  confidence: typeof data.confidence === 'number' ? data.confidence : null,
  provider: 'azure',
  model: 'azure/gpt-4.1',
  model_version: '2024-12-01-preview',
  prompt_version: 'screenshot-v1',
  latency_ms: 1234,
  fallback_used: false,
});

const execution = (eventId: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      result: Record<string, unknown> | null;
      error_code: string | null;
      confidence: string | null;
      model: string | null;
      prompt_version: string | null;
      attempt: number;
    }>(
      `SELECT id, status, result, error_code, confidence, model, prompt_version, attempt
         FROM ai_execution WHERE event_id = $1 AND feature = 'screenshot'`,
      [eventId],
    );
    return rows[0] ?? null;
  });

const ticketRow = (id: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query(
      `SELECT status, severity, category, assignee_id, summary, sentiment,
              classification_source, resolved_at, closed_at, first_response_at
         FROM ticket WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  const c = new pg.Client({ connectionString: ADMIN_URL, application_name: 'iris-shot-test' });
  await c.connect();
  try {
    if (madeAttachments.length) {
      await c.query(`DELETE FROM audit_event WHERE entity_type='attachment' AND entity_id = ANY($1)`, [madeAttachments]);
      await c.query(`DELETE FROM attachment WHERE id = ANY($1)`, [madeAttachments]);
    }
    if (madeTickets.length) {
      await c.query(`DELETE FROM ai_execution WHERE ticket_id = ANY($1)`, [madeTickets]);
      await c.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1)`, [madeTickets]);
      await c.query(`DELETE FROM audit_event WHERE entity_id = ANY($1)`, [madeTickets]);
      await c.query(`DELETE FROM ticket WHERE id = ANY($1)`, [madeTickets]);
    }
  } finally {
    await c.end();
  }
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-1 the rightful path
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-1 a rightful attachment produces an execution and a stored result', () => {
  it('Core hands the worker the image, and only the image', async () => {
    const s = await scenario();
    const input = await getAIInput(s.eventId, claims(s));

    expect(input.status).toBe('ready');
    if (input.status !== 'ready') return;
    expect(input.feature).toBe('screenshot');
    expect(input.image).toBeDefined();
    expect(input.image!.content_type).toBe('image/png');
    expect(Buffer.from(input.image!.base64, 'base64').subarray(0, 8)).toEqual(png().subarray(0, 8));

    /**
     * ⚠️ THE DATA BOUNDARY. Bytes and type, and nothing that could attribute
     * the image to a tenant. Python cannot mix two tenants' images up because
     * it is never told which tenant it is holding.
     */
    const keys = Object.keys(input.image!).sort();
    expect(keys).toEqual(['base64', 'content_type']);
  });

  it('a validated result is persisted and stamped with the attachment id', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    const applied = await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    expect(applied.status).toBe('succeeded');
    expect(applied.applied).toBe(true);

    const row = await execution(s.eventId);
    expect(row!.status).toBe('succeeded');
    expect(row!.model).toBe('azure/gpt-4.1');
    expect(row!.prompt_version).toBe('screenshot-v1');
    // The model's self-reported signal, range-checked by Core and stored in the
    // column so screenshot executions stay comparable in the operational view.
    expect(Number(row!.confidence)).toBeCloseTo(0.55);
    expect(row!.result!.screenshot_attachment_id).toBe(s.attachmentId);
    expect((row!.result!.observations as unknown[])[0]).toMatchObject({ type: 'error_code' });
  });

  /**
   * ⚠️ SEC-13 AS AN OBSERVED PROPERTY, not an argument about types. Every
   * operational field is compared before and after a SUCCESSFUL analysis.
   */
  it('SEC-13 a successful analysis mutates no operational ticket field', async () => {
    const s = await scenario();
    const before = await ticketRow(s.ticketId);

    await getAIInput(s.eventId, claims(s));
    const applied = await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });
    expect(applied.status).toBe('succeeded');
    expect(applied.ticket_updated).toBe(false);

    expect(await ticketRow(s.ticketId)).toEqual(before);
  });

  it('SEC-8 the stored result contains no image, base64 or blob key', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    const row = await execution(s.eventId);
    const text = JSON.stringify(row!.result);
    expect(text).not.toContain('base64');
    expect(text).not.toContain('iVBOR');
    expect(text).not.toContain('blob');
    expect(text).not.toContain('shot.png');
    // The whole row, not just the result column.
    expect(JSON.stringify(row)).not.toContain('iVBOR');
  });

  it('SEC-9 the audit trail carries no image bytes either', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    const audit = await sys(async (tx) => {
      const { rows } = await tx.query(
        `SELECT action, before, after FROM audit_event WHERE after->>'ticket_id' = $1 OR entity_id = $1`,
        [s.ticketId],
      );
      return JSON.stringify(rows);
    });
    expect(audit).not.toContain('iVBOR');
    expect(audit).not.toContain('base64');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Authorization
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-2 and SEC-3 attachment authorization', () => {
  it('SEC-3 an attachment on another ticket is not analysed', async () => {
    const good = await scenario();
    const other = await scenario();

    // Positive control: the rightful pairing works.
    expect((await getAIInput(good.eventId, claims(good))).status).toBe('ready');

    /**
     * Re-point the event at an attachment belonging to a DIFFERENT ticket in
     * the SAME product. RLS cannot help here — both rows are in scope — so this
     * proves the `ticket_id` predicate in `resolveScreenshotImage` is what
     * refuses it.
     */
    await sys((tx) =>
      tx.query(
        `UPDATE event_outbox SET payload = jsonb_set(payload, '{attachment_id}', to_jsonb($2::text))
          WHERE event_id = $1`,
        [good.eventId, other.attachmentId],
      ),
    );

    const input = await getAIInput(good.eventId, claims(good));
    expect(input.status).toBe('already_applied');
    const row = await execution(good.eventId);
    expect(row!.status).toBe('failed');
    expect(row!.error_code).toBe('attachment_not_found');
  });

  it('SEC-2 an attachment in another product is not analysed', async () => {
    const a = await scenario(PRODUCT_A);
    const b = await scenario(PRODUCT_B);

    await sys((tx) =>
      tx.query(
        `UPDATE event_outbox SET payload = jsonb_set(payload, '{attachment_id}', to_jsonb($2::text))
          WHERE event_id = $1`,
        [a.eventId, b.attachmentId],
      ),
    );

    const input = await getAIInput(a.eventId, claims(a));
    expect(input.status).toBe('already_applied');
    expect((await execution(a.eventId))!.error_code).toBe('attachment_not_found');
    // And product B's own attachment is untouched and still analysable.
    expect((await getAIInput(b.eventId, claims(b))).status).toBe('ready');
  });

  it('SEC-7 an event naming no attachment fails without touching storage', async () => {
    const s = await scenario();
    await sys((tx) =>
      tx.query(`UPDATE event_outbox SET payload = payload - 'attachment_id' WHERE event_id = $1`, [
        s.eventId,
      ]),
    );
    const input = await getAIInput(s.eventId, claims(s));
    expect(input.status).toBe('already_applied');
    expect((await execution(s.eventId))!.error_code).toBe('invalid_input');
  });

  /**
   * ⚠️ THERE IS NO FIELD TO ATTACK. `AIJob` and `AIJobClaims` carry no
   * attachment, path or URL, so a malicious worker has nothing to supply: the
   * id comes from Core's own outbox row. This asserts that absence rather than
   * trying to exploit it.
   */
  it('SEC-7 the job contract has no attachment, path or URL field', () => {
    const c = claims({ eventId: 'e', ticketId: 't', productId: 'p' });
    const fields = Object.keys(c);
    for (const forbidden of ['attachment_id', 'blob_key', 'path', 'url', 'file']) {
      expect(fields).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Eligibility and bounds
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-4 SEC-5 SEC-6 nothing ineligible reaches the provider', () => {
  it('SEC-4 a non-image attachment is refused as unsupported, permanently', async () => {
    const t = await ticket(PRODUCT_A, 'Log file attached');
    const a = await upload(PRODUCT_A, 'log.txt', 'text/plain', Buffer.from('a log line'));
    expect((await link(PRODUCT_A, t, [a.id])).statusCode).toBe(200);
    const ev = await linkEvent(a.id);

    const input = await getAIInput(ev!.event_id, {
      ...claims({ eventId: ev!.event_id, ticketId: t, productId: PRODUCT_A }),
    });
    expect(input.status).toBe('already_applied');
    expect((await execution(ev!.event_id))!.error_code).toBe('unsupported_media_type');
  });

  it('SEC-4 GIF is a valid attachment but not a screenshot format', async () => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(400, 6);
    gif.writeUInt16LE(300, 8);

    const t = await ticket(PRODUCT_A, 'Animated capture');
    const a = await upload(PRODUCT_A, 'clip.gif', 'image/gif', gif);
    expect(a.status).toBe(201); // it uploads fine
    expect((await link(PRODUCT_A, t, [a.id])).statusCode).toBe(200);
    const ev = await linkEvent(a.id);

    const input = await getAIInput(ev!.event_id, {
      ...claims({ eventId: ev!.event_id, ticketId: t, productId: PRODUCT_A }),
    });
    expect(input.status).toBe('already_applied');
    expect((await execution(ev!.event_id))!.error_code).toBe('unsupported_media_type');
  });

  it('SEC-5 bytes that do not match the recorded type are refused', async () => {
    const s = await scenario();
    // Corrupt the stored object behind the row's back, simulating a storage
    // swap or a row/object mismatch. The upload check cannot catch this.
    const key = await sys(async (tx) => {
      const { rows } = await tx.query<{ blob_key: string }>(
        `SELECT blob_key FROM attachment WHERE id = $1`,
        [s.attachmentId],
      );
      return rows[0]!.blob_key;
    });
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { resolveFromRoot } = await import('@iris/shared/types');
    await writeFile(path.resolve(resolveFromRoot(config.STORAGE_LOCAL_PATH), key), Buffer.from('not a png'));

    const input = await getAIInput(s.eventId, claims(s));
    expect(input.status).toBe('already_applied');
    expect((await execution(s.eventId))!.error_code).toBe('invalid_input');
  });

  it('SEC-6 an image over the VISION dimension bound is refused before dispatch', async () => {
    // Within Step 1's storage bound (20000/50 MP) but over the vision bound.
    const big = png(15_000, 2_000);
    const t = await ticket(PRODUCT_A, 'Very wide screenshot');
    const a = await upload(PRODUCT_A, 'wide.png', 'image/png', big);
    expect(a.status).toBe(201); // storage accepts it
    expect((await link(PRODUCT_A, t, [a.id])).statusCode).toBe(200);
    const ev = await linkEvent(a.id);

    const input = await getAIInput(ev!.event_id, {
      ...claims({ eventId: ev!.event_id, ticketId: t, productId: PRODUCT_A }),
    });
    expect(input.status).toBe('already_applied');
    expect((await execution(ev!.event_id))!.error_code).toBe('image_too_large');
  });

  it('an ineligible attachment leaves the ticket completely healthy', async () => {
    const t = await ticket(PRODUCT_A, 'Healthy after a skip');
    const before = await ticketRow(t);
    const a = await upload(PRODUCT_A, 'notes.csv', 'text/csv', Buffer.from('a,b\n1,2'));
    await link(PRODUCT_A, t, [a.id]);
    const ev = await linkEvent(a.id);
    await getAIInput(ev!.event_id, {
      ...claims({ eventId: ev!.event_id, ticketId: t, productId: PRODUCT_A }),
    });
    expect(await ticketRow(t)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Idempotency and failure
// ═══════════════════════════════════════════════════════════════════════

describe('idempotency and failure handling', () => {
  it('a duplicate job is short-circuited with no second analysis', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    // A redelivery: Core answers before the worker would ever call Python.
    const again = await getAIInput(s.eventId, claims(s));
    expect(again.status).toBe('already_applied');
    if (again.status === 'already_applied') expect(again.execution_status).toBe('succeeded');

    const rows = await sys(async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) n FROM ai_execution WHERE event_id = $1 AND feature = 'screenshot'`,
        [s.eventId],
      );
      return Number(rows[0]!.n);
    });
    expect(rows).toBe(1);
  });

  it('a duplicate result does not overwrite the first', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    const second = await submitAIResult(s.eventId, {
      ...claims(s),
      result: succeeded(modelOutput({ confidence: 0.99 })),
    });
    expect(second.applied).toBe(false);
    expect(Number((await execution(s.eventId))!.confidence)).toBeCloseTo(0.55);
  });

  it('SEC-11 malformed model output is recorded as a failure, not persisted', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    const applied = await submitAIResult(s.eventId, {
      ...claims(s),
      result: succeeded({ observations: 'not an array' }),
    });
    expect(applied.status).toBe('failed');

    const row = await execution(s.eventId);
    expect(row!.status).toBe('failed');
    expect(row!.error_code).toBe('invalid_ai_output');
    expect(row!.result).toBeNull();
  });

  it('SEC-13 a result attempting a decision field is rejected with its own code', async () => {
    const s = await scenario();
    const before = await ticketRow(s.ticketId);
    await getAIInput(s.eventId, claims(s));

    const applied = await submitAIResult(s.eventId, {
      ...claims(s),
      result: succeeded(modelOutput({ severity: 'critical', priority: 'p1' })),
    });
    expect(applied.status).toBe('failed');

    const row = await execution(s.eventId);
    expect(row!.error_code).toBe('screenshot_decision_field');
    expect(row!.result).toBeNull();
    // The ticket is byte-identical: nothing was applied.
    expect(await ticketRow(s.ticketId)).toEqual(before);
  });

  it('a provider failure is recorded and the ticket is untouched', async () => {
    const s = await scenario();
    const before = await ticketRow(s.ticketId);
    await getAIInput(s.eventId, claims(s));

    const applied = await submitAIResult(s.eventId, {
      ...claims(s),
      result: {
        feature: 'screenshot',
        status: 'failed',
        data: {},
        error: { kind: 'temporary', code: 'provider_http_429', message: 'rate limited' },
      },
    });
    expect(applied.status).toBe('failed');
    expect((await execution(s.eventId))!.error_code).toBe('provider_http_429');
    expect(await ticketRow(s.ticketId)).toEqual(before);
  });

  it('a claim naming the wrong ticket is refused', async () => {
    const s = await scenario();
    const other = await scenario();
    await expect(
      getAIInput(s.eventId, { ...claims(s), claimed_ticket_id: other.ticketId }),
    ).rejects.toThrow();
  });

  it('a claim naming the wrong product is refused', async () => {
    const s = await scenario();
    await expect(
      getAIInput(s.eventId, { ...claims(s), claimed_product_id: PRODUCT_B }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The agent-facing read
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-15 the agent read is product-scoped and image-free', () => {
  const admin = (role: string, scope: string) => ({
    'x-internal-key': config.INTERNAL_API_KEY,
    'content-type': 'application/json',
    'x-iris-support-user-id': 'su_shot_test',
    'x-iris-role': role,
    'x-iris-scope': scope,
  });

  it('the owning product sees the interpretation; the other sees no ticket at all', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    const mine = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${s.ticketId}`,
      headers: admin('product_admin', PRODUCT_A),
    });
    expect(mine.statusCode).toBe(200);
    const shots = mine.json().screenshot_ai;
    expect(shots).toHaveLength(1);
    expect(shots[0].attachment_id).toBe(s.attachmentId);
    expect(shots[0].status).toBe('succeeded');
    expect(shots[0].interpretation.observations[0].value).toBe('ERR_QUOTA_EXCEEDED');
    // The stamped id is presented separately, never inside the interpretation.
    expect(shots[0].interpretation.screenshot_attachment_id).toBeUndefined();

    const theirs = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${s.ticketId}`,
      headers: admin('product_admin', PRODUCT_B),
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('SEC-10 the payload carries no image bytes and no error prose', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${s.ticketId}`,
      headers: admin('product_admin', PRODUCT_A),
    });
    const shots = JSON.stringify(res.json().screenshot_ai);
    expect(shots).not.toContain('iVBOR');
    expect(shots).not.toContain('base64');
    expect(shots).not.toContain('blob_key');
    expect(shots).not.toContain('error_message');
  });

  it('a failed analysis is shown as failed rather than hidden', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded({ observations: 'bad' }) });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${s.ticketId}`,
      headers: admin('product_admin', PRODUCT_A),
    });
    const shots = res.json().screenshot_ai;
    expect(shots[0].status).toBe('failed');
    expect(shots[0].error_code).toBe('invalid_ai_output');
    expect(shots[0].interpretation).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-23 / SEC-24 / SEC-25 — a credential the model returns is never stored,
// never served and never logged. Phase 19 Step 3.
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-23 to SEC-25 credential material never reaches storage, the API or a log', () => {
  /**
   * ⚠️ ALL SYNTHETIC. Never valid, never issued, and deliberately malformed
   * past the recognisable prefix. Testing a redactor with a live token would be
   * the exact mistake the redactor exists to prevent.
   */
  const BEARER = 'AbCdEf1234567890GhIjKlMnOpQrStUv';
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  const APIKEY = 'Kj28sHqLm93Xn4ZpRt5Vw7Yb1Dc6Fg';

  /** What a model would return if it ignored the prompt entirely. */
  const leaky = () => ({
    observations: [
      { type: 'error_message', value: `Authorization: Bearer ${BEARER}` },
      { type: 'other', value: `Session cookie ${JWT}` },
    ],
    problem_hint: { domain: `api_key=${APIKEY}`, category: 'auth' },
    possible_causes: [`The screen displayed api_key=${APIKEY}`],
    suggested_next_steps: [`Rotate the key shown as Bearer ${BEARER}`],
    confidence: 0.4,
  });

  const admin = (role: string, scope: string) => ({
    'x-internal-key': config.INTERNAL_API_KEY,
    'content-type': 'application/json',
    'x-iris-support-user-id': 'su_shot_redact',
    'x-iris-role': role,
    'x-iris-scope': scope,
  });

  it('SEC-23 the persisted ai_execution.result contains no secret', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    const applied = await submitAIResult(s.eventId, { ...claims(s), result: succeeded(leaky()) });

    // It SUCCEEDS — redaction sanitises, it does not reject a valid shape.
    expect(applied.status).toBe('succeeded');

    const row = await execution(s.eventId);
    const stored = JSON.stringify(row!.result);
    expect(stored).not.toContain(BEARER);
    expect(stored).not.toContain(JWT);
    expect(stored).not.toContain(APIKEY);
    expect(stored).toContain('[REDACTED_SECRET]');

    // And the whole row, not only the result column.
    const whole = JSON.stringify(row);
    expect(whole).not.toContain(BEARER);
    expect(whole).not.toContain(JWT);
    expect(whole).not.toContain(APIKEY);
  });

  it('SEC-24 the agent API response contains no secret', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(leaky()) });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/tickets/${s.ticketId}`,
      headers: admin('product_admin', PRODUCT_A),
    });
    expect(res.statusCode).toBe(200);

    // The WHOLE payload, not just the screenshot section: a leak anywhere in
    // the response is a leak.
    const payload = res.payload;
    expect(payload).not.toContain(BEARER);
    expect(payload).not.toContain(JWT);
    expect(payload).not.toContain(APIKEY);
    expect(JSON.stringify(res.json().screenshot_ai)).toContain('[REDACTED_SECRET]');
  });

  /**
   * SEC-25. The redactor and the validator import no logger, so there is no
   * code path that could write a secret. This asserts that at RUNTIME rather
   * than by reading the imports: every byte the process writes to stdout and
   * stderr during the validate-and-persist call is captured and searched.
   */
  it('SEC-25 nothing written to the logs during sanitization contains a secret', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));

    const captured: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    const tap =
      (real: typeof realOut) =>
      (chunk: unknown, ...rest: unknown[]): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
      };

    process.stdout.write = tap(realOut) as typeof process.stdout.write;
    process.stderr.write = tap(realErr) as typeof process.stderr.write;
    try {
      await submitAIResult(s.eventId, { ...claims(s), result: succeeded(leaky()) });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }

    const logs = captured.join('');
    expect(logs).not.toContain(BEARER);
    expect(logs).not.toContain(JWT);
    expect(logs).not.toContain(APIKEY);
  });

  it('a rejected leaky payload still leaks nothing through its error message', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));

    // Same secrets, plus a decision field so the whole result is refused.
    const applied = await submitAIResult(s.eventId, {
      ...claims(s),
      result: succeeded({ ...leaky(), severity: 'critical' }),
    });
    expect(applied.status).toBe('failed');

    const row = await execution(s.eventId);
    expect(row!.error_code).toBe('screenshot_decision_field');
    expect(row!.result).toBeNull();
    const whole = JSON.stringify(row);
    expect(whole).not.toContain(BEARER);
    expect(whole).not.toContain(APIKEY);
  });

  it('SEC-21 a clean interpretation is stored byte-identical', async () => {
    const s = await scenario();
    await getAIInput(s.eventId, claims(s));
    await submitAIResult(s.eventId, { ...claims(s), result: succeeded(modelOutput()) });

    const row = await execution(s.eventId);
    // ERR_QUOTA_EXCEEDED must survive the redactor untouched.
    expect((row!.result!.observations as Array<{ value: string }>)[0]!.value).toBe(
      'ERR_QUOTA_EXCEEDED',
    );
    expect(JSON.stringify(row!.result)).not.toContain('[REDACTED_SECRET]');
  });
});

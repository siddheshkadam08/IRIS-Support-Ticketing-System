import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope } from '../db/with-scope.js';

/**
 * Integration tests for the Core half of the AI pipeline, against the REAL
 * Postgres from infra/podman-compose.yml.
 *
 * Nothing here is mocked. RLS is genuinely enforcing, the unique constraint is
 * genuinely the thing preventing duplicate application, and the tickets are
 * created through the real POST /v1/tickets route — so the outbox events under
 * test are the same ones production would produce.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/internal
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

/**
 * buildServer() passes a concrete pino instance, which narrows Fastify's logger
 * generic away from FastifyBaseLogger — the same clash http/errors.ts documents.
 * Deriving the type from the function keeps full type safety without `any`.
 */
let app: Awaited<ReturnType<typeof buildServer>>;

const internal = (extra: Record<string, string> = {}) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  ...extra,
});

const productHeaders = (productId: string) =>
  internal({
    'x-iris-product-id': productId,
    'x-iris-role': 'product',
    'x-iris-tenant-id': 'tenant_ai_test',
  });

interface Created {
  ticketId: string;
  eventId: string;
  productId: string;
}

/** Create a ticket the real way, then read back the outbox event it emitted. */
async function createTicket(
  productId: string,
  description = 'Cannot export the Q3 emissions report.',
): Promise<Created> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: productHeaders(productId),
    payload: { subject: 'Q3 export fails', description },
  });
  expect(res.statusCode, res.body).toBe(201);
  const ticketId = res.json().id as string;

  const eventId = await withSystemScope('test', async (tx) => {
    const { rows } = await tx.query<{ event_id: string }>(
      `SELECT event_id FROM event_outbox
        WHERE aggregate_id = $1 AND event_type = 'ticket.created'`,
      [ticketId],
    );
    return rows[0]!.event_id;
  });

  return { ticketId, eventId, productId };
}

const claims = (c: Created, over: Record<string, unknown> = {}) => ({
  job_id: newId('aij'),
  feature: 'noop',
  attempt: 1,
  correlation_id: `req_test_${Date.now()}`,
  claimed_product_id: c.productId,
  claimed_ticket_id: c.ticketId,
  ...over,
});


/**
 * Phase 2: /internal/* is authenticated with a per-service HMAC signature
 * instead of the platform-wide INTERNAL_API_KEY. Only the AUTH MECHANISM
 * changed here — every business assertion below is the Phase 1 original.
 */
function signed(path: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  return {
    'content-type': 'application/json',
    'x-iris-service-id': 'worker',
    'x-iris-timestamp': String(timestamp),
    'x-iris-nonce': nonce,
    'x-iris-signature': requestSignatureHeader(config.AI_WORKER_HMAC_SECRET, {
      method: 'POST',
      path,
      timestamp,
      nonce,
      body,
    }),
  };
}

/** Serialise once, sign those bytes, send those bytes. */
const postSigned = (eventId: string, kind: 'input' | 'result', body: unknown) => {
  const path = `/internal/ai/jobs/${eventId}/${kind}`;
  const serialised = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, headers: signed(path, serialised), payload: serialised });
};

const postInput = (eventId: string, body: unknown) => postSigned(eventId, 'input', body);
const postResult = (eventId: string, body: unknown) => postSigned(eventId, 'result', body);

const noopResult = (chars = 38, over: Record<string, unknown> = {}) => ({
  feature: 'noop',
  status: 'succeeded',
  data: { ok: true, received_chars: chars },
  provider: 'stub',
  model: 'stub-noop',
  model_version: '1',
  latency_ms: 3,
  fallback_used: false,
  ...over,
});

const readExecution = (eventId: string) =>
  withSystemScope('test', async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM ai_execution WHERE event_id = $1 AND feature = 'noop'`,
      [eventId],
    );
    return rows[0] ?? null;
  });

const countAudit = (ticketId: string) =>
  withSystemScope('test', async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE entity_id = $1 AND action LIKE 'ai.%'`,
      [ticketId],
    );
    return Number(rows[0]!.n);
  });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

// ─────────────────────────────────────────────────────────────────────────

describe('input endpoint — identity is resolved from Core data', () => {
  it('returns AI input for a genuine event', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await postInput(t.eventId, claims(t));

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.feature).toBe('noop');
    expect(body.ticket.ticket_id).toBe(t.ticketId);
    expect(body.ticket.description).toBe('Cannot export the Q3 emissions report.');
    expect(body.ticket.subject).toBe('Q3 export fails');
  });

  it('supplies the product taxonomy so Python never duplicates it', async () => {
    const t = await createTicket(PRODUCT_A);
    const body = (await postInput(t.eventId, claims(t))).json();

    expect(Array.isArray(body.taxonomy.categories)).toBe(true);
    expect(body.taxonomy.categories.length).toBeGreaterThan(0);
    expect(body.taxonomy.categories[0]).toHaveProperty('value');
    expect(body.taxonomy.severities).toContain('critical');
  });

  it('falls back to the ADR-005 default thresholds when the product sets none', async () => {
    // Verified against the live database: ai_thresholds is null on every
    // seeded product, so the defaults are what actually ships today.
    const t = await createTicket(PRODUCT_A);
    const body = (await postInput(t.eventId, claims(t))).json();
    expect(body.thresholds).toEqual({
      auto_route_p1: 0.8,
      auto_route_margin: 0.25,
      triage_floor: 0.5,
    });
  });

  it('creates a running ai_execution row keyed on the event', async () => {
    const t = await createTicket(PRODUCT_A);
    await postInput(t.eventId, claims(t));

    const row = await readExecution(t.eventId);
    expect(row).not.toBeNull();
    expect(row.status).toBe('running');
    expect(row.product_id).toBe(PRODUCT_A);
    expect(row.ticket_id).toBe(t.ticketId);
    expect(row.completed_at).toBeNull();
  });

  it('leaks nothing beyond subject, description and the label set', async () => {
    const t = await createTicket(PRODUCT_A);
    const raw = (await postInput(t.eventId, claims(t))).body;

    // The SELECT list in ai.service.ts is the boundary; this asserts it held.
    for (const forbidden of [
      'raiser_identity',
      'raised_by_ref',
      'product_tenant_id',
      'identity_assurance',
      'tenant_ai_test',
      'reference',
      PRODUCT_A,
    ]) {
      expect(raw, `AI input must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('input endpoint — rejections', () => {
  it('404s an event that does not exist', async () => {
    const fake = newId('evt');
    const res = await postInput(fake, {
      job_id: newId('aij'),
      feature: 'noop',
      attempt: 1,
      correlation_id: 'req_x',
      claimed_product_id: PRODUCT_A,
      claimed_ticket_id: 'tkt_whatever',
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a mismatched product claim', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await postInput(t.eventId, claims(t, { claimed_product_id: PRODUCT_B }));

    expect(res.statusCode).toBe(400);
    // The rejection must not become an oracle for the real product id.
    expect(res.body).not.toContain(PRODUCT_A);
    expect(await readExecution(t.eventId), 'nothing may be written').toBeNull();
  });

  it('400s a mismatched ticket claim', async () => {
    const t = await createTicket(PRODUCT_A);
    const other = await createTicket(PRODUCT_A);
    const res = await postInput(t.eventId, claims(t, { claimed_ticket_id: other.ticketId }));

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(t.ticketId);
  });

  it('400s a feature that is declared but not built in this phase', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await postInput(t.eventId, claims(t, { feature: 'classification' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('400s a feature outside the contract entirely', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await postInput(t.eventId, claims(t, { feature: 'telepathy' }));
    expect(res.statusCode).toBe(400);
  });

  it('400s a structurally invalid body', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await postInput(t.eventId, { feature: 'noop' });
    expect(res.statusCode).toBe(400);
  });
});

describe('result endpoint — validation and persistence', () => {
  it('records a validated success and writes exactly one audit row', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);

    const res = await postResult(t.eventId, { ...c, result: noopResult() });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json();
    expect(body.status).toBe('succeeded');
    expect(body.applied).toBe(true);
    expect(body.ticket_updated).toBe(false);

    const row = await readExecution(t.eventId);
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ ok: true, received_chars: 38 });
    expect(row.model).toBe('stub-noop');
    expect(row.model_version).toBe('1');
    expect(row.completed_at).not.toBeNull();
    expect(await countAudit(t.ticketId)).toBe(1);
  });

  it('rejects malformed model output as a PERMANENT execution failure, not a 4xx', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);

    // `ok` missing: the worker's message was fine, the MODEL was wrong.
    // A 4xx here would send the worker into a pointless retry loop.
    const res = await postResult(t.eventId, {
      ...c,
      result: { ...noopResult(), data: { received_chars: 5 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('failed');
    expect(res.json().applied).toBe(true);

    const row = await readExecution(t.eventId);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('invalid_ai_output');
    expect(row.result, 'an invalid result must not be persisted').toBeNull();
  });

  it('rejects a negative char count', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);
    await postResult(t.eventId, {
      ...c,
      result: { ...noopResult(), data: { ok: true, received_chars: -3 } },
    });
    expect((await readExecution(t.eventId)).status).toBe('failed');
  });

  it('records a failure the AI service itself reported', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);

    await postResult(t.eventId, {
      ...c,
      result: {
        feature: 'noop',
        status: 'failed',
        data: {},
        error: { kind: 'permanent', code: 'invalid_input', message: 'description empty' },
      },
    });

    const row = await readExecution(t.eventId);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('invalid_input');
  });

  it('400s when the result feature disagrees with the job feature', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);
    const res = await postResult(t.eventId, {
      ...c,
      result: { ...noopResult(), feature: 'summary' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s a result for an event that does not exist', async () => {
    const res = await postResult(newId('evt'), {
      job_id: newId('aij'),
      feature: 'noop',
      attempt: 1,
      correlation_id: 'req_x',
      claimed_product_id: PRODUCT_A,
      claimed_ticket_id: 'tkt_x',
      result: noopResult(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('the ticket is not touched by noop', () => {
  const snapshot = (ticketId: string) =>
    withSystemScope('test', async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM ticket WHERE id = $1`, [ticketId]);
      return rows[0];
    });

  it('leaves every column identical after a SUCCESSFUL execution', async () => {
    const t = await createTicket(PRODUCT_A);
    const before = await snapshot(t.ticketId);

    const c = claims(t);
    await postInput(t.eventId, c);
    await postResult(t.eventId, { ...c, result: noopResult() });

    expect(await snapshot(t.ticketId)).toEqual(before);
  });

  it('leaves every column identical after a FAILED execution', async () => {
    const t = await createTicket(PRODUCT_A);
    const before = await snapshot(t.ticketId);

    const c = claims(t);
    await postInput(t.eventId, c);
    await postResult(t.eventId, {
      ...c,
      result: { ...noopResult(), data: { nonsense: true } },
    });

    const after = await snapshot(t.ticketId);
    expect(after).toEqual(before);
    // Stated explicitly because these are the columns a later phase will write,
    // and a regression here would silently change business behaviour.
    expect(after.classification_source).toBe('unclassified');
    expect(after.ai_classification).toBeNull();
    expect(after.summary).toBeNull();
    expect(after.sentiment).toBeNull();
    expect(after.status).toBe('open');
  });
});

describe('idempotency', () => {
  it('a second result for a terminal execution changes nothing', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);

    const first = await postResult(t.eventId, { ...c, result: noopResult(38) });
    expect(first.json().applied).toBe(true);

    // Same event, NEW job id — exactly what a re-dispatch produces.
    const second = await postResult(t.eventId, {
      ...claims(t),
      result: noopResult(999),
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().applied).toBe(false);
    expect(second.json().execution_id).toBe(first.json().execution_id);

    const row = await readExecution(t.eventId);
    expect(row.result, 'the duplicate must not overwrite the result').toEqual({
      ok: true,
      received_chars: 38,
    });
    expect(await countAudit(t.ticketId), 'and must not write a second audit row').toBe(1);
  });

  it('input on an already-terminal execution short-circuits to already_applied', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);
    await postResult(t.eventId, { ...c, result: noopResult() });

    const res = await postInput(t.eventId, claims(t));
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('already_applied');
    expect(body.execution_status).toBe('succeeded');
    // The duplicate arm must carry no ticket data at all.
    expect(body.ticket).toBeUndefined();
    expect(body.taxonomy).toBeUndefined();
  });

  it('a retry while still running gets input again — work resumes, not blocked', async () => {
    // This is the worker-crashed-after-Python-before-Core case: the row sits
    // at 'running', so the next attempt must be allowed to redo the work.
    const t = await createTicket(PRODUCT_A);
    await postInput(t.eventId, claims(t, { attempt: 1 }));

    const retry = await postInput(t.eventId, claims(t, { attempt: 2 }));
    expect(retry.json().status).toBe('ready');

    const row = await readExecution(t.eventId);
    expect(row.status).toBe('running');
    expect(row.attempt, 'the retry must be visible in the history').toBe(2);
  });

  it('holds exactly one row per (event_id, feature) however many attempts run', async () => {
    const t = await createTicket(PRODUCT_A);
    for (const attempt of [1, 2, 3]) await postInput(t.eventId, claims(t, { attempt }));

    const n = await withSystemScope('test', async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ai_execution WHERE event_id = $1`,
        [t.eventId],
      );
      return Number(rows[0]!.n);
    });
    expect(n).toBe(1);
  });

  it('the unique constraint is what enforces it, at the database', async () => {
    const t = await createTicket(PRODUCT_A);
    await postInput(t.eventId, claims(t));

    // Bypass the service entirely and insert a second row by hand. The
    // constraint — not application logic — must be what refuses.
    await expect(
      withScope({ productScope: [PRODUCT_A], role: 'none', requestId: 'test' }, (tx) =>
        tx.query(
          `INSERT INTO ai_execution (id, product_id, ticket_id, feature, event_id, status)
           VALUES ($1,$2,$3,'noop',$4,'running')`,
          [newId('aix'), PRODUCT_A, t.ticketId, t.eventId],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('auditability', () => {
  it('the execution appears in the ticket history with no change to that endpoint', async () => {
    const t = await createTicket(PRODUCT_A);
    const c = claims(t);
    await postInput(t.eventId, c);
    await postResult(t.eventId, { ...c, result: noopResult() });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/tickets/${t.ticketId}/history`,
      headers: productHeaders(PRODUCT_A),
    });
    expect(res.statusCode).toBe(200);

    const entry = res.json().data.find((e: { type: string }) => e.type.startsWith('ai.'));
    expect(entry, 'AI executions must be visible in the audit trail').toBeTruthy();
    expect(entry.type).toBe('ai.execution_succeeded');
    expect(entry.actor.type).toBe('system');
    expect(entry.detail.feature).toBe('noop');
    expect(entry.detail.model).toBe('stub-noop');
  });

  it('the audit record carries model metadata but no ticket text', async () => {
    const description = 'A very distinctive description string for leak detection.';
    const t = await createTicket(PRODUCT_A, description);
    const c = claims(t);
    await postInput(t.eventId, c);
    await postResult(t.eventId, { ...c, result: noopResult() });

    const after = await withSystemScope('test', async (tx) => {
      const { rows } = await tx.query<{ after: unknown }>(
        `SELECT after FROM audit_event WHERE entity_id = $1 AND action LIKE 'ai.%'`,
        [t.ticketId],
      );
      return JSON.stringify(rows[0]!.after);
    });

    expect(after).not.toContain(description);
    expect(after).toContain('stub-noop');
  });
});

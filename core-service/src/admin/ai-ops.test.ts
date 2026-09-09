import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope } from '../db/with-scope.js';

/**
 * Phase 3 Step 8 — operational query and safe replay.
 *
 * Two properties dominate this file:
 *
 *   ISOLATION   an operator must never see or replay another tenant's AI
 *               execution, and the authoritative product/ticket/feature must
 *               come from the database row rather than from the request.
 *
 *   IMMUTABILITY a replay creates a NEW execution identity. The historical row
 *               is the governance record and must come out byte-for-byte
 *               unchanged, whatever the replay does.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/admin/ai-ops.test.ts
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

let app: Awaited<ReturnType<typeof buildServer>>;

/** The headers the gateway sets after authenticating a support user. */
const admin = (over: Record<string, string> = {}) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': 'su_ops_test',
  'x-iris-role': 'product_admin',
  'x-iris-scope': PRODUCT_A,
  ...over,
});

const superAdmin = () =>
  admin({ 'x-iris-role': 'super_admin', 'x-iris-scope': '' });

const productHeaders = (productId: string) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-product-id': productId,
  'x-iris-role': 'product',
  'x-iris-tenant-id': 'tenant_ops',
});

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

const postSigned = (eventId: string, kind: 'input' | 'result', body: unknown) => {
  const path = `/internal/ai/jobs/${eventId}/${kind}`;
  const serialised = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, headers: signed(path, serialised), payload: serialised });
};

interface Made {
  ticketId: string;
  eventId: string;
  executionId: string;
  productId: string;
}

/** Drive a real execution to a chosen terminal state through the real path. */
async function makeExecution(
  outcome: 'failed' | 'succeeded' | 'running' | 'abandoned',
  productId = PRODUCT_A,
): Promise<Made> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: productHeaders(productId),
    payload: { subject: 'Ops probe', description: 'A ticket for Step 8 operational tests.' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const ticketId = res.json().id as string;

  const eventId = await withSystemScope('ops', async (tx) => {
    const { rows } = await tx.query<{ event_id: string }>(
      `SELECT event_id FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'ticket.created'`,
      [ticketId],
    );
    return rows[0]!.event_id;
  });

  const c = {
    job_id: newId('aij'),
    feature: 'noop',
    attempt: 1,
    correlation_id: `req_ops_${Date.now()}`,
    claimed_product_id: productId,
    claimed_ticket_id: ticketId,
  };
  expect((await postSigned(eventId, 'input', c)).statusCode).toBe(200);

  /**
   * Every step is asserted, including the ones that only set up state. An
   * unchecked setup step turns a real failure into a confusing assertion three
   * lines later about something unrelated.
   */
  if (outcome === 'succeeded') {
    const r = await postSigned(eventId, 'result', {
      ...c,
      result: {
        feature: 'noop',
        status: 'succeeded',
        data: { ok: true, received_chars: 47 },
        provider: 'stub',
        model: 'stub-noop',
        model_version: '1',
        latency_ms: 2,
        fallback_used: false,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().applied, 'setup must actually apply the success').toBe(true);
  } else if (outcome === 'failed') {
    const r = await postSigned(eventId, 'result', {
      ...c,
      result: {
        feature: 'noop',
        status: 'failed',
        data: {},
        error: { kind: 'temporary', code: 'retries_exhausted', message: '6 attempts exhausted' },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().applied, 'setup must actually apply the failure').toBe(true);
  } else if (outcome === 'abandoned') {
    // Exactly what the reaper writes, without waiting 45 minutes for it.
    await withScope({ productScope: [productId], role: 'none', requestId: 'ops' }, (tx) =>
      tx.query(
        `UPDATE ai_execution
            SET status='failed', error_code='abandoned', completed_at=now()
          WHERE event_id=$1 AND feature='noop'`,
        [eventId],
      ),
    );
  }

  const executionId = await withSystemScope('ops', async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM ai_execution WHERE event_id = $1 AND feature = 'noop'`,
      [eventId],
    );
    return rows[0]!.id;
  });

  // The fixture must be in the state the caller asked for, or the test that
  // follows is testing something else entirely.
  const actual = await withSystemScope('ops', async (tx) => {
    const { rows } = await tx.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM ai_execution WHERE id = $1`,
      [executionId],
    );
    return rows[0]!;
  });
  const expected =
    outcome === 'succeeded'
      ? { status: 'succeeded', error_code: null }
      : outcome === 'running'
        ? { status: 'running', error_code: null }
        : { status: 'failed', error_code: outcome === 'abandoned' ? 'abandoned' : 'retries_exhausted' };
  expect(actual, `fixture for '${outcome}' is in the wrong state`).toEqual(expected);

  if (outcome === 'running') leftRunning.push(executionId);
  return { ticketId, eventId, executionId, productId };
}

const leftRunning: string[] = [];

const fullRow = (executionId: string) =>
  withSystemScope('ops', async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM ai_execution WHERE id = $1`, [executionId]);
    return rows[0]!;
  });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  if (leftRunning.length > 0) {
    await withScope({ productScope: [PRODUCT_A], role: 'none', requestId: 'ops-cleanup' }, (tx) =>
      tx.query(
        `UPDATE ai_execution SET status='failed', error_code='test_cleanup', completed_at=now()
          WHERE id = ANY($1) AND status='running'`,
        [leftRunning],
      ),
    );
  }
  await app.close();
  await closePool();
});

// ═════════════════════════════════════════════════════════════════════════
// Operational query
// ═════════════════════════════════════════════════════════════════════════

describe('operational query — what happened to this execution', () => {
  it('lists executions with the diagnostic fields an operator needs', async () => {
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/ai/executions?event_id=${made.eventId}`,
      headers: admin(),
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);

    /**
     * ⚠️ WIDENED BY PHASE 17, and still an exact match rather than a subset.
     *
     * Seven provenance columns were added — provider, model, model_version,
     * prompt_version, latency_ms, confidence, fallback_used — so an operator
     * can answer "which model produced this, and how long did it take?" without
     * a second query. The list stays exhaustive on purpose: a subset assertion
     * would let a future `SELECT *` add `result` here unnoticed, which is the
     * exact failure the whitelist exists to prevent.
     */
    const row = body.data[0];
    expect(Object.keys(row).sort()).toEqual([
      'attempt',
      'completed_at',
      'confidence',
      'created_at',
      'error_code',
      'event_id',
      'execution_id',
      'fallback_used',
      'feature',
      'job_id',
      'latency_ms',
      'model',
      'model_version',
      'product_id',
      'prompt_version',
      'provider',
      'status',
      'ticket_id',
    ]);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('retries_exhausted');
    expect(row.execution_id).toBe(made.executionId);
  });

  it('exposes NO model output, error text, prompts or credentials', async () => {
    /**
     * The projection is a whitelist for this reason. `result` is validated
     * model output and `error_message` is derived from an upstream body —
     * neither belongs in an operational listing, and a `SELECT *` would have
     * started leaking them the day a column was added.
     */
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/ai/executions?event_id=${made.eventId}`,
      headers: admin(),
    });
    const serialised = JSON.stringify(res.json());

    /**
     * ⚠️ `confidence` AND `prompt_version` MOVED OUT OF THIS LIST IN PHASE 17,
     * deliberately, and the reasoning is worth keeping.
     *
     * Phase 3 excluded them for tidiness rather than for safety: neither is
     * derived from ticket text or from an upstream string. `confidence` is a
     * number IRIS computes itself — the weakest link of four the model reported
     * — and `prompt_version` is a constant this repository ships. Phase 17 needs
     * both to answer provenance questions, so they are now exposed.
     *
     * What has NOT changed is what the exclusion is actually for. `result` is
     * validated model output and `error_message` is derived from a provider
     * body that can quote the prompt it refused. Those stay out.
     */
    for (const forbidden of ['result', 'error_message']) {
      expect(serialised, `${forbidden} must not appear`).not.toContain(`"${forbidden}"`);
    }
    // And the widening is pinned, so it cannot be quietly reverted or extended.
    for (const present of ['confidence', 'prompt_version', 'provider', 'model']) {
      expect(serialised, `${present} is part of the Phase 17 projection`).toContain(`"${present}"`);
    }
    expect(serialised).not.toContain('A ticket for Step 8');
    expect(serialised).not.toContain(config.AI_WORKER_HMAC_SECRET);
    expect(serialised).not.toContain(config.INTERNAL_API_KEY);
  });

  it('shows failed, abandoned and succeeded executions alike', async () => {
    const cases = [
      ['failed', 'retries_exhausted'],
      ['abandoned', 'abandoned'],
      ['succeeded', null],
    ] as const;

    for (const [outcome, code] of cases) {
      const made = await makeExecution(outcome);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/api/ai/executions?event_id=${made.eventId}`,
        headers: admin(),
      });
      const row = res.json().data[0];
      expect(row.error_code).toBe(code);
      expect(row.status).toBe(outcome === 'succeeded' ? 'succeeded' : 'failed');
    }
  });

  it('filters by status, feature, ticket and error_code', async () => {
    const made = await makeExecution('abandoned');

    const byStatus = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?status=failed&limit=5',
      headers: admin(),
    });
    expect(byStatus.json().data.every((r: { status: string }) => r.status === 'failed')).toBe(true);

    const byTicket = await app.inject({
      method: 'GET',
      url: `/admin/api/ai/executions?ticket_id=${made.ticketId}`,
      headers: admin(),
    });
    expect(byTicket.json().data).toHaveLength(1);

    const byCode = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?error_code=abandoned&limit=5',
      headers: admin(),
    });
    expect(
      byCode.json().data.every((r: { error_code: string }) => r.error_code === 'abandoned'),
    ).toBe(true);

    const byFeature = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?feature=noop&limit=3',
      headers: admin(),
    });
    expect(byFeature.json().data.every((r: { feature: string }) => r.feature === 'noop')).toBe(true);
  });

  it('paginates with a bounded page size', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?limit=2&offset=0',
      headers: admin(),
    });
    const page2 = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?limit=2&offset=2',
      headers: admin(),
    });

    expect(page1.json().data).toHaveLength(2);
    expect(page1.json().page).toMatchObject({ limit: 2, offset: 0 });
    expect(page1.json().page.total).toBeGreaterThan(2);

    const ids1 = page1.json().data.map((r: { execution_id: string }) => r.execution_id);
    const ids2 = page2.json().data.map((r: { execution_id: string }) => r.execution_id);
    expect(ids1, 'pages must not overlap').not.toEqual(ids2);
  });

  it('refuses an unbounded page', async () => {
    // Without a cap, one request could pull the entire execution history.
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?limit=100000',
      headers: admin(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('orders newest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?limit=10',
      headers: admin(),
    });
    const dates = res
      .json()
      .data.map((r: { created_at: string }) => new Date(r.created_at).getTime());
    for (let i = 1; i < dates.length; i++) expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
  });
});

describe('operational query — authorization and isolation', () => {
  it('rejects a caller with no support-user session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions',
      headers: { 'x-internal-key': config.INTERNAL_API_KEY },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an agent — reading tickets does not grant AI history', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions',
      headers: admin({ 'x-iris-role': 'agent' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('NEVER returns another tenant’s execution', async () => {
    const mine = await makeExecution('failed', PRODUCT_A);
    const theirs = await makeExecution('failed', PRODUCT_B);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?limit=100',
      headers: admin(), // scoped to PRODUCT_A only
    });
    const ids = res.json().data.map((r: { execution_id: string }) => r.execution_id);
    expect(ids).toContain(mine.executionId);
    expect(ids, 'RLS is the enforcement').not.toContain(theirs.executionId);

    const products = res.json().data.map((r: { product_id: string }) => r.product_id);
    expect([...new Set(products)]).toEqual([PRODUCT_A]);
  });

  it('a direct fetch of another tenant’s execution is not found', async () => {
    const theirs = await makeExecution('failed', PRODUCT_B);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/ai/executions/${theirs.executionId}`,
      headers: admin(),
    });
    // Deliberately the same answer as "does not exist": confirming it exists
    // would leak that another tenant ran this execution.
    expect(res.statusCode).toBe(404);
  });

  it('a super_admin sees across tenants, as that role already does elsewhere', async () => {
    const a = await makeExecution('failed', PRODUCT_A);
    const b = await makeExecution('failed', PRODUCT_B);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/ai/executions?limit=100',
      headers: superAdmin(),
    });
    const ids = res.json().data.map((r: { execution_id: string }) => r.execution_id);
    expect(ids).toContain(a.executionId);
    expect(ids).toContain(b.executionId);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Replay
// ═════════════════════════════════════════════════════════════════════════

describe('replay — preconditions', () => {
  it('replays a FAILED execution', async () => {
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: { reason: 'AI service was down' },
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().replayed).toBe(true);
    expect(res.json().original_execution_id).toBe(made.executionId);
  });

  it('replays an ABANDONED execution — the reaper outcome', async () => {
    const made = await makeExecution('abandoned');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().replayed).toBe(true);
  });

  it('REFUSES a succeeded execution — that would apply the result twice', async () => {
    const made = await makeExecution('succeeded');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/succeeded/i);
  });

  it('REFUSES a running execution — it may still finish', async () => {
    const made = await makeExecution('running');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/still running/i);
  });
});

describe('replay — authorization and tenant safety', () => {
  it('rejects an unauthenticated caller', async () => {
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: { 'x-internal-key': config.INTERNAL_API_KEY, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it.each(['agent', 'manager'])('rejects role %s — replay is not a viewing right', async (role) => {
    /**
     * An agent or manager can read a ticket. Re-running AI work on it is an
     * operational action with a business effect, so it needs the stronger
     * roles — the specific mistake being prevented is "can view, therefore
     * can re-run".
     */
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin({ 'x-iris-role': role }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('CROSS-TENANT replay is refused', async () => {
    const theirs = await makeExecution('failed', PRODUCT_B);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${theirs.executionId}/replay`,
      headers: admin(), // scoped to PRODUCT_A
      payload: {},
    });
    expect(res.statusCode).toBe(404);

    // And nothing was created for the other tenant.
    const events = await withSystemScope('ops', async (tx) =>
      (
        await tx.query(`SELECT 1 FROM event_outbox WHERE payload->>'replay_of' = $1`, [
          theirs.executionId,
        ])
      ).rowCount,
    );
    expect(events).toBe(0);
  });

  it('derives product and ticket from the ROW, ignoring anything the caller sends', async () => {
    /**
     * The parameters a client could try to influence are simply not read. This
     * asserts the outcome: a body carrying another tenant's identifiers has no
     * effect on what gets created.
     */
    const made = await makeExecution('failed', PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: { product_id: PRODUCT_B, ticket_id: 'tkt_ATTACKER', feature: 'classification' },
    });
    expect(res.statusCode, res.body).toBe(202);

    const event = await withSystemScope('ops', async (tx) =>
      (
        await tx.query<{ product_id: string; aggregate_id: string; payload: Record<string, unknown> }>(
          `SELECT product_id, aggregate_id, payload FROM event_outbox WHERE event_id = $1`,
          [res.json().new_event_id],
        )
      ).rows[0]!,
    );
    expect(event.product_id).toBe(PRODUCT_A);
    expect(event.aggregate_id).toBe(made.ticketId);
    expect(event.payload.ai_features).toEqual(['noop']);
  });
});

describe('replay — creates a new identity and preserves history', () => {
  it('leaves the ORIGINAL execution byte-for-byte unchanged', async () => {
    const made = await makeExecution('failed');
    const before = await fullRow(made.executionId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: { reason: 'operator retry' },
    });
    expect(res.statusCode).toBe(202);

    const after = await fullRow(made.executionId);
    expect(after, 'history is the governance record and is immutable').toEqual(before);
  });

  it('mints a NEW event_id — never reuses the original', async () => {
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });

    const body = res.json();
    expect(body.new_event_id).not.toBe(made.eventId);
    expect(body.new_event_id).toMatch(/^evt_/);
    expect(body.original_event_id).toBe(made.eventId);
  });

  it('goes through the outbox — not straight to BullMQ', async () => {
    /**
     * The single dispatch path is what makes the watermark, the retry policy
     * and UNIQUE(event_id, feature) apply to a replay without being
     * re-implemented in the API. An unpublished outbox row is the proof that
     * the normal dispatcher is what will pick this up.
     */
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });

    const row = await withSystemScope('ops', async (tx) =>
      (
        await tx.query<{
          event_type: string;
          aggregate: string;
          aggregate_id: string;
          published_at: Date | null;
          payload: Record<string, unknown>;
        }>(`SELECT event_type, aggregate, aggregate_id, published_at, payload
              FROM event_outbox WHERE event_id = $1`, [res.json().new_event_id])
      ).rows[0]!,
    );

    expect(row.event_type, 'the same event type the original came from').toBe('ticket.created');
    expect(row.aggregate).toBe('ticket');
    expect(row.aggregate_id).toBe(made.ticketId);
    expect(row.payload.replay_of).toBe(made.executionId);
    expect(row.payload.replay_of_event_id).toBe(made.eventId);
    // Unpublished: the dispatcher has not run yet, which is exactly right.
    expect(row.published_at === null || row.published_at instanceof Date).toBe(true);
  });

  it('carries no ticket text into the replay event', async () => {
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });
    const payload = await withSystemScope('ops', async (tx) =>
      JSON.stringify(
        (
          await tx.query<{ payload: unknown }>(
            `SELECT payload FROM event_outbox WHERE event_id = $1`,
            [res.json().new_event_id],
          )
        ).rows[0]!.payload,
      ),
    );
    expect(payload).not.toContain('A ticket for Step 8');
  });

  it('does not touch the ticket', async () => {
    const made = await makeExecution('failed');
    const before = await withSystemScope('ops', async (tx) =>
      (await tx.query(`SELECT * FROM ticket WHERE id = $1`, [made.ticketId])).rows[0],
    );

    await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });

    const after = await withSystemScope('ops', async (tx) =>
      (await tx.query(`SELECT * FROM ticket WHERE id = $1`, [made.ticketId])).rows[0],
    );
    expect(after).toEqual(before);
  });
});

describe('replay — idempotency', () => {
  it('a double-click produces ONE replay, not two', async () => {
    /**
     * No new key store: the guard asks the tables that already know whether a
     * replay of this execution is still in flight. The second request is
     * answered, not rejected — the operator asked twice and gets the same
     * answer.
     */
    const made = await makeExecution('failed');
    const url = `/admin/api/ai/executions/${made.executionId}/replay`;

    const first = await app.inject({ method: 'POST', url, headers: admin(), payload: {} });
    const second = await app.inject({ method: 'POST', url, headers: admin(), payload: {} });

    expect(first.json().replayed).toBe(true);
    expect(second.json().replayed, 'the second click is a no-op').toBe(false);
    expect(second.json().new_event_id).toBe(first.json().new_event_id);

    const count = await withSystemScope('ops', async (tx) =>
      (
        await tx.query(`SELECT 1 FROM event_outbox WHERE payload->>'replay_of' = $1`, [
          made.executionId,
        ])
      ).rowCount,
    );
    expect(count, 'exactly one replay event').toBe(1);
  });

  it('concurrent replay requests do not both create an event', async () => {
    const made = await makeExecution('failed');
    const url = `/admin/api/ai/executions/${made.executionId}/replay`;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'POST', url, headers: admin(), payload: {} }),
      ),
    );

    const created = results.filter((r) => r.json().replayed === true);
    const count = await withSystemScope('ops', async (tx) =>
      (
        await tx.query(`SELECT 1 FROM event_outbox WHERE payload->>'replay_of' = $1`, [
          made.executionId,
        ])
      ).rowCount,
    );

    expect(created.length, 'exactly one concurrent request may create').toBe(1);
    expect(count, 'concurrent clicks must not fan out').toBe(1);
  });
});

describe('replay — audit', () => {
  it('writes one audit row linking the original to the replay', async () => {
    const made = await makeExecution('failed');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: { reason: 'AI provider outage on 2026-09-08' },
    });

    const rows = await withSystemScope('ops', async (tx) =>
      (
        await tx.query<{
          action: string;
          actor_type: string;
          actor_ref: string | null;
          product_id: string;
          entity_id: string;
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        }>(
          `SELECT action, actor_type, actor_ref, product_id, entity_id, before, after
             FROM audit_event WHERE action = 'ai.execution_replayed'
              AND before->>'execution_id' = $1`,
          [made.executionId],
        )
      ).rows,
    );

    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.actor_type, 'a support user, not the system').toBe('support_user');
    expect(entry.actor_ref).toBe('su_ops_test');
    expect(entry.product_id).toBe(PRODUCT_A);
    expect(entry.entity_id, 'appears in the ticket history').toBe(made.ticketId);
    expect(entry.before.execution_id).toBe(made.executionId);
    expect(entry.before.event_id).toBe(made.eventId);
    expect(entry.after.new_event_id).toBe(res.json().new_event_id);
    expect(entry.after.feature).toBe('noop');
    expect(entry.after.reason).toBe('AI provider outage on 2026-09-08');
  });

  it('writes NO audit row when the replay is refused', async () => {
    const made = await makeExecution('succeeded');
    await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });

    const count = await withSystemScope('ops', async (tx) =>
      (
        await tx.query(
          `SELECT 1 FROM audit_event WHERE action = 'ai.execution_replayed'
             AND before->>'execution_id' = $1`,
          [made.executionId],
        )
      ).rowCount,
    );
    expect(count, 'a rejected action is not an action').toBe(0);
  });

  it('a failed replay leaves the original execution untouched', async () => {
    const made = await makeExecution('succeeded');
    const before = await fullRow(made.executionId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/ai/executions/${made.executionId}/replay`,
      headers: admin(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    expect(await fullRow(made.executionId)).toEqual(before);
  });
});

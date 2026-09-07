import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope } from '../db/with-scope.js';

/**
 * The negative tests for the AI pipeline. These are the contract, and they do
 * not get skipped — core-service/SKILLS.md section 9.
 *
 * The important one is "RLS refuses even when verification is bypassed". It
 * proves isolation is enforced by the DATABASE rather than by the claim check
 * happening to be correct today. Everything else is defence in depth.
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

async function createTicket(productId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: internal({
      'x-iris-product-id': productId,
      'x-iris-role': 'product',
      'x-iris-tenant-id': 'tenant_sec_test',
    }),
    payload: { subject: 'secret subject', description: 'confidential ticket body' },
  });
  expect(res.statusCode).toBe(201);
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
const postSigned = (url: string, body: unknown) => {
  const serialised = JSON.stringify(body);
  return app.inject({ method: 'POST', url, headers: signed(url, serialised), payload: serialised });
};

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

// ─────────────────────────────────────────────────────────────────────────

describe('the internal namespace is authenticated', () => {
  it('rejects a request with no internal key', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/input`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('rejects a request with the wrong internal key', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/input`,
      headers: { 'x-internal-key': 'not-the-key', 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('checks the key before the body, so an anonymous caller learns nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${newId('evt')}/input`,
      headers: { 'content-type': 'application/json' },
      payload: { total: 'garbage' },
    });
    // 401, not 400 and not 404 — no information about the event either way.
    expect(res.statusCode).toBe(401);
  });

  it('guards the result endpoint identically', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/result`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('claim tampering cannot cross a tenant boundary', () => {
  it('a product B claim on a product A event is refused', async () => {
    const a = await createTicket(PRODUCT_A);
    const res = await postSigned(`/internal/ai/jobs/${a.eventId}/input`, {
        job_id: newId('aij'),
        feature: 'noop',
        attempt: 1,
        correlation_id: 'req_attack',
        claimed_product_id: PRODUCT_B,
        claimed_ticket_id: a.ticketId,
      });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('confidential ticket body');
  });

  it("a product B event id cannot be used to read a product A ticket", async () => {
    const a = await createTicket(PRODUCT_A);
    const b = await createTicket(PRODUCT_B);

    // Product B's event, but claiming product A's ticket. The event resolves
    // to product B; the ticket claim does not match, so it is refused.
    const res = await postSigned(`/internal/ai/jobs/${b.eventId}/input`, {
        job_id: newId('aij'),
        feature: 'noop',
        attempt: 1,
        correlation_id: 'req_attack',
        claimed_product_id: PRODUCT_B,
        claimed_ticket_id: a.ticketId,
      });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(a.ticketId);
  });

  it('a tampered result cannot write an execution against another product', async () => {
    const a = await createTicket(PRODUCT_A);
    const res = await postSigned(`/internal/ai/jobs/${a.eventId}/result`, {
        job_id: newId('aij'),
        feature: 'noop',
        attempt: 1,
        correlation_id: 'req_attack',
        claimed_product_id: PRODUCT_B,
        claimed_ticket_id: a.ticketId,
        result: { feature: 'noop', status: 'succeeded', data: { ok: true, received_chars: 1 } },
      });
    expect(res.statusCode).toBe(400);

    const row = await withSystemScope('test', async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM ai_execution WHERE event_id = $1`, [
        a.eventId,
      ]);
      return rows[0] ?? null;
    });
    expect(row).toBeNull();
  });
});

describe('RLS is the enforcement, not the claim check', () => {
  /**
   * THE test.
   *
   * Verification is bypassed entirely here: the scope is built by hand for
   * product B and pointed straight at product A's ticket, exactly as a
   * compromised worker or a future code defect would. The result must be ZERO
   * ROWS — never another product's rows.
   *
   * This proves the isolation claim is enforced by the database rather than by
   * our WHERE clauses happening to be right today.
   */
  it('a product B scope reading a product A ticket returns zero rows', async () => {
    const a = await createTicket(PRODUCT_A);

    const rows = await withScope(
      { productScope: [PRODUCT_B], role: 'none', requestId: 'rls-test' },
      async (tx) => {
        const { rows } = await tx.query(
          `SELECT id, subject, description FROM ticket WHERE id = $1`,
          [a.ticketId],
        );
        return rows;
      },
    );

    expect(rows).toHaveLength(0);
  });

  it('the same read under the correct scope succeeds — proving the query is right', async () => {
    const a = await createTicket(PRODUCT_A);
    const rows = await withScope(
      { productScope: [PRODUCT_A], role: 'none', requestId: 'rls-test' },
      async (tx) => {
        const { rows } = await tx.query(`SELECT id FROM ticket WHERE id = $1`, [a.ticketId]);
        return rows;
      },
    );
    // Without this, the previous test could pass because the query is broken.
    expect(rows).toHaveLength(1);
  });

  it('an ai_execution row is invisible to another product', async () => {
    const a = await createTicket(PRODUCT_A);
    await postSigned(`/internal/ai/jobs/${a.eventId}/input`, {
        job_id: newId('aij'),
        feature: 'noop',
        attempt: 1,
        correlation_id: 'req_1',
        claimed_product_id: PRODUCT_A,
        claimed_ticket_id: a.ticketId,
      });

    const visible = await withScope(
      { productScope: [PRODUCT_B], role: 'none', requestId: 'rls-test' },
      async (tx) => {
        const { rows } = await tx.query(`SELECT id FROM ai_execution WHERE event_id = $1`, [
          a.eventId,
        ]);
        return rows;
      },
    );
    expect(visible).toHaveLength(0);
  });

  it('an ai_execution row cannot be written into another product scope', async () => {
    const a = await createTicket(PRODUCT_A);
    // WITH CHECK on the policy must refuse a row whose product_id is outside
    // the current scope, even though the INSERT itself is well-formed.
    await expect(
      withScope({ productScope: [PRODUCT_B], role: 'none', requestId: 'rls-test' }, (tx) =>
        tx.query(
          `INSERT INTO ai_execution (id, product_id, ticket_id, feature, event_id, status)
           VALUES ($1,$2,$3,'noop',$4,'running')`,
          [newId('aix'), PRODUCT_A, a.ticketId, a.eventId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('execution history is not erasable by the application', () => {
  it('iris_app has no DELETE privilege on ai_execution', async () => {
    const a = await createTicket(PRODUCT_A);
    await postSigned(`/internal/ai/jobs/${a.eventId}/input`, {
        job_id: newId('aij'),
        feature: 'noop',
        attempt: 1,
        correlation_id: 'req_1',
        claimed_product_id: PRODUCT_A,
        claimed_ticket_id: a.ticketId,
      });

    // Same reasoning that makes audit_event append-only: a compromised
    // application must not be able to rewrite the governance record.
    await expect(
      withScope({ productScope: [PRODUCT_A], role: 'none', requestId: 'test' }, (tx) =>
        tx.query(`DELETE FROM ai_execution WHERE event_id = $1`, [a.eventId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('the gateway does not expose the internal namespace', () => {
  it('gateway proxies only /v1/* and /admin/api/*', async () => {
    // Structural rather than behavioural: this asserts against the gateway
    // source, so a new route that widened the public surface would fail here
    // even though core-service itself is unchanged.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../../gateway/src/server.ts', import.meta.url)),
      'utf8',
    );

    const proxied = [...src.matchAll(/app\.all\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(proxied.sort()).toEqual(['/admin/api/*', '/v1/*']);
    expect(proxied.some((p) => p!.includes('internal'))).toBe(false);
    expect(src).not.toContain('/internal/ai');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withSystemScope } from '../db/with-scope.js';

/**
 * PHASE 2 SECURITY REGRESSION TESTS.
 *
 * These were written BEFORE the fix and two of them failed, which is the point:
 * they reproduce a real, verified privilege escalation rather than describing a
 * hypothetical one.
 *
 * The Phase 1 defect: `INTERNAL_API_KEY` is accepted by core-service on EVERY
 * route, not just /internal/*, and resolveCaller/resolveAdminCaller trust
 * `x-iris-product-id`, `x-iris-role` and `x-iris-support-user-id` as plain
 * headers with no lookup. Phase 1 handed that key to the worker — the process
 * most exposed to untrusted input, since it parses AI-service responses. A
 * compromised worker could therefore read any tenant's tickets and reach the
 * admin API as super_admin.
 *
 * Phase 2 fixes it by SEPARATION, not by signatures alone: the worker holds a
 * credential that is only valid on /internal/ai/*, and no credential that works
 * anywhere else.
 *
 * Every test here is an acceptance criterion. Do not weaken one to make it pass.
 */

const PRODUCT_A = 'prod_carbon';

let app: Awaited<ReturnType<typeof buildServer>>;

/** The worker's credential after Phase 2 — an HMAC signature, nothing more. */
function workerHeaders(
  method: string,
  path: string,
  body: string,
  secret = config.AI_WORKER_HMAC_SECRET,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  return {
    'content-type': 'application/json',
    'x-iris-service-id': 'worker',
    'x-iris-timestamp': String(timestamp),
    'x-iris-nonce': nonce,
    'x-iris-signature': requestSignatureHeader(secret, {
      method,
      path,
      timestamp,
      nonce,
      body,
    }),
  };
}

async function createTicket(productId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: {
      'x-internal-key': config.INTERNAL_API_KEY,
      'content-type': 'application/json',
      'x-iris-product-id': productId,
      'x-iris-role': 'product',
      'x-iris-tenant-id': 'tenant_phase2',
    },
    payload: { subject: 'phase2', description: 'confidential phase2 body' },
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
  return { ticketId, eventId };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. The worker's credential must not reach the public or admin surface.
// ─────────────────────────────────────────────────────────────────────────

describe('the worker credential is confined to /internal/ai/*', () => {
  it('cannot read another tenant via /v1/tickets with a forged product header', async () => {
    // This is the exact escalation demonstrated live during Phase 2 analysis:
    // GET /v1/tickets with x-iris-product-id: prod_ifile returned that
    // tenant's tickets. The worker no longer holds any credential /v1/* accepts.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tickets?limit=2',
      headers: {
        ...workerHeaders('GET', '/v1/tickets?limit=2', ''),
        'x-iris-product-id': 'prod_ifile',
        'x-iris-role': 'product',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('cannot reach the admin API by forging a super_admin session', async () => {
    // Previously: internal key + x-iris-support-user-id + x-iris-role
    // returned all four tenants, because resolveAdminCaller trusts the headers.
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/tenants',
      headers: {
        ...workerHeaders('GET', '/admin/api/tenants', ''),
        'x-iris-support-user-id': 'su_forged',
        'x-iris-role': 'super_admin',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('cannot create a ticket for an arbitrary product', async () => {
    const body = JSON.stringify({ subject: 'forged', description: 'forged' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tickets',
      headers: {
        ...workerHeaders('POST', '/v1/tickets', body),
        'x-iris-product-id': 'prod_esg',
        'x-iris-role': 'product',
        'x-iris-tenant-id': 'forged',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a signature valid for an internal path is not valid on /v1/*', async () => {
    // Method and path are inside the canonical string, so a captured internal
    // signature cannot be lifted onto a public route — and /v1/* does not
    // accept HMAC at all.
    const t = await createTicket(PRODUCT_A);
    const body = JSON.stringify({ job_id: 'x' });
    const internalPath = `/internal/ai/jobs/${t.eventId}/input`;
    const stolen = workerHeaders('POST', internalPath, body);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tickets',
      headers: { ...stolen, 'x-iris-product-id': PRODUCT_A, 'x-iris-role': 'product' },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. /internal/* must require HMAC — the shared key is no longer sufficient.
// ─────────────────────────────────────────────────────────────────────────

describe('/internal/* requires a service signature', () => {
  it('rejects a request carrying INTERNAL_API_KEY but no signature', async () => {
    // FAILED BEFORE PHASE 2 (returned 200). This is the test that proves the
    // shared key no longer opens the internal surface.
    const t = await createTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/input`,
      headers: {
        'x-internal-key': config.INTERNAL_API_KEY,
        'content-type': 'application/json',
      },
      payload: {
        job_id: newId('aij'),
        feature: 'noop',
        attempt: 1,
        correlation_id: 'req_x',
        claimed_product_id: PRODUCT_A,
        claimed_ticket_id: t.ticketId,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a completely unsigned request', async () => {
    // Guards the server.ts hook change: excluding /internal/* from the global
    // key check must not leave the prefix open.
    const t = await createTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/input`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unsigned request to the result endpoint too', async () => {
    const t = await createTicket(PRODUCT_A);
    const res = await app.inject({
      method: 'POST',
      url: `/internal/ai/jobs/${t.eventId}/result`,
      headers: { 'x-internal-key': config.INTERNAL_API_KEY, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly signed request and proceeds to Phase 1 authorization', async () => {
    const t = await createTicket(PRODUCT_A);
    const path = `/internal/ai/jobs/${t.eventId}/input`;
    const body = JSON.stringify({
      job_id: newId('aij'),
      feature: 'noop',
      attempt: 1,
      correlation_id: 'req_phase2',
      claimed_product_id: PRODUCT_A,
      claimed_ticket_id: t.ticketId,
    });

    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: workerHeaders('POST', path, body),
      payload: body,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Authentication is not authorization.
// ─────────────────────────────────────────────────────────────────────────

describe('a valid signature still does not authorize a tenant', () => {
  it('rejects a forged claimed_product_id even when perfectly signed', async () => {
    const t = await createTicket(PRODUCT_A);
    const path = `/internal/ai/jobs/${t.eventId}/input`;
    const body = JSON.stringify({
      job_id: newId('aij'),
      feature: 'noop',
      attempt: 1,
      correlation_id: 'req_phase2',
      claimed_product_id: 'prod_esg', // <- lie, correctly signed
      claimed_ticket_id: t.ticketId,
    });

    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: workerHeaders('POST', path, body),
      payload: body,
    });

    // 400, not 401: the CALLER is authentic, the CLAIM is not. That distinction
    // is the whole point of keeping HMAC and authorization separate.
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('confidential phase2 body');
  });

  it('rejects a forged claimed_ticket_id even when perfectly signed', async () => {
    const t = await createTicket(PRODUCT_A);
    const other = await createTicket(PRODUCT_A);
    const path = `/internal/ai/jobs/${t.eventId}/input`;
    const body = JSON.stringify({
      job_id: newId('aij'),
      feature: 'noop',
      attempt: 1,
      correlation_id: 'req_phase2',
      claimed_product_id: PRODUCT_A,
      claimed_ticket_id: other.ticketId,
    });

    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: workerHeaders('POST', path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type Tx } from '../db/with-scope.js';

/**
 * The Suggested Assignees endpoint — Phase 16.
 *
 * The route-level half of the security contract: WHO may ask, and what a caller
 * learns about a ticket they cannot see.
 *
 *   SEC-3  manager -> 200, agent -> 403
 *   SEC-4  in-scope ticket -> 200, foreign ticket -> 404 (never 403)
 *
 * ⚠️ EVERY NEGATIVE HAS ITS POSITIVE CONTROL IN THE SAME TEST. A 403 or 404
 * proves nothing on its own — the endpoint could be broken for everyone. Each
 * test first shows the authorized call succeeding against the same fixture.
 *
 *   npm run infra:up && npm run migrate && npm run seed
 *   npx vitest run core-service/src/admin/suggested-assignees.routes.test.ts
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';
const PATH = (id: string) => `/admin/api/tickets/${id}/suggested-assignees`;

let app: Awaited<ReturnType<typeof buildServer>>;

const headers = (over: Record<string, string> = {}) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'x-iris-support-user-id': 'su_p16_routes',
  'x-iris-role': 'manager',
  'x-iris-scope': PRODUCT_A,
  ...over,
});

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('p16-routes', fn);

const asProduct = <T>(productId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withScope({ productScope: [productId], role: 'none', requestId: 'p16-routes-fixture' }, fn);

const created: string[] = [];

async function makeTicket(productId: string, subject: string): Promise<string> {
  const id = `tkt_p16r_${Math.random().toString(36).slice(2, 12)}`;
  await asProduct(productId, (tx) =>
    tx.query(
      `INSERT INTO ticket (id, product_id, reference, product_tenant_id, raised_by_ref,
                           subject, description, status, category)
       VALUES ($1,$2,$3,'acme-corp','p16r-raiser',$4,'A ticket used by the route tests.','open','reports')`,
      [id, productId, `P16R-${id.slice(-6).toUpperCase()}`, subject],
    ),
  );
  created.push(id);
  return id;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  for (const id of created) {
    await sys((tx) => tx.query(`DELETE FROM ticket WHERE id = $1`, [id]));
  }
  await app.close();
  await closePool();
});

describe('⚠️ SEC-3 caller authorization', () => {
  it('a manager gets 200 and a real payload; an agent gets 403 for the SAME ticket', async () => {
    const ticket = await makeTicket(PRODUCT_A, 'Auth check');

    // POSITIVE CONTROL — the endpoint works for an authorized caller.
    const ok = await app.inject({ method: 'GET', url: PATH(ticket), headers: headers() });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(
      body.suggestions.length,
      'no suggestions returned — the 403 below would prove nothing',
    ).toBeGreaterThan(0);
    expect(body.diagnostics.algorithm_version).toBe('assignee-recommendation-v1');

    // THE PROPERTY — an agent cannot ask. They may only assign themselves, and
    // scope_visibility hides other staff from them anyway.
    const denied = await app.inject({
      method: 'GET',
      url: PATH(ticket),
      headers: headers({ 'x-iris-role': 'agent' }),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');
  });

  it('product_admin and super_admin may ask', async () => {
    const ticket = await makeTicket(PRODUCT_A, 'Roles');
    for (const role of ['product_admin', 'super_admin'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: PATH(ticket),
        headers: headers({ 'x-iris-role': role, ...(role === 'super_admin' ? { 'x-iris-scope': '' } : {}) }),
      });
      expect(res.statusCode, role).toBe(200);
      expect(res.json().suggestions.length, role).toBeGreaterThan(0);
    }
  });

  it('an unauthenticated caller gets 401', async () => {
    const ticket = await makeTicket(PRODUCT_A, 'Unauthenticated');
    const res = await app.inject({
      method: 'GET',
      url: PATH(ticket),
      headers: { 'x-internal-key': config.INTERNAL_API_KEY },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });
});

describe('⚠️ SEC-4 ticket authorization', () => {
  it('an in-scope ticket is 200; a foreign-product ticket is 404, not 403', async () => {
    const mine = await makeTicket(PRODUCT_A, 'Mine');
    const foreign = await makeTicket(PRODUCT_B, 'Not mine');

    // POSITIVE CONTROL — the same caller, the same endpoint, a visible ticket.
    const ok = await app.inject({ method: 'GET', url: PATH(mine), headers: headers() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().suggestions.length).toBeGreaterThan(0);

    /**
     * THE PROPERTY — 404, deliberately indistinguishable from a ticket that
     * does not exist. A 403 would confirm the id is real and let a caller
     * enumerate another product's tickets.
     */
    const denied = await app.inject({ method: 'GET', url: PATH(foreign), headers: headers() });
    expect(denied.statusCode).toBe(404);

    const nonexistent = await app.inject({
      method: 'GET',
      url: PATH('tkt_does_not_exist_at_all'),
      headers: headers(),
    });
    expect(nonexistent.statusCode).toBe(404);
    // Byte-identical shape: the two cases must not be distinguishable.
    expect(denied.json().error.code).toBe(nonexistent.json().error.code);
  });
});

describe('the response contract', () => {
  it('exposes only the approved fields', async () => {
    const ticket = await makeTicket(PRODUCT_A, 'Contract');
    const res = await app.inject({ method: 'GET', url: PATH(ticket), headers: headers() });
    const body = res.json();

    expect(Object.keys(body).sort()).toEqual(['caveats', 'diagnostics', 'suggestions']);
    expect(Object.keys(body.suggestions[0]).sort()).toEqual([
      'display_name',
      'evidence',
      'evidence_strength',
      'factors',
      'rank',
      'role',
      'summary',
      'support_user_id',
    ]);
    expect(Object.keys(body.suggestions[0].factors).sort()).toEqual([
      'active_tickets',
      'category_experience',
      'similar_tickets',
    ]);

    // ⚠️ No score, no confidence, no percentage anywhere in the payload.
    const raw = JSON.stringify(body);
    for (const forbidden of ['"score"', 'confidence', 'percent', 'best_agent', 'expertise']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('is a GET only — the route rejects a POST', async () => {
    const ticket = await makeTicket(PRODUCT_A, 'Read only');
    const res = await app.inject({ method: 'POST', url: PATH(ticket), headers: headers() });
    expect(res.statusCode).toBe(404);
  });
});
